// 一通电话的编排器。整条链路的大脑都在这里：
//
//   浏览器音频(24k) ─┬─→ VAD ──────→ 状态机（谁在说话、什么时候该接话、要不要打断）
//                    └─→ 降采样(16k) → 火山 ASR → 文本
//                                                   ↓
//                                            OpenAI LLM（流式）
//                                                   ↓
//                                            分句切分器
//                                                   ↓
//                                            火山 TTS（同一 session 内追加）
//                                                   ↓
//                                            PCM → 浏览器播放
//
// 四个状态：
//   IDLE      没人说话，等着
//   LISTENING 客户在说
//   THINKING  客户说完了，LLM 在生成，还没出声
//   SPEAKING  AI 在说
//
// 打断走"确认式"：VAD 一响先按住播放、停止给 TTS 喂新句子，
// 但不立刻销毁——等 ASR 真吐出字来才确认是人在说话。
// 这样咳嗽、纸响、AI 自己漏回来的声音都打不断，而真打断在 300ms 内就能停住。

import { EventEmitter } from "events";
import { VolcAsr, ASR_SAMPLE_RATE } from "./volc-asr.js";
import { VolcTts } from "./volc-tts.js";
import { LlmStream } from "./llm.js";
import { Vad } from "./vad.js";
import { Downsampler } from "./resample.js";
import { SentenceChunker } from "./chunker.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const OUT_SAMPLE_RATE = 24000;

export class CallSession extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.state = "IDLE";
    this.closed = false;

    this.asr = new VolcAsr({
      appKey: cfg.volcAppId,
      accessKey: cfg.volcToken,
      resourceId: cfg.asrResourceId,
      hotwords: cfg.hotwords,
    });
    this.tts = new VolcTts({
      appKey: cfg.volcAppId,
      accessKey: cfg.volcToken,
      resourceId: cfg.ttsResourceId,
      speaker: cfg.speaker,
      sampleRate: OUT_SAMPLE_RATE,
      speechRate: cfg.speechRate,
    });
    this.vad = new Vad({
      sampleRate: OUT_SAMPLE_RATE,
      ratio: cfg.vadRatio,
      endFrames: Math.round(cfg.vadSilenceMs / 20),
    });
    this.down = new Downsampler(OUT_SAMPLE_RATE, ASR_SAMPLE_RATE);
    this.chunker = new SentenceChunker();

    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
    this.llm = null;

    // ---- 本轮 AI 说话的记账 ----
    this.ttsSession = null; // 当前 TTS session id，用来丢弃上一轮的迟到音频
    this.sentences = []; // [{text, bytes}]，按 TTS 实际的断句来
    this.pendingText = []; // 打断待确认期间攒下的句子，误报了要接着送
    this.ttsFeedPaused = false;
    this.llmFullText = "";
    // 这一轮实际喂给 TTS 的文本。正在念的那一句还没回文本时，靠它兜底估算
    this.fedText = "";
    // 整通电话的 TTS 计费字数，结束时报给页面
    this.billedWords = 0;
    // LLM 已经吐完、该结 TTS 会话了，但打断还在待确认，先记下来延后执行
    this.ttsFinishPending = false;
    // TTS 已经念完整轮，但打断还在待确认，历史先别写——
    // 要等确认结果出来才知道该写完整版还是截断版
    this.turnEnded = false;

    // ---- 打断待确认 ----
    this.bargeTimer = null;
    this.bargePending = false;
    this.lastPlayedMs = 0;

    // ---- 轮次提交 ----
    this.commitTimer = null;
    this.greetTimer = null;

    this._wire();
  }

  // ================= 对外 =================

  async start() {
    await Promise.all([this.asr.connect(), this.tts.connect()]);
    this.emit("ready");
    if (this.cfg.autoGreet) {
      // 外呼场景 AI 先开口。给声卡留一点时间，不然开场头两个字会被吃掉
      this.greetTimer = setTimeout(
        () => this._runTurn("（电话已接通）"),
        this.cfg.greetDelayMs,
      );
    }
  }

  // 浏览器送上来的一包 24kHz PCM16
  pushAudio(int16) {
    if (this.closed) return;
    this.vad.push(int16);
    this.asr.sendAudio(this.down.process(int16));
  }

  // 线路测试用：不经过麦克风和 VAD，直接跑一轮完整的 LLM → TTS，
  // 单独量这条链路的首字延迟和供给率
  probe() {
    if (this.state === "THINKING" || this.state === "SPEAKING") return;
    this._runTurn("（线路测试）随便说两句话就行。");
  }

  // 浏览器汇报"AI 的声音实际播出去了多少毫秒"。
  // 打断时靠它算出客户到底听到了哪儿，这是历史能不能对齐的唯一依据
  reportPlayed(ms) {
    this.lastPlayedMs = ms;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.bargeTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.greetTimer);
    if (this.llm) this.llm.abort();
    this.asr.close();
    this.tts.close();
  }

  // ================= 内部接线 =================

  _wire() {
    this.vad.on("start", () => this._onSpeechStart());
    this.vad.on("end", () => this._onSpeechEnd());

    this.asr.on("partial", (text) => {
      // AI 说话期间麦克风会听到 AI 自己（走 CABLE 回环时尤其明显），
      // 这些回声也会被转写成字。不过滤的话页面上会冒出一堆"对方说"的乱码。
      // 打断待确认期间是例外——那时候出现的字恰恰是我们要等的证据
      if (this.state === "LISTENING" || this.bargePending) {
        this.emit("stt.partial", text);
      }
      // 打断待确认期间，只要客户真的说出了字，就坐实这是一次打断
      if (this.bargePending && text.trim().length >= this.cfg.bargeMinChars) {
        this._commitBarge();
      }
    });
    this.asr.on("error", (err) => this.emit("error", `ASR: ${err.message}`));
    this.asr.on("close", () => {
      if (!this.closed) this.emit("error", "ASR 连接断开");
    });

    // TTS 一轮里的事件顺序是：350(句子开始) → 352 音频×N → 351(句子结束，带文本)
    // → 364(字级时间戳) → …下一句… → 152(会话结束)。
    // 注意 350 的 text 是空的，文本只在 351 才给——照着 350 记文本会一直是空串
    this.tts.on("sentence.start", (sid) => {
      if (sid !== this.ttsSession) return;
      this.sentences.push({ text: "", bytes: 0, words: [] });
    });
    this.tts.on("audio", (sid, buf) => {
      // 上一轮被打断后迟到的音频，session 对不上就直接扔
      if (sid !== this.ttsSession) return;
      if (this.sentences.length === 0) this.sentences.push({ text: "", bytes: 0, words: [] });
      this.sentences[this.sentences.length - 1].bytes += buf.length;
      if (this.state !== "SPEAKING") this._setState("SPEAKING");
      this.emit("tts.audio", buf);
    });
    this.tts.on("sentence.end", (sid, text) => {
      if (sid !== this.ttsSession || !this.sentences.length) return;
      this.sentences[this.sentences.length - 1].text = text || "";
    });
    this.tts.on("subtitle", (sid, words) => {
      if (sid !== this.ttsSession || !this.sentences.length) return;
      this.sentences[this.sentences.length - 1].words = words;
    });
    this.tts.on("session.finished", (sid, billedWords) => {
      if (sid !== this.ttsSession) return;
      if (billedWords) this.billedWords += billedWords;
      this._finishSpeaking();
    });
    this.tts.on("error", (err) => this.emit("error", `TTS: ${err.message}`));
    this.tts.on("close", () => {
      if (!this.closed) this.emit("error", "TTS 连接断开");
    });
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    // AI 一开口就收紧 VAD，专治被自己的回声打断。走 CABLE 回环时这条是刚需
    this.vad.setGuard(s === "SPEAKING");
    this.emit("state", s);
  }

  // ================= VAD 事件 =================

  _onSpeechStart() {
    clearTimeout(this.commitTimer);
    this.commitTimer = null;

    if (this.state === "SPEAKING" || this.state === "THINKING") {
      this._beginBarge();
      return;
    }
    this._setState("LISTENING");
  }

  _onSpeechEnd() {
    if (this.bargePending) {
      // 响了一下就没了，字也没出来——是杂音，不是打断。把播放接回去
      this._cancelBarge();
      return;
    }
    if (this.state !== "LISTENING") return;

    // 别在静音那一刻就提交：ASR 的最后一段结果还在路上，
    // 立刻提交会把客户的最后两三个字甩掉
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      const text = this.asr.text().trim();
      if (!text) {
        // 有动静但一个字没识别出来，是噪音。别惊动 LLM
        this._setState("IDLE");
        return;
      }
      this.asr.resetTurn();
      this.emit("stt.final", text);
      this._runTurn(text);
    }, this.cfg.commitDelayMs);
  }

  // ================= 打断 =================

  _beginBarge() {
    if (this.bargePending) return;
    this.bargePending = true;
    // 先按住播放而不是丢掉：万一是误报，接回去就行，客户一个字都不会漏。
    // 已经排进声卡的那 100 多毫秒还是会播完，这个听感上就是自然的收尾
    this.ttsFeedPaused = true;
    this.emit("playback.pause");
    // 清掉 AI 说话期间漏进来的回声转写，接下来出现的字才是客户说的
    this.asr.resetTurn();

    clearTimeout(this.bargeTimer);
    this.bargeTimer = setTimeout(() => {
      // 超时了还没听清字：宁可放过，也不要把 AI 打断在半句上
      if (this.bargePending) this._cancelBarge();
    }, this.cfg.bargeConfirmMs);
  }

  _cancelBarge() {
    if (!this.bargePending) return;
    this.bargePending = false;
    clearTimeout(this.bargeTimer);
    this.ttsFeedPaused = false;
    this.emit("playback.resume");
    // 待确认期间攒下的句子补送给 TTS，接着往下念
    const queued = this.pendingText.splice(0);
    for (const s of queued) {
      this.fedText += s;
      this.tts.appendText(s);
    }
    // 待确认这段时间里 LLM 可能已经吐完了，当时压着没结会话，现在补上
    if (this.ttsFinishPending) {
      this.ttsFinishPending = false;
      this.tts.finishSession();
    }
    // 更极端一点：整轮 TTS 都念完了才发现是误报。那就照正常结束处理
    if (this.turnEnded) {
      this.turnEnded = false;
      this._completeTurn();
    }
    this.emit("log", "🫥 误报打断（没听到字），继续说");
  }

  _commitBarge() {
    if (!this.bargePending) return;
    this.bargePending = false;
    clearTimeout(this.bargeTimer);
    this.pendingText.length = 0;
    this.ttsFeedPaused = false;
    this.ttsFinishPending = false;
    this.turnEnded = false;

    // 1) 客户耳朵里的声音立刻停
    this.emit("playback.flush");
    // 2) 别再烧 token，后面的内容已经没人要了
    if (this.llm) {
      this.llm.abort();
      this.llm = null;
    }
    // 3) 结掉 TTS 会话，并让 session id 失效，之后迟到的音频全部丢弃
    this.tts.finishSession();
    this.ttsSession = null;
    // 4) 关键一步：按"实际播出去多少毫秒"把这段话截断再写进历史。
    //    不截的话模型以为自己已经讲完了，下一轮会接着讲后半段，答非所问
    const spoken = this._spokenTextSoFar(this.lastPlayedMs);
    if (spoken) this.history.push({ role: "assistant", content: spoken });
    this.emit("log", `✂️ 客户打断，AI 实际说到：${spoken || "（还没出声）"}`);

    this.chunker.reset();
    this.sentences = [];
    this.llmFullText = "";
    this._setState("LISTENING");
  }

  // 按已播毫秒数，算出客户真正听到的那部分文字。
  // 整句听完的直接收下；卡在中间的那句，能拿到字级时间戳就精确切到那个字上，
  // 拿不到就退化成按时长比例估算。
  //
  // 三级降级是必要的，因为打断随时可能发生：
  //   有 words   —— 这句已经念完并回了时间戳，切得最准
  //   只有 text  —— 句子结束了但时间戳还没到，按比例切
  //   都没有     —— 正念着的那一句，只能拿我们喂进去的文本按比例估
  _spokenTextSoFar(playedMs) {
    const bytesPerMs = (OUT_SAMPLE_RATE * 2) / 1000;
    let acc = 0;
    let out = "";
    for (const s of this.sentences) {
      const durMs = s.bytes / bytesPerMs;
      if (acc + durMs <= playedMs && s.text) {
        out += s.text;
        acc += durMs;
        continue;
      }
      const rel = playedMs - acc;
      if (rel <= 0) break;

      if (s.words && s.words.length) {
        // startTime 单位是秒，且相对这一句的开头
        for (const w of s.words) {
          if (w.startTime * 1000 < rel) out += w.word;
          else break;
        }
      } else {
        const known = s.text || this._unaccountedFedText(out);
        const frac = durMs > 0 ? Math.min(1, rel / durMs) : 0;
        if (frac > 0) out += known.slice(0, Math.round(known.length * frac));
      }
      break;
    }
    return out.trim();
  }

  // 正在念、还没回文本的那一句大概是什么内容：
  // 拿这一轮喂给 TTS 的全部文本，减掉已经归到前面几句头上的部分
  _unaccountedFedText(alreadyCounted) {
    const fed = this.fedText;
    if (!fed) return "";
    return alreadyCounted && fed.startsWith(alreadyCounted)
      ? fed.slice(alreadyCounted.length)
      : fed;
  }

  // ================= 一轮对话 =================

  async _runTurn(userText) {
    if (this.closed) return;
    // 上一轮还没说完就别开新的：会两轮音频叠在一起，而且 TTS session 会串。
    // 真要插队得先走打断流程，那边会把上一轮干净地收掉
    if (this.state === "THINKING" || this.state === "SPEAKING") return;
    this._setState("THINKING");

    this.history.push({ role: "user", content: userText });
    this._trimHistory();

    this.chunker.reset();
    this.sentences = [];
    this.pendingText.length = 0;
    this.llmFullText = "";
    this.fedText = "";
    this.ttsFeedPaused = false;
    this.ttsFinishPending = false;
    this.turnEnded = false;
    this.ttsSession = this.tts.startSession();

    const llm = new LlmStream({
      apiKey: this.cfg.openaiKey,
      model: this.cfg.llmModel,
      agent: this.cfg.proxyAgent,
      maxTokens: this.cfg.maxOutputTokens,
      temperature: this.cfg.temperature,
    });
    this.llm = llm;
    const mySession = this.ttsSession;

    try {
      const full = await llm.run(this.history, (delta) => {
        if (this.ttsSession !== mySession) return; // 已经被打断了
        this.emit("llm.delta", delta);
        for (const sentence of this.chunker.push(delta)) this._feedTts(sentence);
      });

      if (this.ttsSession !== mySession) return;
      const tail = this.chunker.flush();
      if (tail) this._feedTts(tail);
      this.llmFullText = full;
      this.emit("llm.done", full);
      // 文本发完了才能结会话，否则最后一句合成不出来。
      // 但打断还在待确认时不能结：pendingText 里还压着没送出去的句子，
      // 会话一结它们就永远合成不出来了，客户会听到话讲一半没了
      if (this.ttsFeedPaused) this.ttsFinishPending = true;
      else this.tts.finishSession();
    } catch (err) {
      if (this.ttsSession !== mySession) return;
      this.emit("error", `LLM: ${err.message}`);
      this.tts.finishSession();
      this.ttsSession = null;
      this._setState("IDLE");
    } finally {
      if (this.llm === llm) this.llm = null;
    }
  }

  _feedTts(sentence) {
    const s = sentence.trim();
    if (!s) return;
    if (this.ttsFeedPaused) {
      // 打断待确认中：先攒着。确认了就整批丢弃，误报了就补送
      this.pendingText.push(s);
      return;
    }
    this.fedText += s;
    this.tts.appendText(s);
  }

  // TTS 说 "这一轮念完了"
  _finishSpeaking() {
    this.ttsSession = null;
    // 卡在打断待确认里：现在还不知道该往历史里写完整版还是截断版，先挂起。
    // 抢跑写了完整版的话，万一打断被确认，历史里就会同时躺着完整版和截断版两条
    if (this.bargePending) {
      this.turnEnded = true;
      return;
    }
    this._completeTurn();
  }

  // 一轮正常收尾。历史里记完整文本——它确实整段都播出去了
  _completeTurn() {
    const said = (this.llmFullText || this.sentences.map((s) => s.text).join("")).trim();
    if (said) this.history.push({ role: "assistant", content: said });
    this.sentences = [];
    this.llmFullText = "";
    // 把 AI 说话期间漏进来的回声转写清掉。不清的话它会挂在缓冲里，
    // 等客户下次开口就被当成客户说的一起提交给 LLM
    this.asr.resetTurn();
    this._setState("IDLE");
  }

  // 上下文越长首 token 越慢，电话场景不需要记住二十分钟前的细节。
  // system 永远留着，后面只保留最近若干条
  _trimHistory() {
    const keep = this.cfg.historyTurns * 2;
    if (this.history.length <= keep + 1) return;
    this.history = [this.history[0], ...this.history.slice(-keep)];
  }
}
