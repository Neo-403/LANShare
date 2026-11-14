import {
  Emitter, hexToBytes, bytesToHex, PUSH_LOW_WATER, PUSH_HIGH_WATER,
  DIRECT_LOW_WATER, DIRECT_HIGH_WATER, DIRECT_MAX_BLOCK, DIRECT_MIN_BLOCK,
  DIRECT_BLOCK_ALIGN, DIRECT_OVERHEAD, DIRECT_PCS,
} from './util.js';
import { seal, open, sealChunk, openChunk } from './crypto.js';

const MAGIC0 = 0x53; // 'L'
const MAGIC1 = 0x4C; // 'S'
const DIRECT0 = 0x44; // 'D'
const DIRECT1 = 0x52; // 'R'
const HEADER = 18;
const BACKPRESSURE = PUSH_HIGH_WATER;

// dataN 帧：magic(2) fid(8) idx(4) len(4) payload
export function packChunk(fid, idx, payload) {
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = MAGIC0; out[1] = MAGIC1;
  out.set(hexToBytes(fid), 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(10, idx, true);
  dv.setUint32(14, payload.length, true);
  out.set(payload, HEADER);
  return out;
}

export function parseChunk(u8) {
  if (u8.length < HEADER || u8[0] !== MAGIC0 || u8[1] !== MAGIC1) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const idx = dv.getUint32(10, true);
  const len = dv.getUint32(14, true);
  const payload = u8.subarray(HEADER);
  if (payload.length !== len) return null;
  return {
    fid: bytesToHex(u8.subarray(2, 10)),
    fidBytes: u8.subarray(2, 10),
    idx, payload,
  };
}

// direct 帧：magic(2) fid(8) offset(4 LE) len(4 LE) payload。
// offset 是绝对字节偏移，接收端按它把字节追加到连续段，不需要分片索引。
export function packDirect(fid, offset, payload) {
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = DIRECT0; out[1] = DIRECT1;
  out.set(hexToBytes(fid), 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, payload.length, true);
  out.set(payload, HEADER);
  return out;
}

export function parseDirect(u8) {
  if (u8.length < HEADER || u8[0] !== DIRECT0 || u8[1] !== DIRECT1) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const offset = dv.getUint32(10, true);
  const len = dv.getUint32(14, true);
  const payload = u8.subarray(HEADER);
  if (payload.length !== len) return null;
  return {
    fid: bytesToHex(u8.subarray(2, 10)),
    fidBytes: u8.subarray(2, 10),
    offset, payload,
  };
}

async function detectLink(pc) {
  try {
    const stats = await pc.getStats();
    const byId = new Map();
    let pairId = '';
    stats.forEach(r => {
      byId.set(r.id, r);
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    if (!pairId) {
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id;
      });
    }
    const local = byId.get(byId.get(pairId)?.localCandidateId);
    const t = local?.candidateType;
    return t === 'host' ? 'LAN' : t === 'relay' ? 'TURN' : 'P2P';
  } catch { return 'P2P'; }
}

export class Mesh extends Emitter {
  constructor(net, ice, self) {
    super();
    this.net = net;
    this.ice = ice || { iceServers: [] };
    this.self = self;
    this.peers = new Map();
    this.key = null;
  }

  setKey(key) { this.key = key; }
  async encode(obj) { return this.key ? seal(this.key, obj) : obj; }
  async decode(frame) {
    return (frame && frame.t === 'enc' && this.key) ? open(this.key, frame) : frame;
  }

  list() {
    return [...this.peers.values()].map(p => ({
      id: p.id, nick: p.nick, sameLan: p.sameLan,
      link: p.link, ready: p.ready,
    }));
  }

  ready(id) { return this.peers.get(id)?.ctrl?.readyState === 'open'; }
  isBackpressured(id) {
    const chans = (this.peers.get(id)?.data || []).filter(c => c.readyState === 'open');
    if (!chans.length) return true;
    return Math.min(...chans.map(c => c.bufferedAmount)) > BACKPRESSURE;
  }

  // 流式推送的底层通道：选缓冲最小的一条，供泵连续 send。
  channelFor(id) {
    const chans = (this.peers.get(id)?.data || []).filter(c => c.readyState === 'open');
    if (!chans.length) return null;
    return chans.reduce((a, b) => (a.bufferedAmount <= b.bufferedAmount ? a : b));
  }

  // 帧已由 FileMesh 批量构造（含加密），这里只做水位检查与发送，
  // 不再 parseChunk / sealChunk / 重复打包，省掉每片 128KB 级内存拷贝。
  pushData(id, frame, highWater = BACKPRESSURE) {
    const ch = this.channelFor(id);
    if (!ch || ch.bufferedAmount > highWater) return false;
    try { ch.send(frame); return true; } catch { return false; }
  }

  // 两人直传专用通道组：无序可靠，多流并行推同一字节流。
  // 返回已打开的通道数组（空数组/不存在则视为不可用）。
  directChannelFor(id) {
    const arr = this.peers.get(id)?.direct;
    if (!arr || !arr.length) return null;
    const open = arr.filter(c => c.readyState === 'open');
    return open.length ? open : null;
  }

  pushDirect(id, frame, highWater = DIRECT_HIGH_WATER) {
    const arr = this.directChannelFor(id);
    if (!arr) return false;
    // 选缓冲最空的通道发送，让多流负载尽量均衡，整体吞吐接近单流上限 × 流数。
    let best = null, bestBuf = Infinity;
    for (const ch of arr) {
      if (ch.bufferedAmount >= highWater) continue;
      if (ch.bufferedAmount < bestBuf) { bestBuf = ch.bufferedAmount; best = ch; }
    }
    if (!best) return false;
    try { best.send(frame); return true; } catch { return false; }
  }

  // SCTP 协商后的单消息上限：把直传帧尽量做大，减少每字节的协议开销。
  maxMessageSize(id) {
    const m = this.peers.get(id)?.pcs?.[0]?.sctp?.maxMessageSize;
    return Number.isFinite(m) && m > DIRECT_OVERHEAD ? m : 256 * 1024;
  }

  directBlock(id) {
    const raw = Math.min(this.maxMessageSize(id) - DIRECT_OVERHEAD, DIRECT_MAX_BLOCK);
    const aligned = Math.floor(raw / DIRECT_BLOCK_ALIGN) * DIRECT_BLOCK_ALIGN;
    return Math.max(DIRECT_MIN_BLOCK, aligned);
  }

  addPeer(id, nick = '', sameLan = false) {
    if (id === this.self) return null;
    const old = this.peers.get(id);
    if (old) {
      if (nick) old.nick = nick;
      return old;
    }
    const p = {
      id, nick, sameLan,
      initiator: this.self < id, // 字典序小的一方发起 offer，避免 glare
      pcs: [], ctrl: null, data: [], direct: [], ready: false,
      link: 'connecting', pending: [], fail: 0,
    };
    this.peers.set(id, p);
    this.build(p);
    this.emit('peers', this.list());
    return p;
  }

  build(p) {
    const n = DIRECT_PCS;
    p.pcs = [];
    for (let i = 0; i < n; i++) {
      const pc = new RTCPeerConnection({
        iceServers: this.ice.iceServers || [],
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
      });
      const idx = i;
      pc._iceQueue = [];
      pc.onicecandidate = e => {
        this.net.send({ t: 'signal', to: p.id, data: { candidate: e.candidate ? e.candidate.toJSON() : null, pcIndex: idx } });
      };
      pc.onconnectionstatechange = () => {
        p.link = pc.connectionState === 'connected' ? 'P2P' : pc.connectionState;
        if (pc.connectionState === 'connected') {
          detectLink(pc).then(l => { p.link = l; this.emit('peers', this.list()); });
        }
        if (pc.connectionState === 'failed') this.emit('failed', p.id);
        this.emit('peers', this.list());
      };
      pc.ondatachannel = e => this.attach(p, e.channel);

      if (p.initiator) {
        // 仅主关联（i=0）承载 ctrl + data 控制面；其余关联只放一条 direct 通道，
        // 各自独立的 SCTP 关联 = 各自独立的拥塞窗口，可成倍放大两人直传吞吐。
        if (i === 0) {
          this.attach(p, pc.createDataChannel('ctrl', { ordered: true }));
          for (let k = 0; k < 3; k++) this.attach(p, pc.createDataChannel('data' + k, { ordered: true }));
        }
        this.attach(p, pc.createDataChannel('direct', { ordered: false }));
        pc.createOffer()
          .then(o => pc.setLocalDescription(o))
          .then(() => this.net.send({ t: 'signal', to: p.id, data: { sdp: pc.localDescription, pcIndex: idx } }))
          .catch(e => console.warn('[rtc] offer', e));
      }
      p.pcs.push(pc);
    }
  }

  attach(p, ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'ctrl') {
      p.ctrl = ch;
      ch.onopen = () => {
        p.ready = true;
        for (const frame of p.pending.splice(0)) {
          try { ch.send(JSON.stringify(frame)); } catch { /* 断开时丢弃 */ }
        }
        this.emit('ready', p.id);
        this.emit('peers', this.list());
      };
    } else if (ch.label.startsWith('direct')) {
      ch.bufferedAmountLowThreshold = DIRECT_LOW_WATER;
      ch.onbufferedamountlow = () => this.emit('drain', p.id);
      (p.direct ||= []).push(ch);
    } else if (ch.label.startsWith('data')) {
      // 高水位 8MB / 低水位 4MB：泵在高水位等待，drain 后补一批，
      // 形成自适应流速，不再依赖定时器节拍。
      ch.bufferedAmountLowThreshold = PUSH_LOW_WATER;
      ch.onbufferedamountlow = () => this.emit('drain', p.id);
      p.data.push(ch);
    }
    ch.onmessage = async ev => {
      if (typeof ev.data === 'string') {
        let frame;
        try { frame = JSON.parse(ev.data); } catch { return; }
        try {
          const obj = await this.decode(frame);
          if (obj) this.emit('ctrl', p.id, obj);
        } catch { /* 密钥不一致或密文损坏，丢弃 */ }
      } else {
        const u8 = new Uint8Array(ev.data);
        if (ch.label.startsWith('direct')) {
          // 直传帧由 DirectStream 解析；私有房的帧加密也在那里处理，
          // 公开房则完全零拷贝直通。并行通道按 offset 重组，对文件模型透明。
          this.emit('direct', p.id, u8);
          return;
        }
        const parsed = parseChunk(u8);
        if (!parsed) return;
        if (!this.key) {
          // 公开房跳过应用层加密：直接把收到的帧交给 FileMesh，省一次 128KB 拷贝。
          this.emit('data', p.id, u8);
          return;
        }
        let plain;
        try { plain = await openChunk(this.key, parsed.fidBytes, parsed.idx, parsed.payload); }
        catch { return; }
        this.emit('data', p.id, packChunk(parsed.fid, parsed.idx, plain));
      }
    };
    ch.onclose = () => {
      p.ready = false;
      this.emit('peers', this.list());
    };
  }

  async onSignal(from, data) {
    let p = this.peers.get(from);
    if (!p) p = this.addPeer(from);
    if (!p) return;
    const pc = p.pcs[data.pcIndex || 0];
    if (!pc) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of pc._iceQueue.splice(0)) {
          try { await pc.addIceCandidate(c); } catch { /* 过期候选 */ }
        }
        if (data.sdp.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.net.send({ t: 'signal', to: from, data: { sdp: ans, pcIndex: data.pcIndex || 0 } });
        }
      } else if (data.candidate) {
        if (!pc.remoteDescription) pc._iceQueue.push(data.candidate);
        else await pc.addIceCandidate(data.candidate);
      }
    } catch (e) { console.warn('[rtc] signal', e); }
  }

  // plain:true 用于会话密钥尚未建立的握手帧（key_req / key_sync），
  // 这类帧跳过应用层加密，但仍受 WebRTC 的 DTLS 保护。
  async broadcast(obj, except = '', opts = {}) {
    const frame = opts.plain ? obj : await this.encode(obj);
    let n = 0;
    for (const p of this.peers.values()) {
      if (p.id === except) continue;
      if (p.ctrl?.readyState === 'open') {
        try { p.ctrl.send(JSON.stringify(frame)); n++; } catch { /* 忽略 */ }
      } else p.pending.push(frame);
    }
    return n;
  }

  async sendTo(id, obj, opts = {}) {
    const frame = opts.plain ? obj : await this.encode(obj);
    const p = this.peers.get(id);
    if (!p) return false;
    if (p.ctrl?.readyState !== 'open') { p.pending.push(frame); return true; }
    try { p.ctrl.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  // 二进制分片：私有房时按 (fid, idx) 派生 nonce 做 AES-GCM，接收侧自动还原。
  async sendData(id, bytes) {
    const p = this.peers.get(id);
    const chans = (p?.data || []).filter(c => c.readyState === 'open');
    if (!chans.length) return false;
    const ch = chans.reduce((a, b) => (a.bufferedAmount <= b.bufferedAmount ? a : b));
    if (ch.bufferedAmount > BACKPRESSURE) return false;
    let out = bytes;
    if (this.key) {
      const parsed = parseChunk(bytes);
      if (!parsed) return false;
      const ct = await sealChunk(this.key, parsed.fidBytes, parsed.idx, parsed.payload);
      out = packChunk(parsed.fid, parsed.idx, ct);
    }
    // ch.send() 本身就按调用顺序同步入队，无需再串一层 Promise 链；
    // 去掉这一层 await 后每片少一次微任务，高并发时差别明显。
    try { ch.send(out); return true; } catch { return false; }
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    for (const pc of p.pcs) { try { pc.close(); } catch { /* 已关闭 */ } }
    this.peers.delete(id);
    this.emit('leave', id);
    this.emit('peers', this.list());
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}

