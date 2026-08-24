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
    // AI 正在说话时会临时调高（见 setGuard），避免被自己漏出来的声音打断
    this.ratio = opts.ratio || 3.0;
    // 绝对下限。全静音环境下噪声底会趋近 0，只靠倍数会把一点点电流声也当人声
    this.floor = opts.floor || 0.008;

    // 连续多少帧有声才算开口。60ms 能滤掉键盘声、桌子磕碰这类脉冲
    this.startFrames = opts.startFrames || 3;
    // 连续多少帧安静才算说完。500ms 是电话场景比较稳的值，
    // 再小客户中间喘口气就被抢白，再大接话明显发木
    this.endFrames = opts.endFrames || 25;

    this.noiseFloor = 0.01;
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.guard = 1; // AI 说话期间的额外阈值倍数
    this.startFramesGuard = opts.startFramesGuard || 12; // AI 说话期间要连续 240ms
    this.tail = new Float32Array(0);
    this.lastRms = 0;
  }

  // AI 开口/闭嘴时调这个。on=true 收紧判定，专治"AI 被自己的回声打断"
  setGuard(on) {
    this.guard = on ? 2.2 : 1;
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

    const threshold = Math.max(this.floor, this.noiseFloor * this.ratio) * this.guard;
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

    const need = this.guard > 1 ? this.startFramesGuard : this.startFrames;
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
