import {
  DIRECT_SEGMENT, DIRECT_HIGH_WATER, DIRECT_SEQ_UNIT,
  hexToBytes, bitsAllOnes,
} from './util.js';
import { packDirect, parseDirect } from './rtc.js';
import { sealChunk, openChunk } from './crypto.js';
import { putSegment, assembleDirect, readSegmentBytes } from './store.js';

// 两人直传：接收端一次 direct_want{offset, block} 订阅，源端把文件当作连续
// 字节流单向推完。没有分片位图、没有多源取模、没有逐片请求、没有进度广播。
//
// 单条 SCTP 消息仍受 maxMessageSize 限制，所以物理上要分帧；但帧头带的是
// 绝对字节 offset，接收端只把它追加到 4MB 段缓冲，段满才落一次盘。
// 断点续传因此只需要「已完成段数」这一个整数，不需要位图。
export class DirectStream {
  constructor(mesh, room, host) {
    this.mesh = mesh;
    this.room = room;
    this.host = host;
    this.jobs = new Map();    // `${源端}:${fid}` -> 推流任务
    this.states = new Map();  // fid -> 接收段的内存状态
    this.chains = new Map();  // fid -> 串行处理链，避免乱序帧并发写同一段缓冲
    this.retryTimers = new Map(); // direct 通道晚于 ctrl 打开时的短重试
    // 段落盘队列：与帧处理链解耦，避免每次 4MB 段的两写 IDB 把全部关联的数据卡住。
    this.writeQ = [];
    this.writeBusy = 0;
    this.maxWrites = 3;
    this.commit = new Map();  // fid -> { next, done:Set, waiters:[] } 保证进度按段序推进
    mesh.on('direct', (from, u8) => this.onFrame(from, u8));
    mesh.on('leave', id => this.stopFrom(id));
  }

  segmentCount(t) { return Math.ceil(t.meta.size / DIRECT_SEGMENT); }

  stateFor(t) {
    let st = this.states.get(t.fid);
    if (!st) {
      st = {
        segIdx: Math.floor((t.offset || 0) / DIRECT_SEGMENT),
        buf: new Uint8Array(DIRECT_SEGMENT),
        got: new Set(),      // 段内已收到的帧起始位置
        gotBytes: 0,         // 段内已收字节数（帧大小可变时比帧数更可靠）
        future: new Map(),   // 无序通道提前到达的后续段帧
      };
      this.states.set(t.fid, st);
    }
    return st;
  }

  // ---- 接收端：订阅 ----

  want(t, ids) {
    const id = ids.find(x => this.mesh.directChannelFor(x));
    if (!id) {
      t.stats.stalled = true;
      t.stats.sources = 0;
      this.host.notify(t, true);
      // direct 通道可能比 ctrl 晚打开，短暂重试而不是等 8s 停滞检测。
      clearTimeout(this.retryTimers.get(t.fid));
      this.retryTimers.set(t.fid, setTimeout(() => {
        if (t.state === 'running') this.host.rebalance(t);
      }, 300));
      return;
    }
    clearTimeout(this.retryTimers.get(t.fid));
    this.retryTimers.delete(t.fid);
    if (!t.block) t.block = this.mesh.directBlock(id);
    // 续传起点：优先从「当前段内第一个尚未收到的块」开始，避免暂停/重订阅后重发已收部分。
    let offset = t.offset || 0;
    const st = this.states.get(t.fid);
    if (st && st.got.size) {
      const segStart = st.segIdx * DIRECT_SEGMENT;
      const segLen = Math.min(DIRECT_SEGMENT, t.meta.size - segStart);
      const block = t.block || 64 * 1024;
      let cur = segStart;
      while (cur < segStart + segLen) {
        if (!st.got.has(cur - segStart)) break;
        cur += block;
        if (cur > segStart + segLen) cur = segStart + segLen;
      }
      offset = cur;
    }
    t.gen++;
    t.assign = new Map([[id, { mod: 0, total: 1 }]]);
    t.stats.sources = 1;
    t.stats.stalled = false;
    t.stats.refills++;
    t.stats.lastProgressAt = Date.now();
    this.room.sendTo(id, {
      t: 'direct_want', fid: t.fid, gen: t.gen,
      offset, block: t.block,
    }).catch(() => {});
    this.host.notify(t, true);
  }

  stop(t) {
    for (const [key, job] of this.jobs) {
      if (job.fid === t.fid) {
        job.active = false;
        this.jobs.delete(key);
        // 泵可能正阻塞在 waitDrain() 里，必须唤醒才能让 while 立刻看到 active=false 并退出，
        // 否则暂停/取消后还会继续发到兜底超时。
        this.host.wakeDrain(job.from);
      }
    }
    clearTimeout(this.retryTimers.get(t.fid));
    this.retryTimers.delete(t.fid);
    // 只重置串行处理链；保留 states（已收位置），以便恢复时从缺口续传而非段边界重发。
    this.chains.delete(t.fid);
    return Promise.resolve();
  }

  stopFrom(id) {
    for (const [key, job] of this.jobs) {
      if (job.from === id) { job.active = false; this.jobs.delete(key); }
    }
    this.host.wakeDrain(id);
  }

  stopPeer(from, fid) {
    const key = `${from}:${fid}`;
    const job = this.jobs.get(key);
    if (job) { job.active = false; this.jobs.delete(key); }
    this.host.wakeDrain(from);
  }

  // ---- 源端：连续推流 ----

  start(from, obj) {
    const t = this.host.transfers.get(obj.fid);
    if (!t || !this.host.canSeed(t)) {
      // 已取消分享：对端可能重新点「接收」，回 file_cancel 让其显示「已取消」而非无限等待。
      if (t && t.role === 'seeder' && t.state === 'idle') {
        this.room.sendTo(from, { t: 'file_cancel', fid: t.fid }).catch(() => {});
      }
      return;
    }
    const key = `${from}:${t.fid}`;
    const prev = this.jobs.get(key);
    if (prev) prev.active = false;
    const block = Math.max(64 * 1024, Math.min(1024 * 1024, Number(obj.block) || 0));
    const offset = Math.max(0, Math.min(t.meta.size, Number(obj.offset) || 0));
    const job = { active: true, from, fid: t.fid, gen: obj.gen || 0, offset, block, sent: 0 };
    this.jobs.set(key, job);
    this.run(job).catch(e => console.warn('[direct] pump', e));
  }

  async readSegment(t, start, end) {
    if (t.file) return new Uint8Array(await t.file.slice(start, end).arrayBuffer());
    if (t.blob) return new Uint8Array(await t.blob.slice(start, end).arrayBuffer());
    return readSegmentBytes(t.fid, start, end);
  }

  async run(job) {
    const t = this.host.transfers.get(job.fid);
    if (!t) return;
    const key = `${job.from}:${job.fid}`;
    const size = t.meta.size;
    const keyBytes = this.mesh.key;
    const fidBytes = hexToBytes(t.fid);
    let cursor = job.offset;
    // 双缓冲：发送当前段的同时预读下一段，读盘/IDB 不再打断连续 send。
    let pending = this.readSegment(t, cursor, Math.min(size, cursor + DIRECT_SEGMENT))
      .catch(() => new Uint8Array(0));

    while (job.active && this.mesh.ready(job.from) && this.host.canSeed(t)) {
      const start = cursor;
      const seg = await pending;
      if (!seg || !seg.length) break;
      cursor += seg.length;
      // 发送进度/速率只在数据真正进入 SCTP 通道后累计。以前在读盘预读处就写成
      // cursor，把「已读入内存」当成「已发送」，配合大缓冲会得到 40M+ 的虚高数字。
      pending = cursor < size
        ? this.readSegment(t, cursor, Math.min(size, cursor + DIRECT_SEGMENT))
          .catch(() => new Uint8Array(0))
        : Promise.resolve(new Uint8Array(0));

      // 帧不得跨越 DIRECT_SEGMENT 边界：接收端按 4MB 段缓冲重组，越界帧会被判为
      // 异常丢弃，导致「段永远填不满、续传卡死」。续传起点可能落在段中间，故按段尾截断。
      const pieces = [];
      for (let p = 0; p < seg.length;) {
        const off = start + p;
        const segEnd = Math.min(size, (Math.floor(off / DIRECT_SEGMENT) + 1) * DIRECT_SEGMENT);
        const len = Math.min(job.block, segEnd - off, seg.length - p);
        if (len <= 0) break;
        pieces.push({ off, payload: seg.subarray(p, p + len) });
        p += len;
      }
      // 一段内并发加密（私有房），公开房零拷贝直接打包。
      const frames = await Promise.all(pieces.map(async ({ off, payload }) => {
        const body = keyBytes
          ? await sealChunk(keyBytes, fidBytes, Math.floor(off / DIRECT_SEQ_UNIT), payload)
          : payload;
        return packDirect(t.fid, off, body);
      }));

      let broke = false;
      for (let k = 0; k < frames.length; k++) {
        const frame = frames[k];
        while (!this.mesh.pushDirect(job.from, frame, DIRECT_HIGH_WATER)) {
          if (!job.active || !this.mesh.ready(job.from) || !this.mesh.directChannelFor(job.from)) {
            broke = true; break;
          }
          await this.host.waitDrain(job.from);
        }
        if (broke) break;
        job.sent++;
        t.stats.sentPieces++;
        // 只统计真正 send 成功的原始字节（不含帧头/加密开销），与接收端口径一致。
        t.bytesSent = Math.min(size, t.bytesSent + pieces[k].payload.byteLength);
        this.host.notify(t);
      }
      if (broke) break;
    }
    if (this.jobs.get(key) === job) this.jobs.delete(key);
  }

  // ---- 接收端：按 offset 追加 ----

  onFrame(from, u8) {
    const p = parseDirect(u8);
    if (!p) return;
    const t = this.host.transfers.get(p.fid);
    if (!t || t.mode !== 'direct' || t.state !== 'running') return;
    const chain = (this.chains.get(t.fid) || Promise.resolve())
      .then(async () => {
        let payload = p.payload;
        const key = this.mesh.key;
        if (key) {
          try {
            payload = await openChunk(
              key, p.fidBytes, Math.floor(p.offset / DIRECT_SEQ_UNIT), p.payload,
            );
          } catch { t.errors++; this.host.notify(t, true); return; }
        }
        await this.applyFrame(t, p.offset, payload);
      });
    this.chains.set(t.fid, chain.catch(e => console.warn('[direct] frame', e)));
  }

  async applyFrame(t, off, buf) {
    const st = this.stateFor(t);
    const queue = [[off, buf]];
    while (queue.length) {
      const [o, bytes] = queue.shift();
      const segIdx = Math.floor(o / DIRECT_SEGMENT);
      if (segIdx < st.segIdx) { t.stats.dupes++; continue; }
      if (segIdx > st.segIdx) {
        if (st.future.size < 1024) st.future.set(o, bytes);
        continue;
      }
      const pos = o - segIdx * DIRECT_SEGMENT;
      if (pos < 0 || pos + bytes.length > DIRECT_SEGMENT) { t.errors++; continue; }
      if (st.got.has(pos)) { t.stats.dupes++; continue; }
      st.buf.set(bytes, pos);
      st.got.add(pos);
      st.gotBytes += bytes.length;
      t.bytesDone += bytes.length;
      t.stats.lastProgressAt = Date.now();

      const segStart = st.segIdx * DIRECT_SEGMENT;
      const segLen = Math.min(DIRECT_SEGMENT, t.meta.size - segStart);
      // 帧大小可变（段尾截断/续传），按累计字节判断是否收满，不再用帧数估算。
      if (st.gotBytes < segLen) continue;
      await this.flushSegment(t, st, segLen);
      if (t.state !== 'running' || t.offset >= t.meta.size) break;
      const future = [...st.future.entries()];
      st.future.clear();
      for (const item of future) queue.push(item);
    }
    this.host.notify(t);
  }

  async flushSegment(t, st, segLen) {
    const idx = st.segIdx;
    const bytes = st.buf.slice(0, segLen); // 复制出本段，链立即复用 st.buf，不再等落盘
    st.segIdx++;
    st.buf = new Uint8Array(DIRECT_SEGMENT);
    st.got.clear();
    st.gotBytes = 0;
    // 落盘与进度保存移出帧处理链：独立有限并发写入队列，3 条关联的数据不再被单段 2 次 IDB 写卡住。
    let c = this.commit.get(t.fid);
    if (!c) { c = { next: 0, done: new Set(), waiters: [] }; this.commit.set(t.fid, c); }
    this.writeQ.push({ t, idx, bytes });
    this.pumpWrites(t.fid);
    this.host.notify(t, true);
    // 所有段已在内存收齐 → 等落盘完成再组装，保证 assemble 不缺段。
    if (st.segIdx * DIRECT_SEGMENT >= t.meta.size) {
      this.drainWrites(t.fid).then(() => this.host.finish(t));
    }
  }

  pumpWrites(fid) {
    while (this.writeBusy < this.maxWrites && this.writeQ.length) {
      const job = this.writeQ.shift();
      this.writeBusy++;
      const { t, idx, bytes } = job;
      putSegment(t.fid, idx, new Blob([bytes]))
        .then(() => this.commitSeg(t, idx, bytes.length))
        .catch(e => { console.warn('[direct] putSegment', e); t.errors++; this.host.notify(t, true); })
        .finally(() => { this.writeBusy--; this.pumpWrites(fid); this.maybeDrain(fid); });
    }
  }

  // 段落盘后按顺序推进 durable offset（用于断点续传/进度），即使并发写入乱序完成也只连续推进。
  commitSeg(t, idx, segLen) {
    const c = this.commit.get(t.fid);
    if (!c) return;
    c.done.add(idx);
    while (c.done.has(c.next)) {
      c.next++;
      const off = Math.min(t.meta.size, c.next * DIRECT_SEGMENT);
      t.offset = off;
      t.havePieces = Math.floor(off / t.meta.chunkSize);
    }
    this.host.saveState(t, true).catch(() => {}); // 进度落盘由 saveState 内部节流
    this.host.notify(t, true);
  }

  drainWrites(fid) {
    return new Promise(res => {
      const c = this.commit.get(fid);
      if (!c || (this.writeQ.length === 0 && this.writeBusy === 0)) return res();
      c.waiters.push(res);
    });
  }

  maybeDrain(fid) {
    const c = this.commit.get(fid);
    if (c && this.writeQ.length === 0 && this.writeBusy === 0 && c.waiters.length) {
      const ws = c.waiters; c.waiters = [];
      for (const w of ws) w();
    }
  }

  async finish(t) {
    t.blob = await assembleDirect(t.fid, this.segmentCount(t), t.meta.mime);
    t.bits = bitsAllOnes(t.meta.count); // 声明完整持有，之后可供 mesh 模式下载
    return t.blob;
  }

  dispose() {
    for (const job of this.jobs.values()) job.active = false;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.jobs.clear();
    this.retryTimers.clear();
    this.states.clear();
    this.chains.clear();
    this.writeQ.length = 0;
    this.writeBusy = 0;
    this.commit.clear();
  }
}
