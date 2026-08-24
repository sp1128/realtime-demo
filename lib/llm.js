// DeepSeek 流式对话。协议跟 OpenAI Chat Completions 兼容，走 node:https
// 手写 SSE，不用 SDK。https.request 能直接吃可选的代理 agent。
//
// 默认打 api.deepseek.com，国内直连，首 token 通常比走境外的 OpenAI 快。
// 延迟能被 TTS 的播放时间盖掉一部分——第一句话一出来就开始播，
// 后面的 token 是在客户听第一句的时候悄悄生成的。

import https from "https";

export class LlmStream {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseHost = opts.host || "api.deepseek.com";
    this.agent = opts.agent;
    this.temperature = opts.temperature ?? 0.8;
    this.maxTokens = opts.maxTokens ?? 220;
    this.req = null;
    this.aborted = false;
  }

  // messages: [{role, content}]
  // onDelta: 每来一段文本调一次
  // 返回完整文本；被 abort 时返回已经拿到的部分
  run(messages, onDelta) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      });

      const req = https.request(
        {
          host: this.baseHost,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(body),
          },
          agent: this.agent,
          timeout: 20000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errBody = "";
            res.on("data", (c) => (errBody += c));
            res.on("end", () =>
              reject(new Error(`LLM 返回 ${res.statusCode}: ${errBody.slice(0, 300)}`)),
            );
            return;
          }

          let full = "";
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            // SSE 用空行分隔事件。半条事件要留在 buf 里等下一片，
            // 直接按 \n 切会把 JSON 拆成两半解析失败
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of raw.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                let json;
                try {
                  json = JSON.parse(data);
                } catch (e) {
                  continue;
                }
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) {
                  full += delta;
                  onDelta(delta);
                }
              }
            }
          });
          res.on("end", () => resolve(full));
          res.on("error", (err) => {
            // abort 时 socket 会抛错，这不是故障，把已有的文本正常交出去
            if (this.aborted) resolve(full);
            else reject(err);
          });
        },
      );

      this.req = req;
      req.on("error", (err) => {
        if (this.aborted) resolve("");
        else reject(err);
      });
      req.on("timeout", () => {
        req.destroy(new Error("LLM 请求超时"));
      });
      req.end(body);
    });
  }

  // 被打断时调。生成还在继续就是在烧钱，而且后面的 token 已经没人要了
  abort() {
    this.aborted = true;
    if (this.req) {
      try {
        this.req.destroy();
      } catch (e) {}
    }
  }
}
