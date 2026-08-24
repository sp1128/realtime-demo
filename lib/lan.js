// 局域网访问：手机和电脑同一 WiFi 时，用电脑的局域网 IP 打开页面。
// 麦克风必须在安全上下文里才给（https 或 localhost），所以给局域网单独开一份自签 HTTPS。
// selfsigned v5 是 async-only，第一次生成证书大约一两秒，之后读 .certs 缓存。

import os from "os";
import fs from "fs";
import path from "path";
import selfsigned from "selfsigned";

function rankLan(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (ip.startsWith("172.")) return 2;
  return 3;
}

export function lanIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === "IPv4" || a.family === 4;
      if (!v4 || a.internal || !a.address) continue;
      if (a.address.startsWith("169.254.")) continue;
      out.push(a.address);
    }
  }
  out.sort((a, b) => rankLan(a) - rankLan(b) || a.localeCompare(b));
  return [...new Set(out)];
}

export async function ensureDevCerts(dir, ips) {
  const hosts = ["localhost", "127.0.0.1", ...ips];
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  const metaPath = path.join(dir, "hosts.json");
  const stamp = JSON.stringify([...hosts].sort());

  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    if (fs.readFileSync(metaPath, "utf8") === stamp) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: "commonName", value: ips[0] || "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [{ name: "subjectAltName", altNames }],
  });
  if (!pems?.private || !pems?.cert) {
    throw new Error("自签证书生成失败（selfsigned 没有返回 key/cert）");
  }
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, stamp);
  return { key: pems.private, cert: pems.cert };
}
