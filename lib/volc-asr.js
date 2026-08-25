// 火山引擎「大模型流式语音识别」客户端。
// 一通电话开一条连接，全程复用 —— 每轮都重连的话，光握手就要几百毫秒，
// 而且每次重连都会丢掉上一句的声学上下文，识别质量肉眼可见地掉。
//
// 帧格式：header(4) + seq(int32,大端有符号) + payloadSize(uint32) + payload(gzip)
// 第一帧是 JSON 配置（full client request），之后全是音频帧。
// 最后一帧要把 seq 取负、标志位用 NEG_SEQ，服务端据此知道说完了。

import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  buildHeader,
  parseHeader,
  gzip,
  maybeGunzip,
  int32be,
  uint32be,
  MSG_FULL_CLIENT,
  MSG_AUDIO_ONLY_CLIENT,
  MSG_FULL_SERVER,
  MSG_ERROR,
  FLAG_POS_SEQ,
  FLAG_NEG_SEQ,
  SERIAL_JSON,
  SERIAL_RAW,
  COMPRESS_GZIP,
} from "./protocol.js";

// 用「双向流式优化版」这条地址，不是 /bigmodel。两个原因：
// 1. 2.0 代的资源号（volc.seedasr.*）在 /bigmodel 上直接 400，只认这条
// 2. 官方文档也推荐它——不再是每输入一包回一包，只在结果有变化时才回，
//    rtf 和首字/尾字时延都更好
const ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

// 火山这个接口只吃 16kHz。我们采集侧是 24kHz（播放要用 24k，两边共用一个
// AudioContext），所以进来之前必须降采样，见 resample.js
export const ASR_SAMPLE_RATE = 16000;

export class VolcAsr extends EventEmitter {
  constructor(opts) {
    super();
    this.appKey = opts.appKey;
    this.accessKey = opts.accessKey;
    // 按你在控制台开通的套餐填。注意 1.0 和 2.0 是两套完全不同的号：
    //   2.0（豆包流式语音识别模型2.0）小时版 volc.seedasr.sauc.duration
    //                                并发版 volc.seedasr.sauc.concurrent
    //   1.0                          小时版 volc.bigasr.sauc.duration
    // 填错分两种表现：号本身不存在是 400，号存在但你没开通是 403
    this.resourceId = opts.resourceId || "volc.seedasr.sauc.duration";
    this.uid = opts.uid || "realtime-demo";
    this.hotwords = opts.hotwords || [];
    // VAD 静音判停阈值。取值范围 [300,5000]，官方推荐 [800,1000]。
    // 别为了抢快压到推荐区间以下——轮次什么时候提交是我们自己的 VAD 说了算，
    // 这个值只影响 ASR 内部怎么分句，压太低反而会把一句话切碎、伤准确率
    this.endWindowMs = opts.endWindowMs || 400;
    this.detectEmotion = opts.detectEmotion !== false;
    // 最近一句定稿带回来的情绪/语速等元信息，编排层取走后清空
    this.meta = null;
    // 客户语速的滑动均值，用来判断"这一句比平时快多少"
    this.rateAvg = 0;
    this.rateSeen = 0;
    this.ws = null;
    this.seq = 1;
    this.ready = false;
    this.closed = false;
    // 已经确认落定的句子拼起来。火山每次回的是整段结果，
    // 但一句 definite 之后会开新的一段，所以要自己攒
    this.finalizedText = "";
    this.partialText = "";
    // 同一句 definite 可能在相邻几帧里重复出现，靠时间戳去重，
    // 不然客户说一句话会在历史里出现两三遍
    this.seenDefinite = new Set();
    this.logid = "";
    // ASR 的时间轴是从建连开始一路累加的（毫秒）。
    // resetTurn 时记下当前位置，早于这条线的定稿结果一律不要——
    // 否则上一轮的定稿要是晚到几百毫秒，就会被算进下一轮客户说的话里
    this.turnCutoffMs = 0;
    this.maxEndTime = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ASR_URL, {
        headers: {
          "X-Api-App-Key": this.appKey,
          "X-Api-Access-Key": this.accessKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Connect-Id": randomUUID(),
          // 这两个文档标的是必选。不带也能握上手，但别赌——
          // Request-Id 是排障时找这次会话的凭据，Sequence 是固定值 -1
          "X-Api-Request-Id": randomUUID(),
          "X-Api-Sequence": "-1",
        },
        handshakeTimeout: 8000,
      });
      this.ws = ws;
      // 同 TTS：握手响应头里的 logid 是报障的唯一线索，留下来
      ws.on("upgrade", (res) => {
        this.logid = res.headers["x-tt-logid"] || "";
        if (this.logid) this.emit("logid", this.logid);
      });

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      ws.on("open", () => {
        this._sendConfig();
        this.ready = true;
        settled = true;
        resolve();
      });
      ws.on("message", (data) => this._onMessage(data));
      ws.on("error", (err) => {
        fail(err);
        if (!this.closed) this.emit("error", err);
      });
      ws.on("close", (code, reason) => {
        this.ready = false;
        fail(new Error(`ASR 连接被关闭 code=${code} ${reason?.toString() || ""}`));
        if (!this.closed) this.emit("close", code);
      });
    });
  }

  _sendConfig() {
    const payload = {
      user: { uid: this.uid },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: ASR_SAMPLE_RATE,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: "bigmodel", // 这个字段目前只有这一个取值，跟 1.0/2.0 无关
        enable_punc: true, // 加标点，直接影响 LLM 的断句理解
        enable_itn: true, // 把"一百二十三"规整成"123"
        enable_ddc: false, // 语义顺滑（去口水词）。电话场景关掉，
        // 因为"嗯""那个"这些恰恰是判断客户犹豫的信号
        result_type: "full", // 每次带回当前全部在途分句。用 single 的话 resetTurn 之后要等字变了才有下一包，中间会空一截
        show_utterances: true,
        // 流式上屏 + 分句后再用非流式模型重认一遍。快和准靠这一项同时拿到
        enable_nonstream: true,
        // 首字尽快出来。定稿仍走上面的二遍识别，不会把最终结果一起带偏
        enable_accelerate_text: true,
        accelerate_score: 8,
        // 跟本地 VAD 对齐：静音这么久 ASR 就定稿，提交时最后几个字才赶得上
        end_window_size: this.endWindowMs,
        // 太短的「嗯」「对」也要能定稿，默认 1000 会把短应答卡住
        force_to_speech_time: 400,
        // 情绪 / 语速 / 音量，挂在二遍识别的定稿分句上，正好赶在提交那一刻。
        // 级联架构最大的损失就是 LLM 只看得到文字、听不出语气，这里补一部分回去。
        //
        // 注意：开启 emotion 会自动启用 800ms 的 VAD 分句，但上面 end_window_size
        // 已经显式设过，不会被它改回去。
        //
        // 实测 speech_rate 能区分（不耐烦 5.02 / 平静 3.79，差 32%）；
        // emotion 在合成语音上两句都返回 neutral，真人语音待观察。
        // 所以下游以语速为主、情绪为辅
        ...(this.detectEmotion
          ? {
              enable_emotion_detection: true,
              show_speech_rate: true,
              show_volume: true,
            }
          : {}),
        // 热词。注意 context 是个 JSON **字符串**，不是对象，
        // 而且每个词要包成 {word: "..."}——直接塞字符串数组进去是不生效的
        ...(this.hotwords.length
          ? {
              corpus: {
                context: JSON.stringify({
                  hotwords: this.hotwords.map((w) => ({ word: w })),
                }),
              },
            }
          : {}),
      },
    };
    const body = gzip(Buffer.from(JSON.stringify(payload), "utf8"));
    this._send(
      buildHeader(MSG_FULL_CLIENT, FLAG_POS_SEQ, SERIAL_JSON, COMPRESS_GZIP),
      this.seq++,
      body,
    );
  }

  // 送一包 16kHz PCM16。last=true 表示这是本次识别的最后一包
  sendAudio(pcm16le, last = false) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const body = gzip(pcm16le);
    const flags = last ? FLAG_NEG_SEQ : FLAG_POS_SEQ;
    // 最后一包序号取负，这是协议规定的结束标记，不是笔误
    const seq = last ? -this.seq : this.seq;
    this.seq++;
    this._send(
      buildHeader(MSG_AUDIO_ONLY_CLIENT, flags, SERIAL_RAW, COMPRESS_GZIP),
      seq,
      body,
    );
  }

  _send(header, seq, body) {
    this.ws.send(
      Buffer.concat([header, int32be(seq), uint32be(body.length), body]),
      { binary: true },
    );
  }

  _onMessage(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4) return;
    const h = parseHeader(buf);
    let p = h.bodyOffset;

    if (h.msgType === MSG_ERROR) {
      const code = buf.readUInt32BE(p);
      p += 4;
      const size = buf.readUInt32BE(p);
      p += 4;
      const msg = maybeGunzip(buf.subarray(p, p + size), h.compress).toString("utf8");
      this.emit("error", new Error(`ASR 报错 code=${code} ${msg}`));
      return;
    }
    if (h.msgType !== MSG_FULL_SERVER) return;

    // 标志位第 0 位表示这帧带序号，带了就得先把这 4 字节跳过去，
    // 否则 payloadSize 会读到序号上，长度算出来是天文数字
    if (h.flags & 0b0001) p += 4;
    if (p + 4 > buf.length) return;
    const size = buf.readUInt32BE(p);
    p += 4;
    const raw = maybeGunzip(buf.subarray(p, p + size), h.compress);
    if (!raw.length) return;

    let json;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return;
    }
    this._onResult(json);
  }

  _onResult(json) {
    const result = json.result;
    if (!result) return;

    // result_type=full：每次带回当前还在途的全部分句，按时间戳滤掉上一轮的。
    // 不要往 finalizedText 上累加——full 已经是完整快照，加会重字
    const utts = Array.isArray(result.utterances) ? result.utterances : [];

    if (utts.length) {
      let finalized = "";
      const partials = [];
      for (const u of utts) {
        if (typeof u.end_time === "number" && u.end_time > this.maxEndTime) {
          this.maxEndTime = u.end_time;
        }
        if (!u.text) continue;
        // 归属看 start_time，不能看 end_time。
        //
        // 同一句话会先以未定稿形式来、后以定稿形式再来一次，而**定稿的
        // end_time 比未定稿更晚**。提交时截止线是按当时见到的 end_time 定的，
        // 于是迟到的定稿 end_time 更大、越过截止线，同一句就被当成新的又收一遍。
        // 实测表现：客户问"有啥事"，AI 答完之后这句又冒出来，AI 把同一个问题
        // 回答了两遍。
        //
        // start_time 在定稿前后是同一个值，拿它判"这句属于哪一轮"才稳。
        // 客户停顿后新说的话 start_time 一定在截止线之后，不会被误杀。
        const st = typeof u.start_time === "number" ? u.start_time : null;
        if (st !== null && st < this.turnCutoffMs) continue;
        if (st === null && typeof u.end_time === "number" && u.end_time <= this.turnCutoffMs) continue;
        if (u.definite) {
          const key = `${u.start_time}-${u.end_time}`;
          this.seenDefinite.add(key);
          finalized += u.text;
          this._takeMeta(u.additions);
        } else {
          partials.push(u.text);
        }
      }
      this.finalizedText = finalized;
      this.partialText = partials.join("");
    } else {
      this.partialText = result.text || "";
    }
    this.emit("partial", this.text());
  }

  // 从定稿分句的 additions 里抽情绪/语速。字段全是字符串，要自己转数字。
  // 只有二遍识别的结果（source=two_pass）才带这些，流式那一遍是空的
  _takeMeta(add) {
    if (!add) return;
    const rate = Number(add.speech_rate);
    const m = {
      emotion: add.emotion || "",
      emotionDegree: add.emotion_degree || "",
      speechRate: Number.isFinite(rate) ? rate : 0,
      volume: Number(add.volume) || 0,
      // 哪些热词真的命中了。调 ASR_HOTWORDS 时看这个，比凭感觉猜有用
      hotwords: add.all_matched_hotwords || "",
      fasterThanUsual: 0,
    };
    if (m.speechRate > 0) {
      if (this.rateSeen > 0) m.fasterThanUsual = m.speechRate / this.rateAvg - 1;
      this.rateSeen++;
      this.rateAvg += (m.speechRate - this.rateAvg) / this.rateSeen;
    }
    this.meta = m;
  }

  // 取走并清空。一轮只该用一次，留着会污染下一轮
  takeMeta() {
    const m = this.meta;
    this.meta = null;
    return m;
  }

  // 当前这一轮听到的全部内容（已定稿 + 还在变的）
  text() {
    return this.finalizedText + this.partialText;
  }

  // 一轮对话处理完，把文本清零，但连接和声学上下文都留着。
  // seenDefinite 不清：清了的话上一轮的句子会被当成新的重新收进来
  // 一轮处理完，或者插话开始时调。清本地文本 + 把截止线抬到当前位置。
  //
  // 清本地文本在 result_type=full 下是没有代价的：每条消息都带回完整快照，
  // 下一条到达时 finalizedText/partialText 会被整个重建，不是累加。
  // （早期用 result_type=single 时不是这样，那时清缓冲确实会丢字，
  //   曾经为此留过一个只抬截止线的 markTurn——实测两者行为完全一致，已删。）
  resetTurn() {
    this.finalizedText = "";
    this.partialText = "";
    this.turnCutoffMs = this.maxEndTime;
  }

  close() {
    this.closed = true;
    this.ready = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try { this.ws.close(); } catch (e) {}
    }
  }
}
