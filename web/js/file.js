import {
  Emitter, CHUNK_SIZE, MAX_FILE, MAX_SOURCES, PUSH_BATCH, PUSH_HIGH_WATER,
  PROGRESS_EVERY, MONITOR_MS, STALL_MS, GOT_EVERY, DRAIN_FALLBACK_MS,
  SAVE_EVERY_MS, WRITE_BATCH,
  randHex, newBits, bitGet, bitSet,
  bitsAllOnes, isWifi, b64encode, b64decode, fmtSize, hexToBytes,
} from './util.js';
import { packChunk, parseChunk } from './rtc.js';
import { sealChunk } from './crypto.js';
import {
  putChunks, getChunks, clearFile, assemble,
  saveProgress, loadProgress, deleteProgress, readSegmentBytes,
} from './store.js';
import { DirectStream } from './direct.js';

const newStats = () => ({
  startedAt: Date.now(), window: [], rate: 0, peak: 0, dupes: 0,
  refills: 0, sources: 0, stalled: false, lastProgressAt: Date.now(),
  sentPieces: 0, readMs: 0, encMs: 0, restoredBytes: 0,
});

// 两种传输模式：
// direct（房间内两人）：一次订阅、连续字节流，无分片位图 / 多源分工 / 逐片请求。
// mesh（三人及以上）：多源取模分工的分片 P2P 分发，供种者可以边下边传。
export class FileMesh extends Emitter {
  constructor(mesh, room, opts = {}) {
    super();
    this.mesh = mesh;
    this.room = room;
    this.opts = opts;
    this.transfers = new Map();
    this.pumps = new Map();        // `${接收端}:${fid}` -> job
    this.drainWaiters = new Map(); // peerId -> resolve
    this.pendingBits = new Map();  // 早于历史卡片到达的位图
    this.writeQueue = new Map();   // 未落盘分片
    this.writing = new Map();      // 正在落盘分片（仍可供种）
    this.writeTimers = new Map();
    this.tickCount = 0;
    this.lastActive = false;
    this.direct = new DirectStream(mesh, room, this);
    this.timer = setInterval(() => this.tick(), MONITOR_MS);
    mesh.on('data', (from, u8) => this.onData(from, u8).catch(e => console.warn('[file] chunk', e)));
    mesh.on('drain', id => this.wakeDrain(id));
    mesh.on('ready', id => { this.announceTo(id); this.rebalanceAll(); });
    mesh.on('leave', id => {
      this.stopPumpsFrom(id);
      this.drainWaiters.get(id)?.();
      for (const t of this.transfers.values()) {
        if (t.peerBits.delete(id)) { t.sourceCount = this.countSources(t); this.notify(t, true); }
      }
      this.rebalanceAll();
    });
  }

  get(fid) { return this.transfers.get(fid); }

  announceTo(id) {
    if (!id || id === this.mesh.self) return;
    for (const t of this.transfers.values()) {
      if (!t.bits.some(v => v !== 0)) continue;
      this.room.sendTo(id, { t: 'file_have', fid: t.fid, bits: b64encode(t.bits) }).catch(() => {});
    }
  }

  prunePendingBits() {
    const now = Date.now();
    for (const [fid, m] of this.pendingBits) {
      for (const [id, pb] of m) if (now - pb.ts > 60000) m.delete(id);
      if (!m.size) this.pendingBits.delete(fid);
    }
  }

  notify(t, force = false) {
    const now = Date.now();
    if (!force && now - (t.lastNotify || 0) < 100) return;
    t.lastNotify = now;
    this.emit('update', t);
  }

  canSeed(t) {
    if (t.role !== 'seeder') return isWifi() || !!this.opts.seedOnCellular?.();
    // seeder 仅在「正在供种(running)或可继续供新对等端(done)」时供种：
    // - idle：发送方已取消，避免接收方重收复活泵（#2）
    // - paused：发送方已暂停，泵循环里的 canSeed 检查必须让出，否则接收方会「继续下载」（#3）
    if (t.state === 'idle' || t.state === 'paused') return false;
    return isWifi() || !!this.opts.seedOnCellular?.();
  }

  expectedLen(t, i) { return Math.min(CHUNK_SIZE, t.meta.size - i * CHUNK_SIZE); }

  // 房间成员数 <= 2 时走直连字节流；第三人加入后新建的传输才启用 P2P 分发。
  chooseMode() {
    const members = this.room.members?.size ?? (this.mesh.peers.size + 1);
    return members <= 2 ? 'direct' : 'mesh';
  }

  freshFields() {
    return {
      mode: 'mesh', block: 0, offset: 0, resumed: false,
      lastSave: 0, hydrated: false, _hydrate: null,
    };
  }

  async createOffer(file) {
    if (file.size > MAX_FILE) throw new Error(`文件超过上限（${fmtSize(MAX_FILE)}）`);
    const fid = randHex(16);
    const count = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const meta = {
      fid, name: file.name, size: file.size,
      mime: file.type || 'application/octet-stream', chunkSize: CHUNK_SIZE, count,
    };
    const t = {
      fid, meta, role: 'seeder', state: 'running', file,
      bits: bitsAllOnes(count), peerBits: new Map(),
      bytesDone: file.size, bytesSent: 0, errors: 0, haveCount: 0, expired: false,
      havePieces: count, sourceCount: 0, stats: newStats(),
      gen: 0, assign: new Map(), excluded: new Set(),
      ...this.freshFields(),
    };
    this.transfers.set(fid, t);
    await this.room.sendFileOffer(meta);
    await this.sendHave(t);
    this.notify(t, true);
    return t;
  }

  registerOffer(item) {
    const meta = item.file;
    if (!meta || !meta.fid) return null;
    const exist = this.transfers.get(meta.fid);
    if (exist) return exist;
    const t = {
      fid: meta.fid, meta, role: 'leecher', state: 'idle', file: null,
      bits: newBits(meta.count), peerBits: new Map(),
      bytesDone: 0, bytesSent: 0, errors: 0, haveCount: 0, expired: !!item.expired, blob: null,
      havePieces: 0, sourceCount: 0, stats: newStats(),
      gen: 0, assign: new Map(), excluded: new Set(),
      ...this.freshFields(),
    };
    this.transfers.set(meta.fid, t);
    const early = this.pendingBits.get(meta.fid);
    if (early) {
      for (const [id, pb] of early) {
        t.peerBits.set(id, pb);
        if (pb.bits.some(v => v !== 0)) t.expired = false;
      }
      this.pendingBits.delete(meta.fid);
      t.sourceCount = this.countSources(t);
    }
    this.hydrate(t);
    this.notify(t, true);
    return t;
  }

  // ---- 断点续传 ----

  hydrate(t) {
    if (t._hydrate) return t._hydrate;
    t._hydrate = this.doHydrate(t).catch(e => console.warn('[file] hydrate', e));
    return t._hydrate;
  }

  async doHydrate(t) {
    const rec = await loadProgress(t.fid);
    if (!rec || !rec.meta || rec.meta.fid !== t.fid) return;
    if (rec.meta.size !== t.meta.size || rec.meta.count !== t.meta.count) return;
    if (rec.role === 'seeder') return;
    t.meta = rec.meta;
    t.mode = rec.mode === 'direct' ? 'direct' : 'mesh';
    t.block = rec.block || 0;
    t.bytesDone = 0;
    t.haveCount = 0;
    t.havePieces = 0;
    if (t.mode === 'direct') {
      t.offset = Math.max(0, Math.min(t.meta.size, rec.offset || 0));
      t.bytesDone = t.offset;
      t.havePieces = Math.floor(t.offset / t.meta.chunkSize);
      t.bits = t.offset >= t.meta.size ? bitsAllOnes(t.meta.count) : newBits(t.meta.count);
    } else {
      const saved = rec.bits instanceof Uint8Array ? rec.bits : new Uint8Array();
      t.bits = newBits(t.meta.count);
      t.bits.set(saved.subarray(0, t.bits.length));
      for (let i = 0; i < t.meta.count; i++) {
        if (!bitGet(t.bits, i)) continue;
        t.bytesDone += this.expectedLen(t, i);
        t.haveCount++;
        t.havePieces++;
      }
      t.offset = t.bytesDone;
    }
    t.resumed = t.bytesDone > 0;
    t.stats.restoredBytes = t.bytesDone;
    t.state = rec.state === 'done' ? 'done' : (t.resumed ? 'paused' : 'idle');
    this.notify(t, true);
    // 断线前仍在下载：重进房后自动接着传，无需再点「接收」。
    if (rec.state === 'running' && t.resumed) {
      t.state = 'running';
      t.stats.lastProgressAt = Date.now();
      t.excluded = new Set();
      this.room.broadcast({ t: 'have_req', fid: t.fid }).catch(() => {});
      setTimeout(() => { if (t.state === 'running') this.rebalance(t); }, 400);
    }
    this.emit('activity', this.hasActive());
  }

  progressOf(t) {
    const base = {
      fid: t.fid, meta: t.meta, role: t.role, mode: t.mode || 'mesh',
      state: t.state, bytesDone: t.bytesDone, updatedAt: Date.now(),
    };
    return t.mode === 'direct'
      ? { ...base, offset: t.offset || 0, block: t.block || 0 }
      : { ...base, bits: new Uint8Array(t.bits), havePieces: t.havePieces };
  }

  // mesh 模式必须先确认已收分片真正落盘，位图才不会超前于数据。
  saveState(t, force = false) {
    if (t.role === 'seeder') return Promise.resolve();
    const now = Date.now();
    if (!force && now - (t.lastSave || 0) < SAVE_EVERY_MS) return Promise.resolve();
    t.lastSave = now;
    return (async () => {
      if (t.mode !== 'direct' && t.state === 'running') {
        await this.flushWrites(t.fid).catch(() => {});
      }
      await saveProgress(this.progressOf(t));
    })().catch(e => console.warn('[file] save', e));
  }

  // 页面隐藏 / 冻结 / 离房时调用：把全部进行中的传输立刻落盘。
  persistAll() {
    const jobs = [];
    for (const t of this.transfers.values()) {
      if (t.role === 'seeder') continue;
      if (t.mode !== 'direct' && t.state === 'running') {
        const flush = this.flushWrites(t.fid).catch(() => {});
        jobs.push(flush.then(() => saveProgress(this.progressOf(t))));
      } else {
        jobs.push(saveProgress(this.progressOf(t)));
      }
    }
    return Promise.all(jobs.map(p => p.catch(e => console.warn('[file] persist', e))));
  }

  hasActive() {
    for (const t of this.transfers.values()) if (t.state === 'running') return true;
    return false;
  }

  async handleCtrl(from, obj) {
    switch (obj.t) {
      case 'file_offer': this.registerOffer(obj); break;
      case 'file_have': {
        const t = this.transfers.get(obj.fid);
        try {
          const bits = b64decode(obj.bits);
          const pb = { bits, ts: Date.now() };
          if (!t) {
            let m = this.pendingBits.get(obj.fid);
            if (!m) { m = new Map(); this.pendingBits.set(obj.fid, m); }
            m.set(from, pb);
            break;
          }
          const isNew = !t.peerBits.has(from);
          t.peerBits.set(from, pb);
          if (bits.some(v => v !== 0)) t.expired = false;
          t.sourceCount = this.countSources(t);
          this.notify(t, true);
          if (t.state === 'running' && isNew && !t.excluded.has(from)) this.rebalance(t);
        } catch { /* 损坏位图 */ }
        break;
      }
      case 'have_req': {
        const t = this.transfers.get(obj.fid);
        if (t) await this.sendHave(t, from);
        break;
      }
      case 'sync_req':
        for (const t of this.transfers.values()) await this.sendHave(t, from);
        break;
      case 'file_want': this.startPump(from, obj); break;
      case 'direct_want': this.direct.start(from, obj); break;
      // 直传广播不含发送方 id，按 fid 停泵即可（两人场景只有这一个对端）。
      case 'direct_stop': {
        this.direct.stopPeer(from, obj.fid);
        const tt = this.transfers.get(obj.fid);
        if (tt) this.direct.stop(tt);
        break;
      }
      // 对方暂停 / 取消 / 恢复：本端是接收方则同步状态，是发送方则停/起自己的泵。
      case 'file_stop': {
        this.stopPumps(from, obj.fid);
        this.direct.stopPeer(from, obj.fid);
        const t = this.transfers.get(obj.fid);
        if (t) {
          if (t.mode === 'direct') this.direct.stop(t); // 广播不带发送方 id，按 fid 停
          if (t.state === 'running') { t.state = 'paused'; this.notify(t, true); this.emit('activity', this.hasActive()); }
        }
        break;
      }
      case 'file_cancel': {
        this.stopPumps(from, obj.fid);
        this.direct.stopPeer(from, obj.fid);
        const t = this.transfers.get(obj.fid);
        if (t && t.role !== 'seeder') { this.resetLocal(t); clearFile(obj.fid).catch(() => {}); this.notify(t, true); }
        break;
      }
      case 'file_resume': this.resume(obj.fid); break;
      case 'file_got': {
        const job = this.pumps.get(`${from}:${obj.fid}`);
        if (job && job.gen === obj.gen) {
          try { job.got = b64decode(obj.bits); } catch { /* 损坏位图 */ }
        }
        break;
      }
      case 'file_done': {
        const t = this.transfers.get(obj.fid);
        if (t) {
          t.peerBits.set(from, { bits: bitsAllOnes(t.meta.count), ts: Date.now() });
          t.sourceCount = this.countSources(t);
          this.notify(t, true);
        }
        break;
      }
      // 兼容旧版本：旧端仍会发 file_req，只回单片即可。
      case 'file_req': await this.serveLegacy(from, obj); break;
      default: break;
    }
  }

  async sendHave(t, to = '') {
    const frame = { t: 'file_have', fid: t.fid, bits: b64encode(t.bits) };
    if (to) await this.room.sendTo(to, frame);
    else await this.room.broadcast(frame);
    this.notify(t, true);
  }

  activeSources(t) {
    const ids = [];
    for (const [id, pb] of t.peerBits) {
      if (id === this.mesh.self || !this.mesh.ready(id) || t.excluded.has(id)) continue;
      if (pb.bits.some(v => v !== 0)) ids.push(id);
    }
    ids.sort((a, b) => this.score(a) - this.score(b));
    return ids.slice(0, MAX_SOURCES);
  }

  missingBits(t) {
    const w = newBits(t.meta.count);
    for (let i = 0; i < t.meta.count; i++) if (!bitGet(t.bits, i)) bitSet(w, i);
    return w;
  }

  // 取模分工：源 k 只推 i % total === k 的片，无需区间协调，天然均匀覆盖全文件。
  rebalance(t) {
    if (t.state !== 'running') return;
    if (t.mode === 'direct') {
      const peers = this.activeSources(t);
      if (!peers.length) this.room.broadcast({ t: 'have_req', fid: t.fid }).catch(() => {});
      this.direct.want(t, peers);
      return;
    }
    const ids = this.activeSources(t);
    t.gen++;
    t.assign = new Map();
    t.stats.sources = ids.length;
    if (!ids.length) { t.stats.stalled = true; this.notify(t, true); return; }
    t.stats.stalled = false;
    t.stats.refills++;
    const want = b64encode(this.missingBits(t));
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      t.assign.set(id, { mod: k, total: ids.length });
      this.room.sendTo(id, {
        t: 'file_want', fid: t.fid, gen: t.gen, want, mod: k, total: ids.length,
      }).catch(() => {});
    }
    for (const [id] of t.peerBits) {
      if (!t.assign.has(id)) this.room.sendTo(id, { t: 'file_stop', fid: t.fid }).catch(() => {});
    }
    t.stats.lastProgressAt = Date.now();
    this.notify(t, true);
  }

  rebalanceAll() {
    for (const t of this.transfers.values()) if (t.state === 'running') this.rebalance(t);
  }

  stopAll(t) {
    this.room.broadcast({ t: 'file_stop', fid: t.fid }).catch(() => {});
    this.room.broadcast({ t: 'direct_stop', fid: t.fid }).catch(() => {});
    this.direct.stop(t).catch(() => {});
    t.assign = new Map();
  }

  async accept(fid) {
    const t = this.transfers.get(fid);
    if (!t || t.role === 'seeder') return;
    await this.hydrate(t);
    // 已完成的文件再次点「接收」时重置位图，否则 want 全 0 会让泵立即退出并循环等待。
    if (t.havePieces === t.meta.count || (t.mode === 'direct' && t.offset >= t.meta.size)) {
      t.bits = newBits(t.meta.count);
      t.bytesDone = 0;
      t.offset = 0;
      t.haveCount = 0;
      t.havePieces = 0;
      t.blob = null;
      t.resumed = false;
    }
    t.error = '';
    t.state = 'running';
    t.gen = 0;
    t.excluded = new Set();
    t.assign = new Map();
    t.stats = newStats();
    t.stats.restoredBytes = t.bytesDone;
    // 有保存进度时必须沿用记录里的模式：mesh 位图无法换成 direct 的单一 offset。
    t.mode = t.resumed ? t.mode : this.chooseMode();
    if (t.mode !== 'direct') t.offset = 0;
    this.saveState(t, true);
    this.notify(t, true);
    this.emit('activity', true);
    await this.room.broadcast({ t: 'have_req', fid });
    setTimeout(() => { if (t.state === 'running') this.rebalance(t); }, 400);
  }

  pause(fid) {
    const t = this.transfers.get(fid);
    if (!t || t.state !== 'running') return;
    t.state = 'paused';
    this.stopAll(t);
    this.saveState(t, true);
    this.notify(t, true);
    this.emit('activity', this.hasActive());
  }

  resume(fid) {
    const t = this.transfers.get(fid);
    if (!t || t.state !== 'paused') return;
    t.state = 'running';
    t.excluded = new Set();
    this.notify(t, true);
    this.emit('activity', true);
    // 通知对端一起恢复：两人直传里任意一方暂停都会让另一方停泵，需双向唤醒。
    this.room.broadcast({ t: 'file_resume', fid }).catch(() => {});
    this.rebalance(t);
  }

  resetLocal(t) {
    t.state = 'idle';
    t.bits = newBits(t.meta.count);
    t.bytesDone = 0;
    t.offset = 0;
    t.block = 0;
    t.resumed = false;
    t.haveCount = 0;
    t.havePieces = 0;
    t.blob = null;
    t.error = '';
    t.peerBits.clear();
    t.sourceCount = 0;
    t.gen = 0;
    t.assign = new Map();
    t.excluded = new Set();
    t.stats = newStats();
    this.direct.states.delete(t.fid);
    this.direct.chains.delete(t.fid);
    this.direct.commit.delete(t.fid);
    clearTimeout(this.writeTimers.get(t.fid));
    this.writeTimers.delete(t.fid);
    this.writeQueue.delete(t.fid);
    this.writing.delete(t.fid);
    this.direct.stop(t).catch(() => {});
    deleteProgress(t.fid).catch(() => {});
    this.emit('activity', this.hasActive());
  }

  async cancel(fid) {
    const t = this.transfers.get(fid);
    if (!t) return;
    if (t.role === 'seeder') {
      // 发送方取消：停泵并通知接收方丢弃已收分片，本端保留源文件（仍可再次分享）。
      this.stopAll(t);
      t.state = 'idle';
      this.notify(t, true);
      this.emit('activity', this.hasActive());
      await this.room.broadcast({ t: 'file_cancel', fid }).catch(() => {});
      return;
    }
    this.stopAll(t);
    this.resetLocal(t);
    await clearFile(fid).catch(() => {});
    await this.room.broadcast({ t: 'file_cancel', fid }).catch(() => {});
    await this.sendHave(t);
    this.notify(t, true);
  }

  async clearCache(fid) {
    const t = this.transfers.get(fid);
    if (!t || t.role === 'seeder') return;
    this.stopAll(t);
    this.resetLocal(t);
    await clearFile(fid).catch(() => {});
    await this.sendHave(t);
    this.notify(t, true);
  }

  tick() {
    const now = Date.now();
    this.tickCount++;
    for (const t of this.transfers.values()) {
      if (t.state !== 'running') continue;
      const s = t.stats;
      // 发送方按已发字节统计速率；接收方按已收字节。
      const metric = t.role === 'seeder' ? (t.bytesSent || 0) : t.bytesDone;
      s.window.push({ ts: now, bytes: metric });
      while (s.window.length > 1 && now - s.window[0].ts > 2000) s.window.shift();
      if (s.window.length > 1) {
        const span = (now - s.window[0].ts) / 1000;
        s.rate = span > 0 ? (metric - s.window[0].bytes) / span : 0;
        if (s.rate > s.peak) s.peak = s.rate;
      }
      this.notify(t, true);
      this.saveState(t);
      // 整体停滞时重新订阅。direct 只重发一次订阅，不做「排除源 / 重分工」，
      // 避免把连续流反复打断并产生重复帧。发送方无需订阅，跳过。
      if (t.role !== 'seeder' && now - s.lastProgressAt > STALL_MS) {
        if (t.mode === 'direct') {
          this.room.broadcast({ t: 'have_req', fid: t.fid }).catch(() => {});
          this.rebalance(t);
        } else {
          const ids = [...t.assign.keys()];
          for (const id of ids) if (!this.mesh.ready(id)) t.excluded.add(id);
          if (t.assign.size > 1) for (const id of ids.slice(1)) t.excluded.add(id);
          else {
            t.excluded.clear();
            this.room.broadcast({ t: 'have_req', fid: t.fid }).catch(() => {});
          }
          this.rebalance(t);
        }
      }
      // 每 3s 把已收位图同步给源，让 mesh 泵跳过重复片（direct 不需要）。
      if (t.mode !== 'direct' && this.tickCount % GOT_EVERY === 0) {
        const frame = { t: 'file_got', fid: t.fid, gen: t.gen, bits: b64encode(t.bits) };
        for (const [id] of t.assign) this.room.sendTo(id, frame).catch(() => {});
      }
    }
    const active = this.hasActive();
    if (active !== this.lastActive) { this.lastActive = active; this.emit('activity', active); }
    if (this.tickCount % 10 === 0) this.prunePendingBits();
  }

  // ---- 发送端：批量预读 + 批量加密 + 连续推流 ----

  startPump(from, obj) {
    const t = this.transfers.get(obj.fid);
    if (!t || !this.canSeed(t)) return;
    const key = `${from}:${t.fid}`;
    const prev = this.pumps.get(key);
    if (prev) prev.active = false; // 让上一代循环退出
    let want;
    try { want = b64decode(obj.want || ''); } catch { want = new Uint8Array(); }
    const job = {
      active: true, from, fid: t.fid, gen: obj.gen || 0,
      mod: Number.isInteger(obj.mod) ? obj.mod : 0,
      total: Math.max(1, obj.total || 1),
      want, got: null, cursor: 0, sent: 0,
    };
    this.pumps.set(key, job);
    this.runPump(job).catch(e => console.warn('[file] pump', e));
  }

  nextIdxs(job, t) {
    const idxs = [];
    const count = t.meta.count;
    while (job.cursor < count && idxs.length < PUSH_BATCH) {
      const i = job.cursor++;
      if (i % job.total !== job.mod) continue;
      if (job.want.length && !bitGet(job.want, i)) continue;
      if (job.got && bitGet(job.got, i)) continue;
      if (!bitGet(t.bits, i)) continue;
      idxs.push(i);
    }
    return idxs;
  }

  async runPump(job) {
    const t = this.transfers.get(job.fid);
    if (!t) return;
    const key = `${job.from}:${job.fid}`;
    // 双缓冲：发送当前批时并行预读下一批，读盘/IDB 不再打断连续 send。
    let idxs = this.nextIdxs(job, t);
    let pending = idxs.length
      ? this.readChunks(t, idxs).catch(() => [])
      : Promise.resolve([]);

    while (job.active && this.mesh.ready(job.from) && this.canSeed(t) && idxs.length) {
      const bufs = await pending;
      const next = this.nextIdxs(job, t);
      pending = next.length ? this.readChunks(t, next).catch(() => []) : Promise.resolve([]);
      const frames = await this.buildFrames(t, idxs, bufs);
      idxs = next;
      let broke = false;
      for (const frame of frames) {
        if (!frame) continue;
        if (!job.active || !this.mesh.ready(job.from)) { broke = true; break; }
        // 背压时等 drain（短兜底），不丢片也不退回定时器节拍。
        while (!this.mesh.pushData(job.from, frame, PUSH_HIGH_WATER)) {
          if (!job.active || !this.mesh.ready(job.from) || !this.mesh.channelFor(job.from)) {
            broke = true; break;
          }
          await this.waitDrain(job.from);
        }
        if (broke) break;
        job.sent++;
        t.stats.sentPieces++;
        t.bytesSent += frame.byteLength;
      }
      if (broke) break;
    }
    if (this.pumps.get(key) === job) this.pumps.delete(key);
  }

  async readRange(t, start, end) {
    if (t.file) return new Uint8Array(await t.file.slice(start, end).arrayBuffer());
    if (t.blob) return new Uint8Array(await t.blob.slice(start, end).arrayBuffer());
    return readSegmentBytes(t.fid, start, end);
  }

  // 一批分片只读一次 IndexedDB（范围 cursor），或并发 slice 原始 File / 已组装 Blob。
  async readChunks(t, idxs) {
    if (t.file || t.blob || t.mode === 'direct') {
      return Promise.all(idxs.map(i => this.readRange(
        t, i * CHUNK_SIZE, Math.min(t.meta.size, (i + 1) * CHUNK_SIZE),
      )));
    }
    const out = new Map();
    const need = [];
    for (const i of idxs) {
      const mem = this.writeQueue.get(t.fid)?.get(i) ?? this.writing.get(t.fid)?.get(i);
      if (mem) out.set(i, mem); else need.push(i);
    }
    if (need.length) {
      const rows = await getChunks(t.fid, need);
      for (const [i, b] of rows) out.set(i, b);
    }
    return idxs.map(i => out.get(i) || null);
  }

  // 公开房 mesh.key 为 null，直接打包；私有房并发 AES-GCM（nonce 按 fid+idx 唯一）。
  async buildFrames(t, idxs, bufs) {
    const key = this.mesh.key;
    const fidBytes = hexToBytes(t.fid);
    return Promise.all(idxs.map(async (i, k) => {
      const b = bufs[k];
      if (!b) return null;
      if (!key) return packChunk(t.fid, i, b);
      return packChunk(t.fid, i, await sealChunk(key, fidBytes, i, b));
    }));
  }

  waitDrain(id) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.drainWaiters.get(id) === finish) this.drainWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, DRAIN_FALLBACK_MS);
      this.drainWaiters.set(id, finish);
    });
  }

  wakeDrain(id) { this.drainWaiters.get(id)?.(); }

  stopPumps(from, fid) {
    const key = `${from}:${fid}`;
    const job = this.pumps.get(key);
    if (job) { job.active = false; this.pumps.delete(key); }
    this.drainWaiters.get(from)?.();
  }

  stopPumpsFrom(id) {
    for (const [key, job] of this.pumps) {
      if (job.from === id) { job.active = false; this.pumps.delete(key); }
    }
  }

  // 兼容旧版本：旧端发来的 file_req 只回单片，避免其完全卡死。
  async serveLegacy(from, obj) {
    const t = this.transfers.get(obj.fid);
    if (!t || !Number.isInteger(obj.i) || obj.i < 0 || obj.i >= t.meta.count) return;
    if (!bitGet(t.bits, obj.i) || !this.canSeed(t)) return;
    const bufs = await this.readChunks(t, [obj.i]);
    const frames = await this.buildFrames(t, [obj.i], bufs);
    if (frames[0]) this.mesh.pushData(from, frames[0], PUSH_HIGH_WATER);
  }

  // ---- 接收端 ----

  async onData(from, u8) {
    const p = parseChunk(u8);
    if (!p) return;
    const t = this.transfers.get(p.fid);
    if (!t || t.state !== 'running' || t.mode === 'direct') return;
    if (p.idx >= t.meta.count || p.payload.length !== this.expectedLen(t, p.idx)) {
      t.errors++;
      this.notify(t, true);
      return;
    }
    // 多源重分工会产生少量重复片，直接丢弃即可。
    if (bitGet(t.bits, p.idx)) { t.stats.dupes++; return; }
    this.queueWrite(t.fid, p.idx, p.payload);
    bitSet(t.bits, p.idx);
    t.bytesDone += p.payload.length;
    t.offset = t.bytesDone;
    t.haveCount++;
    t.havePieces++;
    t.stats.lastProgressAt = Date.now();
    if (t.haveCount % PROGRESS_EVERY === 0) {
      this.room.broadcast({ t: 'file_have', fid: t.fid, bits: b64encode(t.bits) }).catch(() => {});
    }
    this.saveState(t);
    this.notify(t);
    if (t.havePieces === t.meta.count) await this.finish(t);
  }

  async finish(t) {
    t.state = 'done';
    this.stopAll(t);
    try {
      if (t.mode === 'direct') await this.direct.finish(t);
      else {
        await this.flushWrites(t.fid);
        t.blob = await assemble(t.fid, t.meta.count, t.meta.mime);
      }
      this.save(t);
    } catch (e) { t.error = e.message; }
    await this.saveState(t, true);
    await this.room.broadcast({ t: 'file_done', fid: t.fid }).catch(() => {});
    await this.sendHave(t);
    this.notify(t, true);
    this.emit('activity', this.hasActive());
  }

  async save(t) {
    if (!t) return;
    let blob = t.blob;
    if (!blob) {
      try {
        blob = t.mode === 'direct'
          ? await this.direct.finish(t)
          : await assemble(t.fid, t.meta.count, t.meta.mime);
        t.blob = blob;
      } catch { return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = t.meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  queueWrite(fid, i, bytes) {
    let q = this.writeQueue.get(fid);
    if (!q) { q = new Map(); this.writeQueue.set(fid, q); }
    q.set(i, bytes);
    if (q.size >= WRITE_BATCH) {
      this.flushWrites(fid).catch(e => console.warn('[file] write', e));
      return;
    }
    if (!this.writeTimers.has(fid)) {
      this.writeTimers.set(fid, setTimeout(() => {
        this.flushWrites(fid).catch(e => console.warn('[file] write', e));
      }, 30));
    }
  }

  async flushWrites(fid) {
    clearTimeout(this.writeTimers.get(fid));
    this.writeTimers.delete(fid);
    const q = this.writeQueue.get(fid);
    if (!q || !q.size) return;
    const items = [...q.entries()];
    this.writeQueue.delete(fid);
    let w = this.writing.get(fid);
    if (!w) { w = new Map(); this.writing.set(fid, w); }
    for (const [i, b] of items) w.set(i, b);
    try {
      await putChunks(fid, items);
    } finally {
      for (const [i] of items) w.delete(i);
      if (!w.size) this.writing.delete(fid);
    }
  }

  countSources(t) {
    let n = 0;
    for (const [id, pb] of t.peerBits) {
      if (this.mesh.ready(id) && pb.bits.some(v => v !== 0)) n++;
    }
    return n;
  }

  ownerCount(t) { return t.sourceCount || 0; }

  score(id) {
    const p = this.mesh.peers.get(id);
    return (p?.sameLan ? 0 : 1000) + (p?.fail || 0) * 100;
  }

  dispose() {
    clearInterval(this.timer);
    for (const job of this.pumps.values()) job.active = false;
    this.direct.dispose();
    for (const f of this.drainWaiters.values()) f();
    const persisted = this.persistAll();
    this.pumps.clear();
    this.drainWaiters.clear();
    this.pendingBits.clear();
    for (const id of this.writeTimers.values()) clearTimeout(id);
    this.writeTimers.clear();
    this.writeQueue.clear();
    this.writing.clear();
    return persisted;
  }
}
