// 链路体检：完全不经过本项目的服务，用裸 net + tls 直接量两件事——
//   1. 不经代理，能不能直连 api.deepseek.com（LLM 那一跳）
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

// ---- DeepSeek：LLM 那一跳，国内直连 ----
const llmHost = process.env.LLM_HOST || "api.deepseek.com";
const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
let llm;
if (raw) {
  const proxy = new URL(raw);
  llm = await run(`经 ${proxy.origin} 连 ${llmHost}:443（LLM，配了代理）`, () =>
    viaProxy(proxy, llmHost),
  );
} else {
  llm = await run(`直连 ${llmHost}:443（LLM）`, () => direct(llmHost));
}

// ---- 结论 ----
console.log(`\n──────── 结论 ────────`);

if (volc.rate < 100) {
  console.log("❌ 火山连不稳。这两跳是语音的命根子，它不通整个通话就是哑的。");
  console.log("   最常见的原因是代理被设成了全局：火山和 DeepSeek 都是国内服务，不该走代理。");
  console.log("   本项目默认直连 LLM，但如果你在系统层面开了全局代理，这里也会被绕进去。");
} else if (volc.avg > 300) {
  console.log(`⚠️ 火山能连但慢（${volc.avg.toFixed(0)}ms）。国内直连正常应该在 100ms 以内。`);
  console.log("   八成是被系统级全局代理绕出境了，关掉全局模式改成规则模式。");
} else {
  console.log(`✅ 火山直连正常（${volc.avg.toFixed(0)}ms），语音那两跳没问题。`);
}

if (llm.rate === 100 && llm.avg < 1500) {
  console.log(`✅ DeepSeek 可达（${llm.avg.toFixed(0)}ms），LLM 那一跳没问题。`);
} else if (llm.rate >= 80) {
  console.log("⚠️ DeepSeek 偶尔连不上。表现是某几轮 AI 干脆不接话，页面会报 LLM 错误。");
  if (raw) console.log("   DeepSeek 是国内服务，先把 .env 里的 HTTPS_PROXY 注释掉再试直连。");
} else {
  console.log("❌ DeepSeek 基本连不上，AI 一句话都说不出来。");
  if (raw) {
    console.log("   先注释掉 HTTPS_PROXY 直连；直连也不通再考虑换节点。");
  } else {
    console.log("   检查本机网络，或在 .env 里临时加 HTTPS_PROXY 试一次。");
  }
}

if (llm.avg > 800) {
  console.log(
    `\n💡 DeepSeek 这一跳握手 ${llm.avg.toFixed(0)}ms，国内直连正常应在一两百毫秒内。` +
      "\n   八成是被系统级全局代理绕出境了；.env 里的 HTTPS_PROXY 对国内 LLM 通常没必要。",
  );
}
