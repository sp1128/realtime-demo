// 能量 VAD。判断"现在有没有人在说话"，只做这一件事。
//
// 为什么不靠 ASR 告诉我们：ASR 出字要经过网络往返 + 模型解码，最快也得 200~400ms，
// 而打断必须在 100ms 量级响应，等 ASR 就晚了。所以轮次和打断都由这个 VAD 触发，
// ASR 只负责"说了什么"，不负责"什么时候说的"。
//
// 输入是 24kHz PCM16，按 20ms 一帧算 RMS，跟自适应噪声底比。
// 噪声底是自己长出来的：没人说话时慢慢跟随环境音，所以空调、风扇这类稳态噪声
// 会被自动抬进底噪里，不需要手工调阈值。

import { EventEmitter } from "events";

const FRAME_MS = 20;

export class Vad extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sampleRate = opts.sampleRate || 24000;
    this.frameSize = Math.round((this.sampleRate * FRAME_MS) / 1000);

    // 判定为"有人说话"需要 RMS 超过噪声底的多少倍。
    // AI 正在说话时改走回声模式（见 setGuard），免提泄音不会一直被当成插话
    this.ratio = opts.ratio || 2.6;
    // 绝对下限。全静音环境下噪声底会趋近 0，只靠倍数会把一点点电流声也当人声
    this.floor = opts.floor || 0.008;

    // 连续多少帧有声才算开口。40ms 能跟上正常说话，还能滤掉键盘脉冲
    this.startFrames = opts.startFrames || 2;
    // 连续多少帧安静才算说完。电话里 380ms 左右接得上，再大就发木
    this.endFrames = opts.endFrames || 19;

    this.noiseFloor = 0.01;
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.guard = 1; // 兼容旧逻辑：非回声模式时的额外倍数
    this.startFramesGuard = opts.startFramesGuard || 5; // 回声模式下约 100ms，太长会觉得打不断
    // 免提时扬声器漏进麦是持续能量，不能拿安静时的底噪去比。
    // echoMode 下把泄音本身当成底，只有明显比泄音更响才算插话
    this.echoMode = false;
    this.echoFloor = 0.01;
    this.echoRatio = opts.echoRatio || 1.7;
    this.echoHoldoff = 0;
    this.tail = new Float32Array(0);
    this.lastRms = 0;
  }

  // AI 开口/闭嘴时调这个。on=true 进入回声模式：跟着播放泄音抬底，而不是死抬倍数
  setGuard(on) {
    this.echoMode = !!on;
    this.guard = on ? 1.5 : 1;
    if (on) {
      this.echoFloor = Math.max(this.noiseFloor, this.lastRms, 0.01);
      // 头几帧让 echoFloor 先跟上扬声器，避免一开口就把泄音当成插话
      this.echoHoldoff = 6;
    } else {
      this.echoHoldoff = 0;
    }
  }

  push(int16) {
    const n = this.tail.length + int16.length;
    const x = new Float32Array(n);
    x.set(this.tail, 0);
    for (let i = 0; i < int16.length; i++) x[this.tail.length + i] = int16[i] / 32768;

    let off = 0;
    while (off + this.frameSize <= n) {
      this._frame(x.subarray(off, off + this.frameSize));
      off += this.frameSize;
    }
    this.tail = x.slice(off);
  }

  _frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.lastRms = rms;

    let threshold;
    if (this.echoMode) {
      // 泄音变响时跟上（扬声器突然变大），变轻时慢降（句间空隙别把阈值掉下去）
      if (!this.speaking) {
        if (rms > this.echoFloor) this.echoFloor = this.echoFloor * 0.55 + rms * 0.45;
        else this.echoFloor = this.echoFloor * 0.92 + rms * 0.08;
      }
      threshold = Math.max(this.floor, this.echoFloor * this.echoRatio, this.noiseFloor * this.ratio);
    } else {
      threshold = Math.max(this.floor, this.noiseFloor * this.ratio) * this.guard;
    }

    if (this.echoHoldoff > 0) {
      this.echoHoldoff--;
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      return;
    }

    const voiced = rms > threshold;

    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
    } else {
      this.silentRun++;
      this.voicedRun = 0;
      // 只在没人说话时更新噪声底，否则人声会把底噪拉高，越说越听不见
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    }

    const need = this.echoMode ? this.startFramesGuard : this.startFrames;
    if (!this.speaking && this.voicedRun >= need) {
      this.speaking = true;
      this.emit("start");
    } else if (this.speaking && this.silentRun >= this.endFrames) {
      this.speaking = false;
      this.emit("end");
    }
  }

  // 当前已经安静了多久（毫秒）。编排层用它做"静音够久就提交这一轮"的判断
  silentMs() {
    return this.silentRun * FRAME_MS;
  }

  reset() {
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.tail = new Float32Array(0);
  }
}
