import {
  Emitter, MAX_HISTORY, MAX_HISTORY_BYTES, randHex, b64encode, b64decode,
  utf8ToB64, b64ToUtf8, splitByUtf8Bytes,
  MAX_TEXT_CHARS, TEXT_PART_BYTES, SYNC_PART_BYTES, MAX_TEXT_PARTS, MAX_SYNC_PARTS,
  TEXT_PART_TTL_MS, MAX_TEXT_PENDING, NO_ICE_CONNECT_TIMEOUT_MS,
} from './util.js';
import { deriveRoomKey, importRoomKey, unwrapRoomKey } from './crypto.js';
import { relayCtrl, parseRelay } from './net.js';

export class RoomState extends Emitter {
  constructor(net, mesh, self, nick) {
    super();
    this.net = net;
    this.mesh = mesh;
    this.self = self;
    this.nick = nick;
    this.rid = '';
    this.history = [];
    this.seen = new Set();
    this.bytes = 0;
    this.members = new Map();
    this.host = '';
    this.private = false;
    this.salt = '';
    this.wsOnly = false;
    this.syncParts = new Map();
    this.textParts = new Map();   // 长文本分片重组：sid -> { parts, total, meta, ts }
    this.frameEncryption = true; // 默认加密；init 后按是否私有房决定，公开房跳过应用层帧加密
    this.keyBytes = null;       // 会话密钥原文，房主生成 / 新成员解包或经 P2P 同步得到
    this.expectedKeyFrom = '';  // 只接受指定 peer 下发的 key_sync
    this.keyRetry = 0;
    this.keyTimer = 0;
    this.stalled = false;   // 仅无外部 ICE 服务器时使用的短超时标记
    this.stallTimer = 0;

    mesh.on('ctrl', (from, obj) => this.onCtrl(from, obj).catch(e => console.warn('[room] ctrl', e)));
    mesh.on('ready', () => this.updateWsOnly());
    mesh.on('failed', () => this.updateWsOnly());
    // net 是全局单例，离房时必须注销，否则多次进出会累积监听器并误处理 relay 帧。
    this._offRelay = net.on('relay', m => this.onRelay(m).catch(e => console.warn('[room] relay', e)));
    this._offRelayData = net.on('relay_data', m => {
      if (!this.members.has(m.from)) return; // 拒绝非本房间成员注入数据
      let u8;
      try { u8 = b64decode(m.bin); } catch { return; }
      this.mesh.relayIngest(m.from, m.k, u8);
    });
    this._offRelayPause = net.on('relay_pause', m => this.mesh.pauseRelay(m.ms));
  }

  init(joined) {
    this.rid = joined.rid;
    this.name = joined.name;
    this.private = joined.private;
    // 公开房固定跳过应用层帧加密（WebRTC 的 DTLS 仍保护链路），
    // 省掉每片一次 crypto.subtle；会话密钥仍保留供房主改密码时包装。
    this.frameEncryption = !!joined.private;
    this.salt = joined.salt;
    this.host = joined.host;
    if (joined.nick) this.nick = joined.nick; // 服务端保证房间内唯一后的最终昵称
    this.members.clear();
    this.members.set(this.self, { id: this.self, nick: this.nick, sameLan: true, self: true });
    for (const p of joined.peers || []) {
      this.members.set(p.id, { id: p.id, nick: p.nick, sameLan: p.sameLan });
    }
    this.scheduleStall();
    this.emit('members', this.memberList());
  }

  // 采用会话密钥原文：全生命周期不变，故房主改密码时已连接成员无需任何动作。
  async adoptKey(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return;
    this.keyBytes = bytes;
    this.mesh.setKey(this.frameEncryption ? await importRoomKey(bytes) : null);
    clearTimeout(this.keyTimer);
    this.expectedKeyFrom = '';
    this.keyRetry = 0;
    this.emit('keyready');
  }

  // 加入房间时拿到密钥：私有房用密码解包 encKey；公开房向 syncFrom 索取。
  // 返回 true 表示密钥已就绪，调用方即可请求历史。
  async applyJoinedKey(joined, password) {
    if (joined.encKey) {
      let frame;
      try { frame = JSON.parse(joined.encKey); } catch { return false; }
      if (!password) return false;
      const kek = await deriveRoomKey(password, joined.salt);
      await this.adoptKey(await unwrapRoomKey(kek, frame));
      return !!this.keyBytes;
    }
    if (joined.syncFrom) this.requestKey(joined.syncFrom);
    return false;
  }

  requestKey(peerId) {
    if (!peerId || this.keyBytes) return;
    this.expectedKeyFrom = peerId;
    this.keyRetry = 0;
    this.sendKeyReq(peerId);
  }

  // ctrl 通道可能还没建好，sendTo 会缓存帧；再加重试兜底。
  sendKeyReq(peerId) {
    if (this.keyBytes || this.keyRetry > 3) return;
    this.keyRetry++;
    this.sendTo(peerId, { t: 'key_req' }, { plain: true }).catch(() => {});
    clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => {
      if (!this.keyBytes && this.rid) this.sendKeyReq(peerId);
    }, 1500);
  }

  memberList() {
    const links = new Map(this.mesh.list().map(p => [p.id, p]));
    return [...this.members.values()].map(m => ({
      ...m,
      link: m.self ? 'SELF' : (this.wsOnly ? 'RELAY' : (links.get(m.id)?.link || 'connecting')),
      ready: m.self || this.wsOnly || !!links.get(m.id)?.ready,
    }));
  }

  addMember(peer) {
    this.members.set(peer.id, { id: peer.id, nick: peer.nick, sameLan: peer.sameLan });
    this.mesh.addPeer(peer.id, peer.nick, peer.sameLan);
    this.scheduleStall();
    this.updateWsOnly();
    this.emit('members', this.memberList());
    this.emit('system', `${peer.nick} 加入了房间`);
  }

  removeMember(id) {
    const m = this.members.get(id);
    this.members.delete(id);
    this.mesh.removePeer(id);
    this.updateWsOnly();
    this.emit('members', this.memberList());
    if (m) this.emit('system', `${m.nick} 离开了房间`);
  }

  setHost(id) {
    this.host = id;
    this.emit('members', this.memberList());
  }

  setNick(id, nick) {
    const m = this.members.get(id);
    if (m) m.nick = nick;
    if (id === this.self) this.nick = nick;
    this.emit('members', this.memberList());
  }

  // 模式由服务端下发的 ICE 配置决定：
  //  - 未配置任何 STUN/TURN（noIceServers）：跨网不可能打洞，给内网直连留一个
  //    短窗口，超时即切服务器中继，避免 ICE 长期停在 connecting 干等。
  //  - 配置了 STUN/TURN：不启用抢跑定时器，完全交给 ICE 协商；只有 ICE 明确
  //    失败（failed/disconnected/closed）才落到最后一档 WS 兜底。
  scheduleStall() {
    clearTimeout(this.stallTimer);
    this.stalled = false;
    if (!this.mesh.ice?.noIceServers) return;
    this.stallTimer = setTimeout(() => {
      this.stalled = true;
      this.updateWsOnly();
    }, NO_ICE_CONNECT_TIMEOUT_MS);
  }

  updateWsOnly() {
    const peers = this.mesh.list();
    const down = peers.length > 0 && peers.every(p =>
      p.link === 'failed' || p.link === 'disconnected' || p.link === 'closed');
    const stalled = !!this.mesh.ice?.noIceServers && this.stalled &&
      peers.length > 0 && peers.every(p => !p.ready);
    const next = down || stalled;
    if (next !== this.wsOnly) {
      this.wsOnly = next;
      this.mesh.setRelayMode(next);
      this.emit('wsonly', next);
      this.emit('members', this.memberList());
    }
  }

  async broadcast(obj, opts = {}) {
    if (this.wsOnly) {
      const frame = opts.plain ? obj : await this.mesh.encode(obj);
      for (const id of this.members.keys()) {
        if (id !== this.self) relayCtrl(this.net, id, frame);
      }
      return;
    }
    await this.mesh.broadcast(obj, '', opts);
  }

  async sendTo(id, obj, opts = {}) {
    if (this.wsOnly) {
      relayCtrl(this.net, id, opts.plain ? obj : await this.mesh.encode(obj));
      return;
    }
    await this.mesh.sendTo(id, obj, opts);
  }

  makeItem(extra) {
    return {
      id: `${this.self}:${randHex(8)}`,
      ts: Date.now(),
      from: this.self,
      nick: this.nick,
      ttl: 2,
      ...extra,
    };
  }

  addHistory(item) {
    if (this.seen.has(item.id)) return false;
    this.seen.add(item.id);
    this.history.push(item);
    this.bytes += JSON.stringify(item).length;
    this.trimHistory();
    return true;
  }

  // 条数与容量共用一套裁剪口径，历史同步合并后也必须走这里。
  trimHistory() {
    while (this.history.length > MAX_HISTORY || this.bytes > MAX_HISTORY_BYTES) {
      const old = this.history.shift();
      if (!old) break;
      this.bytes -= JSON.stringify(old).length;
    }
  }

  async sendText(text) {
    if (!text) return;
    if (text.length > MAX_TEXT_CHARS) throw new Error(`文本最多 ${MAX_TEXT_CHARS} 字`);
    const item = this.makeItem({ t: 'chat', text });
    this.addHistory(item);
    this.emit('message', item);
    await this.broadcastChat(item);
  }

  // 单帧放得下就走原来的 chat 帧；放不下则把文本转 base64（纯 ASCII，JSON 转义
  // 不再膨胀，也不会切断代理对）后按字节切成多个 chat_part，接收端重组为同一条消息。
  // 服务端只做 relay 转发，业务层完全不感知分片。
  async broadcastChat(item) {
    const frameBytes = new TextEncoder().encode(JSON.stringify(item)).length;
    if (frameBytes <= TEXT_PART_BYTES) {
      await this.broadcast(item);
      return;
    }
    const parts = splitByUtf8Bytes(utf8ToB64(item.text), TEXT_PART_BYTES);
    if (parts.length > MAX_TEXT_PARTS) throw new Error('文本过长，请精简后再发送');
    const head = {
      t: 'chat_part', sid: item.id, total: parts.length,
      id: item.id, ts: item.ts, from: item.from, nick: item.nick, ttl: item.ttl,
    };
    for (let i = 0; i < parts.length; i++) {
      await this.broadcast({ ...head, part: i, data: parts[i] });
    }
  }

  async sendFileOffer(meta) {
    const item = this.makeItem({ t: 'file_offer', file: meta });
    this.addHistory(item);
    this.emit('message', item);
    await this.broadcast(item);
  }

  async onCtrl(from, obj) {
    if (!obj || !obj.t) return;
    if (obj.t === 'key_req') {
      if (this.keyBytes) {
        await this.sendTo(from, { t: 'key_sync', key: b64encode(this.keyBytes) }, { plain: true });
      }
      return;
    }
    if (obj.t === 'key_sync') {
      // 只接受加入时服务端指定的 syncFrom，避免任意成员注入密钥。
      if (from === this.expectedKeyFrom && !this.keyBytes && obj.key) {
        await this.adoptKey(b64decode(obj.key));
        await this.requestSync(from); // 密钥就绪后再拉历史，否则密文无法解开
      }
      return;
    }
    if (obj.t === 'sync_req') {
      await this.replyHistory(from);
      this.emit('ctrl', from, obj);
      return;
    }
    if (obj.t === 'sync_res') {
      this.onSyncRes(from, obj);
      return;
    }
    if (obj.t === 'chat_part') {
      await this.onChatPart(from, obj);
      return;
    }
    if (obj.t === 'chat' || obj.t === 'file_offer') {
      // 仅在首次收到时做有限跳转发，避免全连接网格里产生消息风暴。
      if (obj.id && this.addHistory(obj)) {
        this.emit('message', obj);
        if (obj.ttl > 0 && !this.wsOnly) {
          await this.mesh.broadcast({ ...obj, ttl: obj.ttl - 1 }, from);
        }
      }
    }
    this.emit('ctrl', from, obj);
  }

  async onRelay(m) {
    const frame = parseRelay(m);
    if (!frame) return;
    try {
      const obj = await this.mesh.decode(frame);
      if (obj) await this.onCtrl(m.from, obj);
    } catch { /* 密钥不一致或密文损坏 */ }
  }

  // 丢弃超时的半包并限制并发会话数；活跃会话会被移到 Map 末尾，不会被误删。
  pruneParts(map) {
    const now = Date.now();
    for (const [k, e] of map) if (now - e.ts > TEXT_PART_TTL_MS) map.delete(k);
    while (map.size > MAX_TEXT_PENDING) map.delete(map.keys().next().value);
  }

  async onChatPart(from, obj) {
    const o = obj;
    if (typeof o.sid !== 'string' || !o.sid || o.sid.length > 64 ||
        !Number.isInteger(o.part) || !Number.isInteger(o.total) ||
        o.total < 1 || o.total > MAX_TEXT_PARTS ||
        o.part < 0 || o.part >= o.total ||
        typeof o.data !== 'string' || o.data.length > TEXT_PART_BYTES ||
        this.seen.has(o.sid)) return;

    // 同一条消息的分片可能经不同 peer 转发过来，只按 sid 聚合，不按直接发送者分表。
    this.pruneParts(this.textParts);
    let e = this.textParts.get(o.sid);
    if (!e) e = { parts: new Array(o.total), total: o.total, meta: o, ts: Date.now() };
    if (e.total !== o.total) return;              // total 不一致视为损坏
    if (e.parts[o.part] !== undefined) return;    // 重复分片不再转发，避免消息风暴
    e.parts[o.part] = o.data;
    e.ts = Date.now();
    this.textParts.delete(o.sid);
    this.textParts.set(o.sid, e);

    // 与单帧 chat 一样做有限跳转发，保证非全直连的网格成员也能收齐分片。
    if (Number.isFinite(o.ttl) && o.ttl > 0 && !this.wsOnly) {
      await this.mesh.broadcast({ ...o, ttl: o.ttl - 1 }, from);
    }
    if (e.parts.filter(p => p !== undefined).length !== e.total) return;
    this.textParts.delete(o.sid);

    let text;
    try { text = b64ToUtf8(e.parts.join('')); } catch { return; }
    if (!text || text.length > MAX_TEXT_CHARS) return;
    const m = e.meta;
    const item = {
      t: 'chat', id: o.sid, ts: m.ts || Date.now(),
      from: m.from || from, nick: m.nick || from, ttl: 0, text,
    };
    if (!this.addHistory(item)) return;
    this.emit('message', item);
    this.emit('ctrl', from, item);
  }

  async requestSync(peerId) {
    if (!peerId) return;
    await this.sendTo(peerId, { t: 'sync_req' });
  }

  async replyHistory(target) {
    // 先转 base64（纯 ASCII），再按 UTF-8 字节切：中文 1 码元 = 3 字节，按 slice
    // 的码元数切会在私有房加密 + WS 兜底二次 base64 后超出服务端 64KB relay 上限；
    // 直接切 JSON 源码还会在重新 stringify 时被二次转义放大。base64 两者都规避。
    let recent = this.history;
    let parts = splitByUtf8Bytes(utf8ToB64(JSON.stringify(recent)), SYNC_PART_BYTES);
    // 极端情况下宁可少同步几条最新历史，也不发超过接收端上限的帧数。
    while (parts.length > MAX_SYNC_PARTS && recent.length > 1) {
      recent = recent.slice(1);
      parts = splitByUtf8Bytes(utf8ToB64(JSON.stringify(recent)), SYNC_PART_BYTES);
    }
    if (!parts.length) parts.push('[]');
    const sid = randHex(8);
    for (let i = 0; i < parts.length; i++) {
      await this.sendTo(target, { t: 'sync_res', sid, part: i, total: parts.length, data: parts[i] });
    }
  }

  onSyncRes(from, obj) {
    if (!obj || typeof obj.sid !== 'string' ||
        !Number.isInteger(obj.part) || !Number.isInteger(obj.total) ||
        obj.total < 1 || obj.total > MAX_SYNC_PARTS ||
        obj.part < 0 || obj.part >= obj.total ||
        typeof obj.data !== 'string' || obj.data.length > SYNC_PART_BYTES) return;
    this.pruneParts(this.syncParts);
    const key = `${from}:${obj.sid}`;
    let e = this.syncParts.get(key);
    if (!e) e = { parts: new Array(obj.total), total: obj.total, ts: Date.now() };
    if (e.total !== obj.total) return;
    e.parts[obj.part] = obj.data;
    e.ts = Date.now();
    this.syncParts.delete(key);
    this.syncParts.set(key, e);
    if (e.parts.filter(p => p !== undefined).length !== e.total) return;
    this.syncParts.delete(key);
    let items;
    try { items = JSON.parse(b64ToUtf8(e.parts.join(''))); } catch { return; }
    if (!Array.isArray(items)) return;
    // 历史中的文件只保留卡片元数据，本体不缓存（Q5）。
    for (const it of items) if (it.t === 'file_offer') it.expired = true;
    const merged = this.history.concat(items.filter(i => i && i.id && !this.seen.has(i.id)));
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    this.history = merged.slice(-MAX_HISTORY);
    this.bytes = this.history.reduce((n, i) => n + JSON.stringify(i).length, 0);
    this.trimHistory();
    this.seen = new Set(this.history.map(i => i.id));
    this.emit('history', this.history);
  }

  reset() {
    this._offRelay?.();
    this._offRelayData?.();
    this._offRelayPause?.();
    clearTimeout(this.stallTimer);
    this.stalled = false;
    this.mesh.closeAll();
    this.mesh.setKey(null);
    clearTimeout(this.keyTimer);
    this.keyBytes = null;
    this.expectedKeyFrom = '';
    this.keyRetry = 0;
    this.history = [];
    this.seen.clear();
    this.bytes = 0;
    this.members.clear();
    this.syncParts.clear();
    this.textParts.clear();
    this.wsOnly = false;
    this.rid = '';
  }
}
