// 这个项目统一用 npm。
//
// 拦的不是"跑脚本"，而是"装依赖"：pnpm dev / yarn dev 只是代跑 scripts，
// 不会动 node_modules，随便用都行。真正的问题是 pnpm install / yarn install ——
// 它会照着 package.json 重新解析依赖、生成自己的 lockfile，
// 于是仓库里同时躺着 package-lock.json 和 pnpm-lock.yaml，
// 两边解析出的版本迟早对不上，而且这种问题在别人机器上才爆。
//
// npm 会把包管理器写进 npm_config_user_agent，形如 "npm/10.8.2 node/v22.20.0 ..."。
// preinstall 在依赖装之前跑，所以这里不能 import 任何第三方包。
const ua = process.env.npm_config_user_agent || "";
const who = ua.split(" ")[0] || "(识别不出)";

if (ua && !ua.startsWith("npm/")) {
  console.error(`
❌ 这个项目用 npm 装依赖，检测到的是：${who}

   请改用：  npm install

   （只是想跑起来的话，pnpm dev / yarn dev 都行，那不会动 node_modules。
     被拦的只有 install。）
`);
  process.exit(1);
}
