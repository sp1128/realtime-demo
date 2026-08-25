import "dotenv/config";
import express from "express";
import path from "path";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CallSession } from "./lib/session.js";
import { lanIPv4, ensureDevCerts } from "./lib/lan.js";

// ============================================================
// 架构：Streaming STT → Streaming LLM → Streaming TTS，支持打断
//
//   浏览器采音(24k PCM) → 本地服务
//                          ├─ VAD          判断谁在说话、什么时候接话、要不要打断
//                          ├─ 火山流式 ASR  听懂说了什么（降到 16k 再送）
//                          ├─ DeepSeek LLM 流式生成回复（国内直连，一般不用代理）
//                          └─ 火山流式 TTS  边生成边合成，同一会话内连续追加
//                          → PCM 原路回浏览器播放
//
// 为什么不用 OpenAI Realtime 的端到端语音：实测下来语气和指令遵循都不稳，
// 而且整条链路是个黑盒，出了问题只能调 VAD 参数碰运气。拆成三段之后，
// 每一段都能单独换供应商、单独看中间结果、单独调参，代价是首字慢 0.5 秒左右。
//
// 三段都是国内服务：火山 ASR/TTS + DeepSeek。不要开系统级全局代理，
// 否则国内流量绕出境再回来，延迟从几十毫秒变成几百毫秒，而且完全不报错。
// ============================================================

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY_URL) console.log(`🌐 LLM 经代理访问 DeepSeek: ${PROXY_URL}`);

// 每条连接现开一个 agent，不共用。
// 共用实例时连接池的账会随通话次数越积越脏，表现是"头几次能连，后面卡住"
function makeProxyAgent() {
  return PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- 配置 ----------------

// 火山语音的鉴权。控制台「语音技术」里拿，ASR 和 TTS 共用同一对
const VOLC_APP_ID = process.env.VOLC_APP_ID;
const VOLC_ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN;

// 资源号要跟你实际开通的套餐对上，填错会在 WebSocket 握手阶段就被拒。
// 两种拒法含义不同：400 = 这个号根本不存在，403 = 号存在但你没开通。
//
// 注意 1.0 和 2.0 的号是两套完全不同的写法，不要混：
//   ASR 2.0  volc.seedasr.sauc.duration / .concurrent
//   ASR 1.0  volc.bigasr.sauc.duration  / .concurrent
const ASR_RESOURCE_ID = process.env.VOLC_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration";
//   TTS 2.0  seed-tts-2.0（声音复刻是 seed-icl-2.0）
//   TTS 1.0  volc.service_type.10029
const TTS_RESOURCE_ID = process.env.VOLC_TTS_RESOURCE_ID || "seed-tts-2.0";

// 页面允许在这几个之间切。复刻音色（S_ 开头那种）必须配 seed-icl-2.0，
// 拿 seed-tts-2.0 去合成复刻音色是不认的。
// 白名单而不是原样透传：这个值会直接进到发给火山的请求头里
const ALLOWED_TTS_RESOURCES = new Set([
  "seed-tts-2.0", // 官方精品音色
  "seed-icl-2.0", // 声音复刻 2.0，需要单独开通
  "seed-icl-1.0", // 声音复刻 1.0 字符版
  "seed-icl-1.0-concurr", // 声音复刻 1.0 并发版
  "volc.service_type.10029", // 1.0 时代的号，留个后路
]);

// 合成模型档位，对应 req_params.model。留空就不发这个字段，用服务端默认值。
// 实测只有 seed-tts-2.0-standard 合法，其它写法一律 45000001 InvalidModel。
//
// 别拿它切复刻版本——那是上面的资源号决定的，填错直接 InvalidModel
const TTS_MODEL = process.env.VOLC_TTS_MODEL || "";

// 音色 ID，在火山控制台「音色详情」里复制。
// 音色和模型版本是绑死的：_uranus_bigtts / saturn_ 开头的是 2.0 音色，
// _moon_bigtts 那批是 1.0 的，拿到 seed-tts-2.0 上用会失败
const TTS_SPEAKER = process.env.VOLC_TTS_SPEAKER || "zh_female_vv_uranus_bigtts";
// 语速偏移，0 是原速。范围大致 -50~100，负数更慢更沉稳
const TTS_SPEECH_RATE = Number(process.env.VOLC_TTS_SPEECH_RATE || -5);

// 通话里会出现的人名、公司名、行话，逗号分隔。喂给 ASR 能显著减少同音字错误。
// 下面这几个是话术里的高频词，.env 里的会并进来
const DEFAULT_HOTWORDS = ["量化", "回测", "风控", "盯盘", "期货", "策略", "信号", "数字资产"];
const HOTWORDS = [
  ...new Set([
    ...DEFAULT_HOTWORDS,
    ...(process.env.ASR_HOTWORDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];

// LLM。DeepSeek 国内直连，模型可以按需换（deepseek-chat / deepseek-reasoner）
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const LLM_HOST = process.env.LLM_HOST || "api.deepseek.com";
const LLM_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
// 单轮输出上限。这是兜底闸门，主要还得靠提示词约束长度
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 220);
const TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.8);
// 保留最近几轮对话。越长首 token 越慢，电话场景不需要记住二十分钟前的细节
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 12);

// ---- 轮次与打断的旋钮 ----
// 静音多久算客户说完。小了客户喘口气就被抢白，大了接话发木
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 380);
// 判定"有人在说话"需要超过噪声底的多少倍。环境嘈杂往上调（3.5~5）
const VAD_RATIO = Number(process.env.VAD_RATIO || 2.6);
// 静音之后再等一下再提交，让 ASR 的最后一段结果落地，否则会丢掉最后两三个字
const COMMIT_DELAY_MS = Number(process.env.COMMIT_DELAY_MS || 180);
// 确认式打断：VAD 响了之后，最多等多久去确认"真有人在说话"
const BARGE_CONFIRM_MS = Number(process.env.BARGE_CONFIRM_MS || 1000);
const BARGE_MIN_CHARS = Number(process.env.BARGE_MIN_CHARS || 2);
// 短于这个长度的转写不做回声比对，一律当成客户真在说话。
// 选择题抢答（「期货」「股票」）就长在 AI 正念的那句里，一比对就被吃掉
const BARGE_ECHO_MIN_CHARS = Number(process.env.BARGE_ECHO_MIN_CHARS || 5);
// ASR 内部静音多久定稿。跟 VAD 对齐，提交时二遍识别的结果才赶得上
const ASR_END_WINDOW_MS = Number(process.env.ASR_END_WINDOW_MS || 400);

// 接通后由 AI 先开口（外呼场景需要），false 则等客户先说话
const AUTO_GREET = process.env.AUTO_GREET !== "false";
const GREET_DELAY_MS = Number(process.env.GREET_DELAY_MS || 400);
// 说完后客户一直不接话：先追问，再还不说话就道别收线
const IDLE_NUDGE_MS = Number(process.env.IDLE_NUDGE_MS || 8000);
const IDLE_BYE_MS = Number(process.env.IDLE_BYE_MS || 10000);

// ---------------- 启动前检查 ----------------

const missing = [];
const keyLooksPlaceholder =
  !LLM_API_KEY || /你的|填在这里|changeme|xxx/i.test(LLM_API_KEY);
if (keyLooksPlaceholder) missing.push("DEEPSEEK_API_KEY");
if (!VOLC_APP_ID) missing.push("VOLC_APP_ID");
if (!VOLC_ACCESS_TOKEN) missing.push("VOLC_ACCESS_TOKEN");
if (missing.length) {
  console.error(`❌ .env 里缺少：${missing.join("、")}`);
  console.error("   复制 .env.example 为 .env，按里面的说明填。");
  console.error("   DeepSeek 密钥在 platform.deepseek.com 的 API Keys 里拿。");
  console.error("   火山那两个在 console.volcengine.com 的「语音技术」控制台里拿。");
  process.exit(1);
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const httpServer = http.createServer(app);

let connSeq = 0;

// 把底层报错翻译成能照着做的提示。
// ttsResource 传进来是为了把 403 说准：用复刻音色时十有八九是没开通复刻服务，
// 而不是 .env 里的资源号填错了——两者的解法完全不同，说岔了会让人白查半天
function explain(msg, ttsResource) {
  const s = String(msg);
  if (/401|Unauthorized/.test(s))
    return `${s}｜鉴权被拒：DeepSeek 看 DEEPSEEK_API_KEY，火山看 VOLC_APP_ID / VOLC_ACCESS_TOKEN`;
  // 复刻的资源号有好几个（seed-icl-2.0 / 1.0 / 1.0-concurr），一律按"没开通复刻"解释。
  // 用复刻音色时 403 十有八九是这个原因，而不是 .env 里的号填错了
  if (/403/.test(s) && /^seed-icl/.test(ttsResource || ""))
    return `${s}｜复刻音色用不了：这个账号没开通「豆包声音复刻模型」（当前用的资源号 ${ttsResource}）。去 console.volcengine.com/speech/app 开通并复刻出音色后再用，音色 ID 通常是 S_ 开头`;
  if (/403/.test(s))
    return `${s}｜没有权限：火山那边多半是资源号跟实际开通的套餐对不上，检查 VOLC_ASR_RESOURCE_ID / VOLC_TTS_RESOURCE_ID`;
  if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET/.test(s))
    return PROXY_URL
      ? `${s}｜连不上。火山和 DeepSeek 都是国内直连；代理 ${PROXY_URL} 可能把国内流量绕出去了`
      : `${s}｜连不上。DeepSeek 一般国内直连即可；若环境必须走代理，在 .env 里配 HTTPS_PROXY`;
  return s;
}

function onClient(client, req) {
  const tag = `[#${++connSeq}]`;
  const startedAt = Date.now();

  // 音色可以由页面在连接时指定（?speaker=xxx），没带就用 .env 里的默认值。
  // 放在 URL 上而不是连上以后再发一条消息，是因为 CallSession 在这一刻就要建好，
  // 晚一步 TTS 会话已经用默认音色开出去了。
  // 白名单校验：这个值会直接进到发给火山的请求里，不能让页面随便塞东西
  let speaker = TTS_SPEAKER;
  let ttsResource = TTS_RESOURCE_ID;
  let ttsModel = TTS_MODEL;
  try {
    const qs = new URL(req.url, "http://localhost").searchParams;
    const q = qs.get("speaker");
    // 复刻音色的 ID 里可能有中划线，所以放开 -
    if (q && /^[A-Za-z0-9_-]{1,256}$/.test(q)) speaker = q;
    else if (q) console.warn(`${tag} 音色名不合法，已忽略: ${q.slice(0, 40)}`);

    const r = qs.get("resource");
    if (r && ALLOWED_TTS_RESOURCES.has(r)) ttsResource = r;
    else if (r) console.warn(`${tag} 资源号不在白名单里，已忽略: ${r.slice(0, 40)}`);

    const m = qs.get("model");
    if (m && /^[A-Za-z0-9._-]{1,64}$/.test(m)) ttsModel = m;
    else if (m) console.warn(`${tag} 模型档位不合法，已忽略: ${m.slice(0, 40)}`);
  } catch (e) {}

  console.log(
    `${tag} 浏览器已接入（音色 ${speaker} / ${ttsResource}` +
      `${ttsModel ? " / " + ttsModel : ""}），正在连接火山 ASR / TTS…`,
  );

  const send = (obj) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  };

  const agent = makeProxyAgent();
  const session = new CallSession({
    volcAppId: VOLC_APP_ID,
    volcToken: VOLC_ACCESS_TOKEN,
    asrResourceId: ASR_RESOURCE_ID,
    ttsResourceId: ttsResource,
    ttsModel,
    speaker,
    speechRate: TTS_SPEECH_RATE,
    hotwords: HOTWORDS,
    llmKey: LLM_API_KEY,
    llmModel: LLM_MODEL,
    llmHost: LLM_HOST,
    proxyAgent: agent,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    historyTurns: HISTORY_TURNS,
    vadSilenceMs: VAD_SILENCE_MS,
    vadRatio: VAD_RATIO,
    commitDelayMs: COMMIT_DELAY_MS,
    bargeConfirmMs: BARGE_CONFIRM_MS,
    bargeMinChars: BARGE_MIN_CHARS,
    bargeEchoMinChars: BARGE_ECHO_MIN_CHARS,
    asrEndWindowMs: ASR_END_WINDOW_MS,
    autoGreet: AUTO_GREET,
    greetDelayMs: GREET_DELAY_MS,
    idleNudgeMs: IDLE_NUDGE_MS,
    idleByeMs: IDLE_BYE_MS,
  });

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    session.stop();
    if (agent && typeof agent.destroy === "function") agent.destroy();
    if (client.readyState === WebSocket.OPEN) client.close();
  };

  // ---- 编排器 → 浏览器 ----
  session.on("ready", () => {
    console.log(`${tag} 链路已打通，耗时 ${Date.now() - startedAt}ms`);
    send({
      type: "ready",
      model: LLM_MODEL,
      speaker,
      ttsResource,
      ttsModel,
      proxy: PROXY_URL || null,
    });
  });
  session.on("state", (s) => send({ type: "state", state: s }));
  session.on("stt.partial", (text) => send({ type: "stt.partial", text }));
  session.on("stt.final", (text) => {
    console.log(`${tag} 🧑 ${text}`);
    send({ type: "stt.final", text });
  });
  session.on("llm.delta", (text) => send({ type: "llm.delta", text }));
  session.on("llm.done", (text) => {
    console.log(`${tag} 🤖 ${text}`);
    send({ type: "llm.done", text });
  });
  // 音频量大，转成 base64 塞 JSON 里跟其它事件走同一条通道，
  // 客户端就不用区分二进制帧和文本帧了
  session.on("tts.audio", (buf) => send({ type: "tts.audio", audio: buf.toString("base64") }));
  session.on("playback.pause", () => send({ type: "playback.pause" }));
  session.on("playback.resume", () => send({ type: "playback.resume" }));
  session.on("playback.flush", () => send({ type: "playback.flush" }));
  session.on("tts.drain", () => send({ type: "tts.drain" }));
  session.on("log", (text) => send({ type: "log", text }));
  session.on("hangup", () => {
    console.log(`${tag} 通话结束（对方一直没接话）`);
    send({ type: "hangup" });
    setTimeout(shutdown, 400);
  });
  // 一次故障往往会连着报三条（上游 error、上游 close、start() 的 reject），
  // 内容其实是同一件事。只把第一条送到页面上，后面的留在服务端日志里就行
  let errored = false;
  session.on("error", (msg) => {
    const hint = explain(msg, ttsResource);
    console.error(`${tag} ❌ ${hint}`);
    if (errored) return;
    errored = true;
    send({ type: "error", message: hint });
  });

  // ---- 浏览器 → 编排器 ----
  client.on("message", (data, isBinary) => {
    if (isBinary || closed) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (evt.type === "audio.append") {
      const buf = Buffer.from(evt.audio, "base64");
      // Buffer 的字节偏移不一定是 2 的倍数，直接 new Int16Array(buf.buffer) 会抛错，
      // 必须用 byteOffset 开视图
      const n = buf.length >> 1;
      const int16 = new Int16Array(n);
      for (let i = 0; i < n; i++) int16[i] = buf.readInt16LE(i * 2);
      session.pushAudio(int16);
    } else if (evt.type === "playback.report") {
      session.reportPlayed(evt.playedMs || 0);
    } else if (evt.type === "playback.ended") {
      session.onPlaybackEnded();
    } else if (evt.type === "probe") {
      // 页面上的「测线路」按钮。单独开一条连接，不碰麦克风，
      // 直接量 LLM → TTS 这一段的首字延迟和供给率
      session.probe();
    }
  });

  client.on("error", (err) => {
    console.error(`${tag} 浏览器连接出错: ${err.message}`);
    shutdown();
  });
  client.on("close", () => {
    console.log(`${tag} 浏览器已断开`);
    shutdown();
  });

  session.start().catch((err) => {
    const hint = explain(err.message, ttsResource);
    console.error(`${tag} ❌ 启动失败: ${hint}`);
    if (!errored) {
      errored = true;
      send({ type: "error", message: hint });
    }
    shutdown();
  });
}

function attachRealtime(srv) {
  const wss = new WebSocketServer({ server: srv, path: "/ws" });
  wss.on("connection", onClient);
}

attachRealtime(httpServer);

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const lanIps = lanIPv4();

function printChain() {
  console.log(`✅ 本机打开: http://localhost:${PORT}`);
  console.log(
    `   链路 火山ASR(${ASR_RESOURCE_ID}) → ${LLM_MODEL} → 火山TTS(${TTS_RESOURCE_ID} / ${TTS_SPEAKER})`,
  );
  console.log(
    `   轮次 静音${VAD_SILENCE_MS}ms提交（阈值${VAD_RATIO}倍底噪）｜` +
      `打断 确认式，${BARGE_CONFIRM_MS}ms内听到${BARGE_MIN_CHARS}字算数｜` +
      `ASR定稿${ASR_END_WINDOW_MS}ms`,
  );
  if (PROXY_URL) {
    console.log("   ℹ️ DeepSeek 是国内服务，代理通常没必要；开了全局代理会把火山也绕慢");
  }
}

function printPhoneUrls() {
  console.log("");
  console.log("📱 手机请用 HTTPS（自签证书，浏览器会报警，选「继续前往」）：");
  if (!lanIps.length) {
    console.log("   没找到局域网 IP。确认电脑连的是 WiFi，不是仅热点/虚拟网卡。");
  } else {
    for (const ip of lanIps) {
      console.log(`   https://${ip}:${HTTPS_PORT}`);
    }
  }
  console.log("   若打不开：Windows 防火墙放行 Node.js，或放行 TCP " + HTTPS_PORT);
}

async function start() {
  let httpsServer = null;
  try {
    const certs = await ensureDevCerts(path.join(__dirname, ".certs"), lanIps);
    httpsServer = https.createServer(certs, app);
    attachRealtime(httpsServer);
  } catch (err) {
    console.warn(`⚠️ 局域网 HTTPS 没开起来：${err.message}`);
    console.warn("   手机浏览器不给 HTTP 页面麦克风权限，同一 WiFi 体验会失败。");
  }

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(PORT, "0.0.0.0", resolve);
  });
  printChain();

  if (!httpsServer) return;
  try {
    await new Promise((resolve, reject) => {
      httpsServer.once("error", reject);
      httpsServer.listen(HTTPS_PORT, "0.0.0.0", resolve);
    });
    printPhoneUrls();
  } catch (err) {
    console.warn(`⚠️ HTTPS :${HTTPS_PORT} 没绑上：${err.message}`);
    console.warn("   电脑仍可用 http://localhost:" + PORT);
  }
}

start().catch((err) => {
  console.error("❌ 启动失败:", err.message);
  process.exit(1);
});
