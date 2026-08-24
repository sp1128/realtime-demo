// 链路体检：完全不经过本项目的服务，用裸 net + tls 直接量两件事——
//   1. 经你的代理，能不能连上 api.openai.com（LLM 那一跳）
//   2. 不经代理，能不能直连 openspeech.bytedance.com（火山 ASR / TTS 两跳）
//
// 为什么不能只看 CONNECT 是否返回 200：
// Clash 这类代理收到 CONNECT 会立刻回 "200 Connection established"，
// 这时它根本还没去拨上游。真正的成败要等到隧道里的 TLS 握手才暴露出来。
// 所以这里一定要走完 TLS 才算数。
//
// 火山那一跳单独测，是因为它最容易被配错：把 HTTPS_PROXY 设成全局代理之后，
// 国内的流量绕一圈出境再回来，延迟能从 30ms 变成 300ms，
// 而且完全不报错——只是每句话都慢，很难往这上面想。
//
// 用法：npm run check-proxy
import "dotenv/config";
import net from "net";
import tls from "tls";
import { URL } from "url";

const ROUNDS = 8;
const TIMEOUT = 8000;

// 经代理走一次完整的 CONNECT + TLS
function viaProxy(proxy, host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect(Number(proxy.port), proxy.hostname);
    let settled = false;
    const done = (ok, text) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (e) {}
      resolve({ ok, text, ms: Date.now() - t0 });
    };
    const timer = setTimeout(
      () => done(false, `⏱️ ${TIMEOUT}ms 超时，卡在 TLS —— 代理答应了但没能连上上游`),
      TIMEOUT,
    );

    sock.on("error", (e) => {
      clearTimeout(timer);
      done(false, `❌ 连不上代理本身: ${e.message}`);
    });
    sock.on("connect", () =>
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
    );
    sock.once("data", (d) => {
      const line = d.toString().split("\r\n")[0];
      const tConnect = Date.now() - t0;
      if (!line.includes("200")) {
        clearTimeout(timer);
        return done(false, `❌ 代理拒绝了 CONNECT: ${line}`);
      }
      const s = tls.connect({ socket: sock, servername: host }, () => {
        clearTimeout(timer);
        done(true, `✅ CONNECT ${tConnect}ms + TLS ${Date.now() - t0 - tConnect}ms`);
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        done(false, `❌ TLS 失败: ${e.message}`);
      });
    });
  });
}

// 不经代理，直接 TLS
function direct(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, text) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch (e) {}
      resolve({ ok, text, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done(false, `⏱️ ${TIMEOUT}ms 超时`), TIMEOUT);
    const s = tls.connect({ host, port: 443, servername: host }, () => {
      clearTimeout(timer);
      done(true, `✅ TLS ${Date.now() - t0}ms`);
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      done(false, `❌ ${e.message}`);
    });
  });
}

async function run(label, probe, rounds = ROUNDS) {
  console.log(`\n🔍 ${label}，走完 TLS 才算成功，共 ${rounds} 次\n`);
  let ok = 0;
  const times = [];
  for (let i = 1; i <= rounds; i++) {
    const r = await probe();
    if (r.ok) {
      ok++;
      times.push(r.ms);
    }
    console.log(`  第 ${String(i).padStart(2)} 次  ${r.text}`);
    if (i < rounds) await new Promise((res) => setTimeout(res, 600));
  }
  const rate = (ok / rounds) * 100;
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  console.log(
    `  → 成功率 ${ok}/${rounds}（${rate.toFixed(0)}%）${avg ? `，平均 ${avg.toFixed(0)}ms` : ""}`,
  );
  return { rate, avg };
}

// ---- 火山：国内直连，两跳语音全靠它 ----
const volc = await run("直连 openspeech.bytedance.com:443（火山 ASR / TTS）", () =>
  direct("openspeech.bytedance.com"),
);

// ---- OpenAI：LLM 那一跳 ----
const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
let openai;
if (raw) {
  const proxy = new URL(raw);
  openai = await run(`经 ${proxy.origin} 连 api.openai.com:443（LLM）`, () =>
    viaProxy(proxy, "api.openai.com"),
  );
} else {
  openai = await run("直连 api.openai.com:443（LLM，没配代理）", () => direct("api.openai.com"));
}

// ---- 结论 ----
console.log(`\n──────── 结论 ────────`);

if (volc.rate < 100) {
  console.log("❌ 火山连不稳。这两跳是语音的命根子，它不通整个通话就是哑的。");
  console.log("   最常见的原因是代理被设成了全局：火山是国内服务，不该走代理。");
  console.log("   本项目只给 LLM 那一跳挂 agent，但如果你在系统层面开了全局代理，这里也会被绕进去。");
} else if (volc.avg > 300) {
  console.log(`⚠️ 火山能连但慢（${volc.avg.toFixed(0)}ms）。国内直连正常应该在 100ms 以内。`);
  console.log("   八成是被系统级全局代理绕出境了，关掉全局模式改成规则模式。");
} else {
  console.log(`✅ 火山直连正常（${volc.avg.toFixed(0)}ms），语音那两跳没问题。`);
}

if (openai.rate === 100 && openai.avg < 3000) {
  console.log(`✅ OpenAI 可达（${openai.avg.toFixed(0)}ms），LLM 那一跳没问题。`);
} else if (openai.rate >= 80) {
  console.log("⚠️ OpenAI 偶尔连不上。表现是某几轮 AI 干脆不接话，页面会报 LLM 错误。");
  console.log("   换个代理节点再跑一次，直到成功率 100%。");
} else {
  console.log("❌ OpenAI 基本连不上，AI 一句话都说不出来。");
  console.log("   去代理客户端里换节点，再跑一次这个脚本。");
}

if (openai.avg > 1500) {
  console.log(
    `\n💡 OpenAI 这一跳握手 ${openai.avg.toFixed(0)}ms，首字延迟会明显偏高。` +
      "\n   换个更近的节点最有效；实在不行就把 LLM 也换成国内模型（改 .env 里的 LLM_MODEL 和接口地址）。",
  );
}
