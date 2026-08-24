// 24000Hz → 16000Hz 降采样。
//
// 为什么非要有这一步：浏览器那边采集和播放共用一个 AudioContext，开在 24000Hz
// （TTS 出来就是 24k，播放侧不用再转一道）；但火山的流式 ASR 只吃 16000Hz。
// 两个采样率对不上会怎样？不会报错，只会把语速拉快 1.5 倍变成鸭子叫，
// 识别结果全是乱码——这种错最难查，所以宁可在这里多写几行。
//
// 24000 / 16000 = 1.5，是个整齐的比例。做法是先轻度低通（把 8kHz 以上的能量压下去，
// 不然会折叠回来变成沙沙声），再线性插值取点。
// 音频包是一段一段来的，所以必须保留跨包状态：上一包末尾没用完的采样点和小数相位。

const IN_RATE = 24000;
const OUT_RATE = 16000;

export class Downsampler {
  constructor(inRate = IN_RATE, outRate = OUT_RATE) {
    this.ratio = inRate / outRate;
    // 上一包末尾剩下的采样点，下一包要接着它算，否则每个包边界都会咔一下
    this.carry = new Float32Array(0);
    // 下一个输出点落在输入序列的什么位置（带小数）。从 1 起步是给低通留左邻居
    this.pos = 1;
  }

  // 输入 Int16Array（24kHz 单声道），输出 Buffer（16kHz PCM16 小端，可直接送 ASR）
  process(int16) {
    const n = this.carry.length + int16.length;
    const x = new Float32Array(n);
    x.set(this.carry, 0);
    for (let i = 0; i < int16.length; i++) {
      x[this.carry.length + i] = int16[i] / 32768;
    }

    // 三抽头低通 [1,2,1]/4，要求取点位置左右各有一个邻居
    const lp = (i) => (x[i - 1] + 2 * x[i] + x[i + 1]) / 4;

    const out = [];
    let p = this.pos;
    while (Math.floor(p) + 2 < n) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const v = lp(i0) * (1 - frac) + lp(i0 + 1) * frac;
      out.push(v);
      p += this.ratio;
    }

    // 已经用不到的采样点扔掉，但要往前留一个做下一轮的左邻居
    const keepFrom = Math.max(0, Math.floor(p) - 1);
    this.carry = x.slice(keepFrom);
    this.pos = p - keepFrom;

    const buf = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      let s = Math.round(out[i] * 32768);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      buf.writeInt16LE(s, i * 2);
    }
    return buf;
  }

  reset() {
    this.carry = new Float32Array(0);
    this.pos = 1;
  }
}
