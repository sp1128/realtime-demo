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
    this.endWindowMs = opts.endWindowMs || 800;
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
        result_type: "single", // 增量返回，不要每次都把全文重发一遍
        // 不开这个就拿不到 utterances，只有一个笼统的 text，
        // 定稿判断和去重全部失效。别看它像个可选的调试开关
        show_utterances: true,
        // 静音超过这个时长就直接判停输出 definite。
        // 跟我们自己 VAD 的判停时长对齐，让 ASR 的定稿正好赶在提交之前落地
        end_window_size: this.endWindowMs,
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

    // 火山会给两种东西：result.text 是当前这一段的全文，
    // result.utterances 是切好的句子，带 definite 标记表示"这句定稿了"。
    // 定稿的句子搬进 finalizedText，没定稿的留在 partialText 继续变。
    const utts = Array.isArray(result.utterances) ? result.utterances : [];

    if (utts.length) {
      let added = "";
      for (const u of utts) {
        if (typeof u.end_time === "number" && u.end_time > this.maxEndTime) {
          this.maxEndTime = u.end_time;
        }
        if (!u.definite || !u.text) continue;
        // 上一轮的迟到定稿，扔掉
        if (typeof u.end_time === "number" && u.end_time <= this.turnCutoffMs) continue;
        // 用时间戳当身份。同一句在后续帧里被重发时时间戳不变，据此跳过
        const key = `${u.start_time}-${u.end_time}`;
        if (this.seenDefinite.has(key)) continue;
        this.seenDefinite.add(key);
        added += u.text;
      }
      if (added) {
        this.finalizedText += added;
        this.emit("final", added, this.finalizedText);
      }
      this.partialText = utts
        .filter((u) => !u.definite)
        .map((u) => u.text || "")
        .join("");
    } else {
      // 没给 utterances 就只能拿整段 text 当中间结果
      this.partialText = result.text || "";
    }
    this.emit("partial", this.text());
  }

  // 当前这一轮听到的全部内容（已定稿 + 还在变的）
  text() {
    return this.finalizedText + this.partialText;
  }

  // 一轮对话处理完，把文本清零，但连接和声学上下文都留着。
  // seenDefinite 不清：清了的话上一轮的句子会被当成新的重新收进来
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
