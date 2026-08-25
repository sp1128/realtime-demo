// 一通电话的编排器。整条链路的大脑都在这里：
//
//   浏览器音频(24k) ─┬─→ VAD ──────→ 状态机（谁在说话、什么时候该接话、要不要打断）
//                    └─→ 降采样(16k) → 火山 ASR → 文本
//                                                   ↓
//                                            DeepSeek LLM（流式）
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
//
// SPEAKING 一直维持到浏览器把音频真正播完。TTS 会话结束只说明 PCM 发完了，
// 声卡队列里可能还躺着一两秒。这段时间里如果就切 IDLE，客户插话会变成
// "新开一轮排在旧声音后面"，听感就是打不断。

import { EventEmitter } from "events";
import { VolcAsr, ASR_SAMPLE_RATE } from "./volc-asr.js";
import { VolcTts } from "./volc-tts.js";
import { LlmStream } from "./llm.js";
import { Vad } from "./vad.js";
import { Downsampler } from "./resample.js";
import { SentenceChunker } from "./chunker.js";
import { SYSTEM_PROMPT, interruptHint, pickBargeAck, toneHint, IDLE_NUDGE_HINT, IDLE_BYE_HINT } from "./prompt.js";

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
      endWindowMs: cfg.asrEndWindowMs,
      detectEmotion: cfg.asrDetectEmotion,
    });
    this.tts = new VolcTts({
      appKey: cfg.volcAppId,
      accessKey: cfg.volcToken,
      resourceId: cfg.ttsResourceId,
      speaker: cfg.speaker,
      model: cfg.ttsModel,
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
    // TTS 会话结束了，等浏览器把队列播干才真正收尾
    this.awaitingPlaybackEnd = false;
    this.playbackEndTimer = null;
    // 本轮是被打断后接上的。只影响这一次 LLM 调用，用完即清
    this.justBarged = false;
    // 打断后先应一声，这段时间客户可能还在说，状态先留在 LISTENING
    this.bridging = false;
    this.bridgeText = "";
    this.skipAckPrefix = "";
    this.interruptedSpoken = "";

    // ---- 打断待确认 ----
    this.bargeTimer = null;
    this.bargePending = false;
    this.bargeBaseText = "";
    this.lastPlayedMs = 0;

    // ---- 轮次提交 ----
    this.commitTimer = null;
    this.greetTimer = null;

    // ---- 冷场追问 / 收线 ----
    this.idleTimer = null;
    this.idleNudges = 0;
    this.allowIdle = true;
    this.hangupAfter = false;
    this._silence = null;
    // AI 说话期间攒下的真音频，插话时补给 ASR（见 pushAudio）
    this._preroll = [];

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
    // AI 在说话时麦会收到扬声器（免提尤其严重）。这段别送给 ASR：
    // 否则转写里全是自己的词，打断确认会误判，下一轮识别也脏。
    // VAD 仍然看真声音，所以人一插话还是能马上把播放按住。
    const muteAsr =
      (this.state === "SPEAKING" || this.state === "THINKING") &&
      !this.bargePending &&
      !this.bridging;
    if (muteAsr) {
      // 灌静音的同时，把真音频留一小段。客户插话时 VAD 要连续几帧才触发，
      // 等触发了再放开 ASR，开头那一两百毫秒已经当静音喂进去了——
      // ASR 从半个字开始听，1 秒内出不来字，打断就被判成误报。
      // 存着这段，触发时先把它补送进去，ASR 拿到的是完整的起头
      this._preroll.push(Int16Array.from(int16));
      let total = this._preroll.reduce((n, a) => n + a.length, 0);
      const cap = (OUT_SAMPLE_RATE * this.cfg.prerollMs) / 1000;
      while (total > cap && this._preroll.length > 1) {
        total -= this._preroll.shift().length;
      }
      if (!this._silence || this._silence.length !== int16.length) {
        this._silence = new Int16Array(int16.length);
      }
      this.asr.sendAudio(this.down.process(this._silence));
    } else {
      this.asr.sendAudio(this.down.process(int16));
    }
  }

  // 把攒下的真音频补送给 ASR。插话确认全靠它把开头补齐
  _flushPreroll() {
    const buf = this._preroll.splice(0);
    for (const a of buf) this.asr.sendAudio(this.down.process(a));
  }

  // 线路测试用：不经过麦克风和 VAD，直接跑一轮完整的 LLM → TTS，
  // 单独量这条链路的首字延迟和供给率
  probe() {
    if (this.state === "THINKING" || this.state === "SPEAKING") return;
    this.allowIdle = false;
    this._clearIdle();
    this._runTurn("（线路测试）随便说两句话就行。");
  }

  // 浏览器汇报"AI 的声音实际播出去了多少毫秒"。
  // 打断时靠它算出客户到底听到了哪儿，这是历史能不能对齐的唯一依据
  reportPlayed(ms) {
    this.lastPlayedMs = ms;
  }

  // 浏览器说声卡队列空了。TTS 会话结束只代表 PCM 发完，真正说完是这一刻
  onPlaybackEnded() {
    if (this.closed || !this.awaitingPlaybackEnd) return;
    this.awaitingPlaybackEnd = false;
    clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;
    if (this.bargePending) return;
    // 空回复或首包音频还没把状态切到 SPEAKING 时，也要收尾
    if (this.state !== "SPEAKING" && this.state !== "THINKING") return;
    this._completeTurn();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.bargeTimer);
    clearTimeout(this.commitTimer);
    clearTimeout(this.greetTimer);
    clearTimeout(this.playbackEndTimer);
    clearTimeout(this.idleTimer);
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
      if (this.state === "LISTENING" || this.state === "IDLE" || this.bargePending) {
        this.emit("stt.partial", text);
      }
      if (this.bargePending) {
        const fresh = this._bargeFreshText(text).trim();
        if (fresh.length >= this.cfg.bargeMinChars && !this._looksLikeEcho(fresh)) {
          this._commitBarge();
        }
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
      // 垫话出声时客户可能还没说完，别切 SPEAKING，否则 _onSpeechEnd 不会提交这一轮
      if (this.state === "THINKING" || this.state === "IDLE") {
        this.bridging = false;
        this._setState("SPEAKING");
      }
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
    // AI 开口、以及打断后垫话出声时都收紧 VAD，避免被自己的回声再打一次
    this.vad.setGuard(s === "SPEAKING" || this.bridging);
    this.emit("state", s);
  }

  // ================= VAD 事件 =================

  _onSpeechStart() {
    clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this._clearIdle();

    if (this.state === "SPEAKING" || this.state === "THINKING") {
      this._beginBarge();
      return;
    }
    this._setState("LISTENING");
    const already = this.asr.text().trim();
    if (already) this.emit("stt.partial", already);
  }

  _onSpeechEnd() {
    if (this.bargePending) {
      // 人声停了但字可能还在路上。别当误报——咳嗽那种才是"响一下就没了还没出字"。
      // 真打断的确认交给 ASR partial / bargeTimer，客户已经说完则在 _commitBarge 里补提交
      return;
    }
    if (this.state !== "LISTENING") return;
    this._scheduleCommit();
  }

  // 静音后再等一小会，让 ASR 最后几个字落地，再把这一轮交给 LLM
  _scheduleCommit() {
    if (this.closed) return;
    clearTimeout(this.commitTimer);
    const delay =
      this.justBarged || this.bridging
        ? Math.min(this.cfg.commitDelayMs, 160)
        : this.cfg.commitDelayMs;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      const text = this.asr.text().trim();
      if (!text) {
        // 有动静但一个字没识别出来，是噪音。别惊动 LLM
        this.justBarged = false;
        this.bridging = false;
        this._setState("IDLE");
        this._armIdle();
        return;
      }
      // 情绪/语速要在 resetTurn 之前取，晚了就被下一轮覆盖了
      const meta = this.asr.takeMeta();
      this.asr.resetTurn();
      this.emit("stt.final", text);
      this._runTurn(text, { meta });
    }, delay);
  }

  // ================= 打断 =================

  _beginBarge() {
    if (this.bargePending) return;
    this.bargePending = true;
    // 先按住播放而不是丢掉：万一是误报，把还没听到的 PCM 接回去就行。
    // 已经排进声卡的分片会立刻停掉，不再让对方多听一两秒。
    this.ttsFeedPaused = true;
    this.emit("playback.pause");
    // AI 说话期间 ASR 吃的是静音，这里清掉残留再开始听人，
    // 然后把刚才攒的真音频补进去，免得 ASR 从半个字开始听
    this.asr.resetTurn();
    this._flushPreroll();
    this.bargeBaseText = "";

    clearTimeout(this.bargeTimer);
    this.bargeTimer = setTimeout(() => {
      // 超时了还没听清字：宁可放过，也不要把 AI 打断在半句上
      if (this.bargePending) this._cancelBarge();
    }, this.cfg.bargeConfirmMs);
  }

  _cancelBarge() {
    if (!this.bargePending) return;
    this.bargePending = false;
    this.bargeBaseText = "";
    clearTimeout(this.bargeTimer);
    this.ttsFeedPaused = false;
    this.emit("playback.resume");
    // 待确认期间攒下的句子补送给 TTS，接着往下念
    const queued = this.pendingText.splice(0);
    for (const s of queued) {
      this.fedText += s;
      this.tts.appendText(s);
    }
    if (this.ttsFinishPending) {
      this.ttsFinishPending = false;
      this.tts.finishSession();
      // session.finished 到了会走 _finishSpeaking → 等浏览器播完再收尾
    } else if (this.turnEnded) {
      // TTS 其实已经念完了，只是待确认时没敢收尾。接着播剩下的，播完再结束
      this.turnEnded = false;
      this._waitForPlaybackEnd();
    }
    // 这里**不能**清 ASR。判成误报只说明"1 秒内没凑够字数去确认打断"，
    // 不代表客户没说话——他可能正说到一半。清了的话这句就永远丢了，
    // 实测过的表现是：客户说"我用量化工具"，AI 却按"不错"去理解，然后准备收线。
    // 留着，等这一轮播完在 _completeTurn 里一并提交
    this.emit("log", "🫥 没凑够字数确认打断，继续说（听到的字留着）");
  }

  // 打断后比基线多出来的字。假设被改写了（不再以基线开头）就整段当作新说的
  _bargeFreshText(text) {
    const base = this.bargeBaseText || "";
    const t = (text || "").trim();
    if (!base) return t;
    if (t.startsWith(base)) return t.slice(base.length);
    if (t === base) return "";
    return t;
  }

  _commitBarge() {
    if (!this.bargePending) return;
    this.bargePending = false;
    clearTimeout(this.bargeTimer);
    this.pendingText.length = 0;
    this.ttsFeedPaused = false;
    this.ttsFinishPending = false;
    this.turnEnded = false;
    this.awaitingPlaybackEnd = false;
    this.justBarged = true;
    this.bargeBaseText = "";
    this.bridging = true;
    this.bridgeText = "";
    clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;

    // 先算截断文本：后面要清 sentences，晚了就没了
    const spoken = this._spokenTextSoFar(this.lastPlayedMs);
    this.interruptedSpoken = spoken;

    // 旧声音淡出，等客户说完再开口。这时还不知道他要说什么，
    // 不能垫「你说」——那是让对方继续讲，可他已经在讲/讲完了
    this.emit("playback.flush");
    if (this.llm) {
      this.llm.abort();
      this.llm = null;
    }
    this.tts.finishSession();
    this.ttsSession = null;
    this.chunker.reset();
    this.sentences = [];
    this.llmFullText = "";
    this.fedText = "";

    if (spoken) this.history.push({ role: "assistant", content: spoken + "……" });
    this.emit("log", `✂️ 客户打断，AI 实际说到：${spoken || "（还没出声）"}`);

    this._setState("LISTENING");
    if (!this.vad.speaking) this._scheduleCommit();
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
    const fed = (this.fedText || this.llmFullText || "").trim();
    const totalBytes = this.sentences.reduce((n, s) => n + (s.bytes || 0), 0);
    const totalDur = totalBytes / bytesPerMs;

    let acc = 0;
    let out = "";
    for (const s of this.sentences) {
      const durMs = s.bytes / bytesPerMs;
      if (durMs < 1) continue;
      // 整句已经播完：就算 351 文本还没到，也先占住时长往下走，别在空壳上 break
      // （否则会丢掉前面已经听完的「您好，请问是叶升辉先生吗？」）
      if (acc + durMs <= playedMs + 30) {
        if (s.text) out += s.text;
        acc += durMs;
        continue;
      }
      const rel = playedMs - acc;
      if (rel <= 0) break;

      if (s.words && s.words.length) {
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

    out = out.trim();
    // 前面几句没回文本时，按已播比例从喂给 TTS 的全文切，保证开场问句还在
    if (fed && totalDur > 0) {
      const frac = Math.min(1, Math.max(0, playedMs / totalDur));
      const fromFed = fed.slice(0, Math.max(1, Math.round(fed.length * frac))).trim();
      if (!out) return fromFed;
      if (fed.startsWith(out)) {
        if (fromFed.length > out.length) return fromFed;
        return out;
      }
      return fromFed || out;
    }
    return out;
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

  async _runTurn(userText, opts = {}) {
    if (this.closed) return;
    // 上一轮还没说完就别开新的：会两轮音频叠在一起，而且 TTS session 会串。
    // 真要插队得先走打断流程，那边会把上一轮干净地收掉
    if (this.state === "THINKING" || this.state === "SPEAKING") return;
    this._clearIdle();
    this._setState("THINKING");

    const inject = !!opts.inject;
    if (!inject) {
      this.hangupAfter = false;
      this.idleNudges = 0;
      this.history.push({ role: "user", content: userText });
      this._trimHistory();
    } else if (opts.hangupAfter) {
      this.hangupAfter = true;
    }

    const interrupted = inject ? false : this.justBarged;
    this.justBarged = false;
    const spoken = this.interruptedSpoken;
    this.interruptedSpoken = "";
    const ack = interrupted ? pickBargeAck(userText) : "";
    const tone = inject ? "" : toneHint(opts.meta);
    if (opts.meta) {
      const m = opts.meta;
      this.emit(
        "log",
        `🎚️ 语气: ${m.emotion || "?"}/${m.emotionDegree || "?"}` +
          ` 语速 ${m.speechRate.toFixed(1)}` +
          (m.fasterThanUsual ? `（${m.fasterThanUsual > 0 ? "+" : ""}${(m.fasterThanUsual * 100).toFixed(0)}%）` : "") +
          (m.hotwords ? ` 命中热词 ${m.hotwords}` : "") +
          (tone ? " → 已提示模型" : ""),
      );
    }
    this.bridgeText = ack;
    // 提示都以 system 消息的形式插在最后一条用户消息**之前**，只作用于这一轮。
    // 不写进 this.history：这些是当下的听感，留着会让模型在后面几轮里
    // 反复参考一个已经过期的情绪
    const hints = [];
    if (interrupted) hints.push(interruptHint(ack, spoken));
    if (tone) hints.push(tone);
    const messages = inject
      ? [...this.history, { role: "system", content: userText }]
      : hints.length
        ? [
            ...this.history.slice(0, -1),
            ...hints.map((h) => ({ role: "system", content: h })),
            this.history[this.history.length - 1],
          ]
        : this.history;

    this.chunker.reset();
    this.pendingText.length = 0;
    this.ttsFeedPaused = false;
    this.ttsFinishPending = false;
    this.turnEnded = false;
    this.awaitingPlaybackEnd = false;
    clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;

    this.sentences = [];
    this.llmFullText = "";
    this.fedText = "";
    this.ttsSession = this.tts.startSession();
    this.skipAckPrefix = "";
    // 客户说完了才开口。垫的是「好 / 哦 / 啊」，边合成边让 LLM 想后半句
    if (ack) {
      this._feedTts(ack);
      this.skipAckPrefix = ack.replace(/[。！？、，.\s]/g, "");
      this.emit("llm.delta", ack);
      this.emit("log", `… 先应一声：${ack}`);
    }

    const llm = new LlmStream({
      apiKey: this.cfg.llmKey,
      model: this.cfg.llmModel,
      host: this.cfg.llmHost,
      agent: this.cfg.proxyAgent,
      maxTokens: this.cfg.maxOutputTokens,
      temperature: this.cfg.temperature,
    });
    this.llm = llm;
    const mySession = this.ttsSession;

    try {
      const full = await llm.run(messages, (delta) => {
        if (this.ttsSession !== mySession) return; // 已经被打断了
        this.emit("llm.delta", delta);
        for (const sentence of this.chunker.push(delta)) this._feedTts(sentence);
      });

      if (this.ttsSession !== mySession) return;
      const tail = this.chunker.flush();
      if (tail) this._feedTts(tail);
      this.llmFullText = (ack || "") + full;
      this.emit("llm.done", this.llmFullText);
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
      this.bridging = false;
      this._setState("IDLE");
      if (this.hangupAfter) this.emit("hangup");
      else this._armIdle();
    } finally {
      if (this.llm === llm) this.llm = null;
    }
  }

  _feedTts(sentence) {
    let s = sentence.trim();
    if (!s) return;
    if (this.skipAckPrefix) {
      const p = this.skipAckPrefix;
      this.skipAckPrefix = "";
      s = s.replace(new RegExp(`^${p}[的]?[。！？，、,\\s]*`), "").trim();
      if (!s) return;
    }
    if (this.ttsFeedPaused) {
      // 打断待确认中：先攒着。确认了就整批丢弃，误报了就补送
      this.pendingText.push(s);
      return;
    }
    this.fedText += s;
    this.tts.appendText(s);
  }

  // TTS 说 "这一轮的 PCM 发完了"。客户耳朵里可能还在听队列里的尾巴，
  // 先别切 IDLE——等浏览器回报播完，这段时间里插话才能走打断
  _finishSpeaking() {
    this.ttsSession = null;
    // 卡在打断待确认里：现在还不知道该往历史里写完整版还是截断版，先挂起。
    // 抢跑写了完整版的话，万一打断被确认，历史里就会同时躺着完整版和截断版两条
    if (this.bargePending) {
      this.turnEnded = true;
      return;
    }
    this._waitForPlaybackEnd();
  }

  _waitForPlaybackEnd() {
    this.awaitingPlaybackEnd = true;
    this.emit("tts.drain");
    clearTimeout(this.playbackEndTimer);
    // 浏览器如果一直不回报播完（切后台、音频节点卡住），别把状态卡死在 SPEAKING
    this.playbackEndTimer = setTimeout(() => this.onPlaybackEnded(), 30000);
  }

  // 一轮正常收尾。历史里记完整文本——它确实整段都播出去了
  _completeTurn() {
    this.awaitingPlaybackEnd = false;
    clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;
    this.bridging = false;
    this.bridgeText = "";
    this.skipAckPrefix = "";
    this.interruptedSpoken = "";
    const said = (this.llmFullText || this.sentences.map((s) => s.text).join("")).trim();
    if (said) this.history.push({ role: "assistant", content: said });
    this.sentences = [];
    this.llmFullText = "";
    // AI 说话期间客户插过话、但没凑够字数确认打断的，字还留在 ASR 里。
    // 这时候不能当没听见——那正是"客户说了话 AI 却没反应"的来源。
    // 有字就直接当成新的一轮接着处理，没有才回 IDLE
    const pending = this.asr.text().trim();
    // 兜底：跟刚提交过的那句几乎一样就别再当新话了。
    // ASR 的定稿是滞后到达的，正常路径已经按 start_time 挡在 volc-asr 里，
    // 这里再挡一次——重复提问的表现是 AI 把同一个问题连答两遍，很出戏
    const lastUser = [...this.history].reverse().find((m) => m.role === "user");
    const norm = (t) => String(t || "").replace(/[^一-鿿A-Za-z0-9]/g, "");
    const isEcho = lastUser && norm(pending) && norm(lastUser.content).startsWith(norm(pending));
    if (pending && !isEcho && !this.hangupAfter) {
      this.emit("log", `📌 客户在 AI 说话时说了「${pending}」，接着处理`);
      this._setState("LISTENING");
      this._scheduleCommit();
      return;
    }
    if (pending && isEcho) {
      this.emit("log", `（丢弃迟到的重复转写「${pending}」）`);
    }
    this.asr.resetTurn();
    this._setState("IDLE");
    if (this.hangupAfter) {
      this.emit("hangup");
      return;
    }
    this._armIdle();
  }

  _clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _armIdle() {
    this._clearIdle();
    if (this.closed || !this.allowIdle || this.hangupAfter) return;
    const last = [...this.history].reverse().find((m) => m.role === "assistant");
    const alreadyBye = last && /再见|不打扰您了|祝您生活愉快|拜拜/.test(last.content || "");
    if (alreadyBye) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.closed && this.state === "IDLE") this.emit("hangup");
      }, 1200);
      return;
    }
    const delay =
      this.idleNudges >= 1 ? this.cfg.idleByeMs || 10000 : this.cfg.idleNudgeMs || 8000;
    this.idleTimer = setTimeout(() => this._onIdleTimeout(), delay);
  }

  _onIdleTimeout() {
    this.idleTimer = null;
    if (this.closed || this.state !== "IDLE") return;
    if (this.idleNudges >= 1) {
      this.emit("log", "⌛ 客户还是没接话，准备收线");
      this._runTurn(IDLE_BYE_HINT, { inject: true, hangupAfter: true });
    } else {
      this.idleNudges = 1;
      this.emit("log", "⌛ 客户这会儿没说话，追问一句");
      this._runTurn(IDLE_NUDGE_HINT, { inject: true });
    }
  }

  // 回声比对的取材范围：正在念的那一句 + 上一句。
  // 取两句而不是一句，是因为打断往往正好发生在句子交界处，
  // 这时上一句的尾音可能还在声卡队列里没播完。
  // sentences 是按 TTS 自己的断句记的账，粒度正好。
  // 一句都还没回文本时（刚开口就被打断）退回整轮 fedText——
  // 那种情况下念出去的本来也没几个字，误伤概率低。
  _recentSpokenText() {
    const texts = this.sentences.map((x) => x.text || "").filter(Boolean);
    if (texts.length) return texts.slice(-2).join("").trim();
    return (this.fedText || this.llmFullText || "").trim();
  }

  // 免提时 ASR 听到的常常是扬声器里正在念的词，跟稿子一比就能看出来。
  //
  // 关键是**只跟最近正在念的那一两句比，不能跟整轮稿子比**。
  // 回声是时间对齐的：麦这一刻能听到的，只可能是扬声器这一刻正在念的那几个字。
  // 拿整轮去比会把客户的抢答一起吃掉——最典型的是选择题：
  //   AI「您平时是做股票、期货还是数字资产」
  //   客户「期货」  ← 整轮稿子里有这两个字，于是被判成回声
  // 结果打断不成立，1 秒后 _cancelBarge 还会把这句连带清掉，客户等于白说了。
  _looksLikeEcho(heard) {
    const spoken = this._recentSpokenText();
    const a = String(heard || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    const b = spoken.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    if (a.length < 2 || b.length < 2) return false;

    // 短词一律放行。选择题抢答就长在正在念的那句里——
    // AI「做股票、期货还是数字资产」，客户答「期货」，光收窄窗口救不了。
    //
    // 敢这么放是因为回声的主力防线不在这儿：AI 说话时 ASR 吃的是静音，
    // 而且打断一触发就 playback.pause，扬声器几乎立刻停，
    // 能混进来的只有声卡里那一两百毫秒尾巴，长不了。
    //
    // 两种错的代价不对等：吃掉客户的抢答是静默失败（他以为没听见，
    // 重说一遍或者干脆挂了），而偶尔被一小段回声误打断，只是 AI 停一下再听。
    // 真被误打断得多，把 BARGE_ECHO_MIN_CHARS 调小。
    if (a.length < (this.cfg.bargeEchoMinChars || 5)) return false;
    if (b.includes(a) || (a.length >= 4 && a.includes(b))) return true;
    let hits = 0;
    const n = a.length - 1;
    for (let i = 0; i < n; i++) {
      if (b.includes(a.slice(i, i + 2))) hits++;
    }
    if (n > 0 && hits / n >= 0.55) return true;
    let j = 0;
    let matched = 0;
    for (let i = 0; i < a.length; i++) {
      const p = b.indexOf(a[i], j);
      if (p < 0) continue;
      matched++;
      j = p + 1;
    }
    return matched / a.length >= 0.7;
  }

  // 上下文越长首 token 越慢，电话场景不需要记住二十分钟前的细节。
  // system 永远留着，后面只保留最近若干条
  _trimHistory() {
    const keep = this.cfg.historyTurns * 2;
    if (this.history.length <= keep + 1) return;
    this.history = [this.history[0], ...this.history.slice(-keep)];
  }
}
