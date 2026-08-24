// 火山引擎语音服务的二进制帧编解码。
// ASR 和 TTS 共用同一个 4 字节头，但头后面的东西完全不同：
//   ASR  : header(4) + seq(int32) + payloadSize(uint32) + payload
//   TTS  : header(4) + event(int32) + [sessionIdLen(uint32) + sessionId] + payloadSize(uint32) + payload
// 所以只有 header 这一层能共用，往下必须分开写。整数一律大端。

import zlib from "zlib";

// ---- 头部四个字节的含义 ----
// byte0 = 协议版本(高4位) | 头长度(低4位，单位是4字节，所以 1 表示头就是 4 字节)
// byte1 = 消息类型(高4位) | 类型专属标志位(低4位)
// byte2 = 序列化方式(高4位) | 压缩方式(低4位)
// byte3 = 保留位，填 0
export const PROTOCOL_VERSION = 0b0001;
export const HEADER_SIZE_4B = 0b0001;

// 消息类型
export const MSG_FULL_CLIENT = 0b0001; // 客户端发的完整请求（JSON）
export const MSG_AUDIO_ONLY_CLIENT = 0b0010; // 客户端发的纯音频
export const MSG_FULL_SERVER = 0b1001; // 服务端发的完整响应（JSON）
export const MSG_AUDIO_ONLY_SERVER = 0b1011; // 服务端发的纯音频
export const MSG_ERROR = 0b1111; // 服务端报错

// 类型专属标志位
export const FLAG_NONE = 0b0000;
export const FLAG_POS_SEQ = 0b0001; // 带正序号
export const FLAG_LAST_NO_SEQ = 0b0010; // 最后一包，不带序号
export const FLAG_NEG_SEQ = 0b0011; // 最后一包，带负序号
export const FLAG_WITH_EVENT = 0b0100; // 带 event 字段（TTS 双向流式用这个）

// 序列化与压缩
export const SERIAL_RAW = 0b0000;
export const SERIAL_JSON = 0b0001;
export const COMPRESS_NONE = 0b0000;
export const COMPRESS_GZIP = 0b0001;

export function buildHeader(msgType, flags, serial, compress) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_4B,
    (msgType << 4) | flags,
    (serial << 4) | compress,
    0x00,
  ]);
}

// 解析头部。注意 headerSize 是"4 字节的个数"，正常是 1，
// 但协议允许扩展头，所以正文起点必须按 headerSize*4 算，不能写死 4。
export function parseHeader(buf) {
  return {
    version: buf[0] >> 4,
    headerSize: buf[0] & 0x0f,
    msgType: buf[1] >> 4,
    flags: buf[1] & 0x0f,
    serial: buf[2] >> 4,
    compress: buf[2] & 0x0f,
    bodyOffset: (buf[0] & 0x0f) * 4,
  };
}

export function gzip(buf) {
  return zlib.gzipSync(buf);
}

export function gunzip(buf) {
  return zlib.gunzipSync(buf);
}

// 按压缩位决定要不要解压。服务端可能逐帧变化，不能按连接参数一刀切
export function maybeGunzip(buf, compress) {
  if (compress !== COMPRESS_GZIP || buf.length === 0) return buf;
  try {
    return zlib.gunzipSync(buf);
  } catch (e) {
    // 极少数情况下服务端标了 gzip 却发裸数据，解不开就按原样用，别把整条连接搞死
    return buf;
  }
}

export function int32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(n, 0);
  return b;
}

export function uint32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}
