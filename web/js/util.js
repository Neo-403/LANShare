// 128KB：远低于各浏览器 DataChannel 单消息上限（Chrome/Safari 约 256KB），
// 留出加密 tag 与协议开销余量，同时保持分片数量可控（2GB ≈ 16384 片）。
export const CHUNK_SIZE = 128 * 1024;
// 分片按 slice 流式读取、按 chunk 落 IndexedDB，文件大小上限与设备形态无关。
export const MAX_FILE = 2 * 1024 * 1024 * 1024;
export const MAX_HISTORY = 200;
// 单位与 addHistory 一致（JSON.stringify(item).length，UTF-16 码元）。
// 单条文本上限提高后，200 条长消息最多约 4M 码元，故容量给到 8M 留足余量。
export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCES = 4;

// ---- 聊天文本 ----
// 输入框单条上限（UTF-16 码元，与 textarea.maxLength 口径一致，中文算 1、emoji 算 2）。
export const MAX_TEXT_CHARS = 20000;
// 剩余字数提示阈值：剩余 <= 该值时才显示，避免平时干扰输入。
export const TEXT_HINT_LEFT = 500;
// 单个控制帧承载数据的 UTF-8 字节预算。长文本先转 base64（纯 ASCII，无 JSON 转义
// 膨胀、也不会切断代理对），再按此预算切分。最坏链路（私有房 AES-GCM + base64
// ×4/3，WS 兜底再 base64 ×4/3）下 8KB 数据最终约 15KB，远低于服务端 relay 的
// 64KB 上限，也兼容较老浏览器 16KB 的 DataChannel 单消息上限。
export const TEXT_PART_BYTES = 8 * 1024;
// 历史同步同样先转 base64 再按 UTF-8 字节分片，避免 JSON 片段二次转义膨胀。
export const SYNC_PART_BYTES = 16 * 1024;
// 单个聊天消息最多允许的分片数，防止伪造帧撑爆内存。
export const MAX_TEXT_PARTS = 512;
// 历史同步最多分片数：8M 码元缓存最坏约 24MB JSON → 32MB base64 → 约 2000 片。
export const MAX_SYNC_PARTS = 4096;
// 未凑齐的分片会话保留时长与并发上限，避免伪造帧长期占用内存。
export const TEXT_PART_TTL_MS = 60 * 1000;
export const MAX_TEXT_PENDING = 32;

// 按 UTF-8 字节数切分字符串，且不切断代理对（for...of 逐码点遍历）。
// 中文 3 字节 / emoji 4 字节，按字符数切会在私有房加密后超出单帧上限，故按字节切。
// 切点可以落在 JSON 转义序列中间：接收端按序 join('') 还原原文即可，无需对齐。
export function splitByUtf8Bytes(str, maxBytes) {
  const parts = [];
  let cur = '', used = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const n = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (used + n > maxBytes && cur) { parts.push(cur); cur = ''; used = 0; }
    cur += ch;
    used += n;
  }
  if (cur || !parts.length) parts.push(cur);
  return parts;
}
// 流式推送：每批预读/加密 32 片，靠 DataChannel 的 bufferedAmount 自调节流速。
export const PUSH_BATCH = 32;
// 水位提到 MB 级：768KB 的在途窗口太小，一旦网络抖动就反复等 drain，
// 会把连续推流切成脉冲。高低水位之间留 4MB 余量供 SCTP 持续排空。
export const PUSH_HIGH_WATER = 8 * 1024 * 1024;
export const PUSH_LOW_WATER = 4 * 1024 * 1024;
export const DRAIN_FALLBACK_MS = 16;
// 接收端按批写 IndexedDB，避免每片一个事务。
export const WRITE_BATCH = 32;
// 进度位图广播间隔（8MB 一次），减少控制帧争用拥塞窗口。
export const PROGRESS_EVERY = 64;
export const MONITOR_MS = 1000;
// 停滞阈值要比 file_got 同步周期长，否则每次重分工都会重发刚收到的片。
export const STALL_MS = 8000;
export const GOT_EVERY = 3;
// 进度持久化：正常传输节流写入，页面隐藏/冻结时立即写入。
export const SAVE_EVERY_MS = 1000;
export const RESUME_KEY = 'lanshare.resume';

// 两人直传：连续字节流 + 按段落盘，没有分片位图、多源分工、逐片请求。
// 单条 SCTP 消息有上限，所以物理上仍分帧；但接收端只按 offset 顺序追加到段，
// 断点续传只需一个「已完成段数」，不需要位图。
export const DIRECT_SEGMENT = 4 * 1024 * 1024;
// 两人直传并行关联数。单条 SCTP 关联在浏览器里吞吐上限约 70~90Mbps，且同一
// RTCPeerConnection 内的所有通道共享同一个拥塞窗口，单纯开多条通道并不能提速。
// 真正的解法是建立多条独立 PeerConnection（各自独立的 SCTP 关联 = 各自独立的拥塞
// 窗口），每条关联放一条 direct 通道，发送端按缓冲最空的那条推，接收端仍按绝对
// offset 重组，对文件模型完全透明（仍然「不切片」）。
// 实测：3 条约 12~14MB/s，5 条约 15~16MB/s 后基本饱和（受限于 SCTP-over-WiFi
// 聚合与接收端帧处理），再加关联收益很小，却要多一次 ICE/STUN 握手、内存与耗电。
export const DIRECT_PCS = 5;
export const DIRECT_MAX_BLOCK = 1024 * 1024;
export const DIRECT_MIN_BLOCK = 64 * 1024;
export const DIRECT_BLOCK_ALIGN = 16 * 1024;
export const DIRECT_OVERHEAD = 64;      // 帧头 18B + AES-GCM tag 16B + 余量
export const DIRECT_SEQ_UNIT = 1024;   // nonce 序号按绝对偏移派生，续传不重用 nonce
// 直传每条关联的发送缓冲水位。5 条独立关联时 8MB/条 = 40MB 在途，暂停/取消后
// 这些已灌进 SCTP 的数据仍会继续投递数秒，造成「停不下来」。LAN 的带宽时延积
// 很小（16MB/s × 几 ms ≈ 几十 KB），2MB/条 足以填满链路，故大幅下调以让控制即时生效。
export const DIRECT_HIGH_WATER = 2 * 1024 * 1024;
export const DIRECT_LOW_WATER = 1 * 1024 * 1024;

// ---- 无 TURN 时的 WS 数据中继 ----
// 与服务端 relayDataRawMax 一致：单个 base64 帧解码后不得超过 192KB。
// 文件分片 128KB + 帧头 + AES-GCM tag 仍在范围内；直传块另收窄到 64KB。
export const RELAY_DATA_MAX = 192 * 1024;
export const RELAY_DIRECT_BLOCK = 64 * 1024;
// 直接读 WebSocket.bufferedAmount 做背压。不限速时水位放宽，
// 避免高速链路下频繁进入等待把连续推流切成脉冲；它只做背压，不限制带宽。
export const RELAY_HIGH_WATER = 4 * 1024 * 1024;
export const RELAY_LOW_WATER = 1024 * 1024;
// 服务端下发 ice.noIceServers=true（未配置任何外部 STUN/TURN）时，跨网不可能打洞。
// 只给内网 host candidate 直连留一个短窗口，超时即切服务器 WS 中继。
// 配置了 STUN/TURN 时不启用此定时器，交给 ICE 自行协商，避免抢在 TURN 前面。
export const NO_ICE_CONNECT_TIMEOUT_MS = 2500;

export class Emitter {
  constructor() { this._m = new Map(); }
  on(k, fn) {
    if (!this._m.has(k)) this._m.set(k, new Set());
    this._m.get(k).add(fn);
    return () => this.off(k, fn);
  }
  off(k, fn) { this._m.get(k)?.delete(fn); }
  emit(k, ...args) {
    for (const fn of this._m.get(k) || []) {
      try { fn(...args); } catch (e) { console.error('[emit]', k, e); }
    }
  }
}

export function randHex(n) {
  const b = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(b);
  return bytesToHex(b).slice(0, n);
}

export function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function b64encode(u8) {
  let s = '';
  const N = 0x8000;
  for (let i = 0; i < u8.length; i += N) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + N));
  }
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToB64(str) {
  return b64encode(new TextEncoder().encode(str));
}

export function b64ToUtf8(str) {
  return new TextDecoder().decode(b64decode(str));
}

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function isWifi() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c || !c.type) return true; // 浏览器不暴露类型时按可用处理
  return c.type === 'wifi' || c.type === 'ethernet' || c.type === 'none';
}

export function newBits(count) { return new Uint8Array(Math.ceil(count / 8)); }
export function bitGet(bits, i) { return !!(bits[i >> 3] & (1 << (i & 7))); }
export function bitSet(bits, i) { bits[i >> 3] |= (1 << (i & 7)); }
export function bitsAllOnes(count) {
  const b = newBits(count);
  for (let i = 0; i < count; i++) bitSet(b, i);
  return b;
}

// 通过临时 RTCPeerConnection 的 host candidate 猜测本机私网 /24。
// Chrome 常返回 mDNS .local 名（无法解析），此时返回空串由服务端按出口 IP 分组。
export async function detectLAN() {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    let settle;
    const found = new Promise(resolve => { settle = resolve; });
    let done = false;
    const finish = v => { if (!done) { done = true; settle(v); } };
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate || '');
      if (m) finish(m[1] + '/24');
    };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    const timer = setTimeout(() => finish(''), 1500);
    const lan = await found;
    clearTimeout(timer);
    pc.close();
    return lan;
  } catch { return ''; }
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
