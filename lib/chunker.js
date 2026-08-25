// 分句切分器：把 LLM 吐出来的 token 流切成适合送 TTS 的一句一句。
//
// 这一层直接决定听感，两个极端都不能要：
//   等整段生成完再合成 → 首字延迟 1 秒以上，电话里像死机
//   每来几个字就送一次 → TTS 拿不到完整语义，断句稀碎、语调乱飘
//
// 折中办法是按标点切，并且第一句故意放宽——第一句出得越早，
// 整通电话的"反应快不快"就靠它。后面的句子可以攒长一点，语调更自然。

// 句末标点：见到就切，不看长度
const HARD = new Set(["。", "！", "？", "；", "!", "?", ";", "\n", "…"]);
// 句中标点：攒够字数才切
const SOFT = new Set(["，", "、", "：", ",", ":", "—"]);

export class SentenceChunker {
  constructor(opts = {}) {
    // 第一句在软标点处切的最小长度。
    //
    // 这里曾经是 2，想法是"开头那两三个字尽早送出去"。实测证明是反效果：
    // 火山 TTS 收到不足 5 个字的片段**根本不开始合成**，它在等更多文本
    //   「嗯。」   不 finishSession → 3.5 秒内没有音频
    //   「嗯，好的。」同样不 finish  → 339ms 出声
    // 也就是说切出「嗯，」不但没提前，反而要一直等到第二块到达凑够长度。
    // 现在设 6，保证第一块自己就够 TTS 开工。
    this.firstMin = opts.firstMin || 6;
    // 后续句子在软标点处切的最小长度。这时候首字延迟已经付过了，
    // 攒长一点让 TTS 拿到完整语义，语调更自然
    this.min = opts.min || 8;
    // 硬上限。有些模型会一路逗号写到底，不设上限就等于没切
    this.max = opts.max || 40;
    // 第一句的硬上限单独设，而且小得多：开场就来一句三十几个字不带标点的，
    // 按 max 等下去首字延迟会很难看
    this.firstMax = opts.firstMax || 16;
    this.buf = "";
    this.count = 0; // 已经吐出去几句，用来区分"第一句"
  }

  // 喂入一段增量文本，返回这次能切出来的完整句子数组（可能为空）
  push(delta) {
    if (!delta) return [];
    const out = [];
    for (const ch of sanitize(delta)) {
      this.buf += ch;
      const first = this.count === 0;
      const limit = first ? this.firstMin : this.min;
      const cap = first ? this.firstMax : this.max;
      if (HARD.has(ch)) {
        if (this.buf.trim()) out.push(this._take());
      } else if (SOFT.has(ch) && this.buf.length >= limit) {
        out.push(this._take());
      } else if (this.buf.length >= cap) {
        out.push(this._take());
      }
    }
    return out;
  }

  // 流结束时把余下的半句吐出来，别让最后几个字消失
  flush() {
    if (!this.buf.trim()) {
      this.buf = "";
      return null;
    }
    return this._take();
  }

  _take() {
    const s = this.buf;
    this.buf = "";
    this.count++;
    return s;
  }

  reset() {
    this.buf = "";
    this.count = 0;
  }
}

// LLM 偶尔会带出 markdown 记号、表情、括号里的舞台提示。
// 这些东西 TTS 会照着念出来（"星号星号"），电话里非常出戏，念之前先清掉。
export function sanitize(text) {
  return text
    .replace(/[*_`#>]/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
}
