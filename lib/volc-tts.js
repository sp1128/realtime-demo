// 火山引擎「双向流式语音合成」客户端。
// 选这个接口而不是 HTTP 单向流式，图的就是"一个 session 内可以反复追加文本"：
// LLM 吐一句我们就 TaskRequest 一句，音色、语速、气口在整段里是连续的，
// 不会像"一句一个请求"那样每句开头都重新起调，听上去一顿一顿的。
//
// 帧格式跟 ASR 不一样，不要照抄：
//   header(4) + event(int32) + [sessionIdLen(uint32) + sessionId] + payloadSize(uint32) + payload
// 连接级事件（1/2/50/51/52）不带 sessionId，会话级事件都带。

import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  buildHeader,
  parseHeader,
  int32be,
  uint32be,
  MSG_FULL_CLIENT,
  MSG_AUDIO_ONLY_SERVER,
  MSG_ERROR,
  FLAG_WITH_EVENT,
  SERIAL_JSON,
  SERIAL_RAW,
  COMPRESS_NONE,
} from "./protocol.js";

const TTS_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";

// 事件码。客户端发的和服务端回的混在同一个编号空间里
export const EV_START_CONNECTION = 1;
export const EV_FINISH_CONNECTION = 2;
export const EV_CONNECTION_STARTED = 50;
export const EV_CONNECTION_FAILED = 51;
export const EV_CONNECTION_FINISHED = 52;
export const EV_START_SESSION = 100;
export const EV_FINISH_SESSION = 102;
export const EV_SESSION_STARTED = 150;
export const EV_SESSION_FINISHED = 152;
export const EV_SESSION_FAILED = 153;
export const EV_TASK_REQUEST = 200;
export const EV_TTS_SENTENCE_START = 350;
export const EV_TTS_SENTENCE_END = 351;
export const EV_TTS_RESPONSE = 352;
// 字级时间戳的事件码是 364，不是紧挨着 352 的那几个数字——实测出来的，别按规律猜
export const EV_TTS_SUBTITLE = 364;

// 这几个事件是连接级的，帧里没有 sessionId 段
const NO_SESSION_EVENTS = new Set([
  EV_START_CONNECTION,
  EV_FINISH_CONNECTION,
  EV_CONNECTION_STARTED,
  EV_CONNECTION_FAILED,
  EV_CONNECTION_FINISHED,
]);

export class VolcTts extends EventEmitter {
  constructor(opts) {
    super();
    this.appKey = opts.appKey;
    this.accessKey = opts.accessKey;
    // 2.0 代的资源号是 seed-tts-2.0 这种形式，跟 1.0 的 volc.service_type.xxxxx
    // 完全不是一套写法。声音复刻用 seed-icl-2.0
    this.resourceId = opts.resourceId || "seed-tts-2.0";
    this.speaker = opts.speaker;
    this.sampleRate = opts.sampleRate || 24000;
    this.speechRate = opts.speechRate ?? 0;
    this.uid = opts.uid || "realtime-demo";
    // 开了才有字级时间戳（TTSSubtitle 事件）。打断时靠它把 AI 那句话
    // 精确截在客户听到的那个字上，比按音频时长比例估算准得多
    this.subtitle = opts.subtitle !== false;
    // 整通电话共用一个 section_id，TTS 会据此保留跨轮的对话历史，
    // 让前后几轮的语气和节奏连贯，而不是每轮都重新起调
    this.sectionId = opts.sectionId || randomUUID();
    // 合成模型档位。默认不发这个字段，让服务端用自己的默认值。
    //
    // 实测过一轮（精品音色 + seed-tts-2.0 资源号），结论：
    //   不发                    OK
    //   seed-tts-2.0-standard   OK   文档写的默认值，唯一确认可用的
    //   seed-icl-2.0            45000001 InvalidModel
    //   seed-tts-2.0-lite/-pro  同上
    //   seed-icl-2.0-standard   同上
    //
    // 第三行是最容易踩的坑：**别把资源号填到 model 里**。
    // 用哪一代复刻是靠请求头 X-Api-Resource-Id 决定的
    // （seed-icl-1.0 / seed-icl-2.0），跟这个字段是两回事。
    //
    // 文档说"仅当 speaker 是复刻音色时需指定此参数"却没给可选值枚举，
    // 所以这里留空即不发。等开通复刻后如果合成报错，再来这里填。
    // 另外文档提到：一旦指定 model，就不能再用语音指令 context_texts
    this.model = opts.model || "";
    this.ws = null;
    this.sessionId = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(TTS_URL, {
        headers: {
          // 旧版控制台的鉴权头在"语音合成"和"语音识别/声音复刻"两边名字不一样：
          //   语音合成   X-Api-App-Id
          //   识别/复刻  X-Api-App-Key
          // 实测只发 App-Key 也能通（服务端认），但文档写的是 App-Id。
          // 两个都带上，值一样，免得哪天服务端收紧了一起挂
          "X-Api-App-Id": this.appKey,
          "X-Api-App-Key": this.appKey,
          "X-Api-Access-Key": this.accessKey,
          "X-Api-Resource-Id": this.resourceId,
          "X-Api-Connect-Id": randomUUID(),
          // 文档标的必选。排障时火山要你报这个 ID
          "X-Api-Request-Id": randomUUID(),
          // 让服务端在 SessionFinished 里带上计费字数，通话结束时能算账
          "X-Control-Require-Usage-Tokens-Return": "*",
        },
        handshakeTimeout: 8000,
      });
      this.ws = ws;

      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      // 连上之后还要走一轮 StartConnection → ConnectionStarted 才算真通，
      // 所以 promise 不在 open 里 resolve
      this.once("connection.started", () => done());
      this.once("connection.failed", (msg) => done(new Error(msg)));

      ws.on("open", () => this._sendEvent(EV_START_CONNECTION, null, {}));
      ws.on("message", (data) => this._onMessage(data));
      ws.on("error", (err) => {
        done(err);
        if (!this.closed) this.emit("error", err);
      });
      ws.on("close", (code, reason) => {
        const why = reason ? reason.toString() : "";
        done(new Error(`TTS 连接被关闭 code=${code} ${why}`));
        if (!this.closed) this.emit("close", code);
      });
    });
  }

  // 开一轮说话。每轮一个 session，被打断就把当前 session 结掉再开新的
  startSession() {
    const sid = randomUUID();
    this.sessionId = sid;
    this._sendEvent(EV_START_SESSION, sid, {
      event: EV_START_SESSION,
      req_params: {
        ...(this.model ? { model: this.model } : {}),
        speaker: this.speaker,
        section_id: this.sectionId,
        audio_params: {
          // 直接要裸 PCM，省掉浏览器侧解码 mp3 的开销和延迟，
          // 而且能原样喂给现有的播放时间轴。官方也推荐流式场景用 pcm
          format: "pcm",
          sample_rate: this.sampleRate,
          speech_rate: this.speechRate,
          ...(this.subtitle ? { enable_subtitle: true } : {}),
        },
        // 括号里的舞台提示（"（笑）"这种）过滤掉，不然会被一字不差地念出来
        additions: JSON.stringify({ max_length_to_filter_parenthesis: 100 }),
      },
    });
    return sid;
  }

  // 往当前 session 追加一句要念的文本
  appendText(text) {
    if (!this.sessionId || !text) return;
    this._sendEvent(EV_TASK_REQUEST, this.sessionId, {
      event: EV_TASK_REQUEST,
      req_params: { text },
    });
  }

  // 结束本轮。正常说完和被打断都走这里，区别只在于要不要理会后续音频
  finishSession() {
    if (!this.sessionId) return null;
    const sid = this.sessionId;
    this.sessionId = null;
    this._sendEvent(EV_FINISH_SESSION, sid, { event: EV_FINISH_SESSION });
    return sid;
  }

  _sendEvent(event, sessionId, payloadObj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = Buffer.from(JSON.stringify(payloadObj || {}), "utf8");
    const parts = [
      buildHeader(MSG_FULL_CLIENT, FLAG_WITH_EVENT, SERIAL_JSON, COMPRESS_NONE),
      int32be(event),
    ];
    if (sessionId) {
      const sid = Buffer.from(sessionId, "utf8");
      parts.push(uint32be(sid.length), sid);
    }
    parts.push(uint32be(payload.length), payload);
    this.ws.send(Buffer.concat(parts), { binary: true });
  }

  _onMessage(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 8) return;
    const h = parseHeader(buf);
    let p = h.bodyOffset;

    if (h.msgType === MSG_ERROR) {
      const code = buf.readUInt32BE(p);
      p += 4;
      const size = buf.readUInt32BE(p);
      p += 4;
      const msg = buf.subarray(p, p + size).toString("utf8");
      this.emit("error", new Error(`TTS 报错 code=${code} ${msg}`));
      return;
    }

    const event = buf.readInt32BE(p);
    p += 4;

    // 会话级事件才有 sessionId 段。这里判断错了后面全乱套，
    // 表现是音频里混进一段 UUID 的字节噪音
    let sessionId = null;
    if (!NO_SESSION_EVENTS.has(event)) {
      const sidLen = buf.readUInt32BE(p);
      p += 4;
      sessionId = buf.subarray(p, p + sidLen).toString("utf8");
      p += sidLen;
    }

    if (p + 4 > buf.length) {
      this._dispatch(event, sessionId, null, null);
      return;
    }
    const size = buf.readUInt32BE(p);
    p += 4;
    const body = buf.subarray(p, p + size);

    if (h.msgType === MSG_AUDIO_ONLY_SERVER || h.serial === SERIAL_RAW) {
      this._dispatch(event, sessionId, null, body);
    } else {
      let json = null;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch (e) {}
      this._dispatch(event, sessionId, json, null);
    }
  }

  _dispatch(event, sessionId, json, audio) {
    switch (event) {
      case EV_CONNECTION_STARTED:
        this.emit("connection.started");
        break;
      case EV_CONNECTION_FAILED:
        this.emit(
          "connection.failed",
          (json && json.error) ||
            "TTS 建连被拒，检查 VOLC_APP_ID / VOLC_ACCESS_TOKEN / VOLC_TTS_RESOURCE_ID",
        );
        break;
      case EV_SESSION_STARTED:
        this.emit("session.started", sessionId);
        break;
      case EV_SESSION_FAILED:
        this.emit("error", new Error(`TTS 会话失败: ${JSON.stringify(json)}`));
        break;
      case EV_SESSION_FINISHED:
        // 顺带回本轮的计费字数（要在请求头里开 X-Control-Require-Usage-Tokens-Return）
        this.emit("session.finished", sessionId, json?.usage?.text_words || 0);
        break;
      case EV_TTS_SENTENCE_START:
        // 注意：这个事件的 text 是**空的**，别指望在这里拿到这句话的内容。
        // 它只是个"新句子开始了"的分隔信号，用来给音频记账划段
        this.emit("sentence.start", sessionId);
        break;
      case EV_TTS_SENTENCE_END:
        // 文本要到这里才给。打断时要按"念到哪个字"回填历史，全靠它和下面的时间戳
        this.emit("sentence.end", sessionId, (json && json.text) || "");
        break;
      case EV_TTS_RESPONSE:
        if (audio && audio.length) this.emit("audio", sessionId, audio);
        break;
      case EV_TTS_SUBTITLE:
        // words: [{word, startTime, endTime, confidence}]，时间单位是**秒**，
        // 而且是相对这一句开头的。换算成绝对位置要加上这句在整轮里的音频偏移
        if (json && Array.isArray(json.words) && json.words.length) {
          this.emit("subtitle", sessionId, json.words);
        }
        break;
      default:
        break;
    }
  }

  close() {
    this.closed = true;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._sendEvent(EV_FINISH_CONNECTION, null, {});
        this.ws.close();
      } else if (this.ws) {
        this.ws.terminate();
      }
    } catch (e) {}
  }
}
