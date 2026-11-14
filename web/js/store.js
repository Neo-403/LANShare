// 按 chunk 存 IndexedDB：避免 2GB 文件占满 JS 堆，同时支持随机读供种。
// v2 增加 progress（传输进度）与直传段，用于断点续传；chunks 数据保持兼容。
const DB_NAME = 'lanshare-v1';
const STORE = 'chunks';
const PROGRESS = 'progress';
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(PROGRESS)) d.createObjectStore(PROGRESS);
    };
    req.onsuccess = () => {
      // 其它标签页请求升级到 v2 时主动让出连接，避免 open 永久挂起。
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 序号补零，保证 IDBKeyRange 的字典序 == 分片序号，才能批量顺序读取。
const key = (fid, i) => `${fid}:${String(i).padStart(8, '0')}`;
// 直传段用 's' 前缀：字典序在数字之后，不会与 assemble() 的分片范围重叠。
const segKey = (fid, i) => `${fid}:s${String(i).padStart(8, '0')}`;

export async function putChunk(fid, i, bytes) {
  return putChunks(fid, [[i, bytes]]);
}

// 一个事务写多片：逐片事务在移动端/机械盘上会把吞吐压到 2MB/s 量级。
export async function putChunks(fid, items) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [i, bytes] of items) store.put(bytes, key(fid, i));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// 直传段：一条记录 4MB Blob，浏览器可把 Blob 后备到磁盘，不占 JS 堆。
export async function putSegment(fid, i, blob) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, segKey(fid, i));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getChunk(fid, i) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key(fid, i));
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
    req.onerror = () => reject(req.error);
  });
}

// 供种端批量预读：一次只读事务取回一批连续分片，替代逐片 get 事务。
export async function getChunks(fid, idxs) {
  const d = await db();
  const wanted = new Set(idxs);
  const range = IDBKeyRange.bound(key(fid, Math.min(...idxs)), key(fid, Math.max(...idxs)));
  return new Promise((resolve, reject) => {
    const out = new Map();
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      const i = Number(String(cur.key).slice(fid.length + 1));
      if (wanted.has(i)) out.set(i, new Uint8Array(cur.value));
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// 从已落盘的直传段里读一段字节，供源端在页面重载后继续供种。
export async function readSegmentBytes(fid, start, end) {
  if (end <= start) return new Uint8Array(0);
  const d = await db();
  const SEG = 4 * 1024 * 1024;
  const first = Math.floor(start / SEG);
  const last = Math.floor((end - 1) / SEG);
  const range = IDBKeyRange.bound(segKey(fid, first), segKey(fid, last));
  const rows = await new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll(range);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  // 段缺失时直接失败，绝不能返回补零的字节当作真实文件数据。
  if (rows.length !== last - first + 1) throw new Error('直传段缺失');
  const parts = await Promise.all(rows.map(async v => {
    const b = v instanceof Blob ? v : new Blob([v]);
    return new Uint8Array(await b.arrayBuffer());
  }));
  const out = new Uint8Array(end - start);
  for (let k = 0; k < parts.length; k++) {
    const segStart = (first + k) * SEG;
    const lo = Math.max(start, segStart);
    const hi = Math.min(end, segStart + parts[k].length);
    if (hi > lo) out.set(parts[k].subarray(lo - segStart, hi - segStart), lo - start);
  }
  return out;
}

export async function clearFile(fid) {
  const d = await db();
  const prefix = `${fid}:`;
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (String(cur.key).startsWith(prefix)) cur.delete();
      cur.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getAllRange(d, range) {
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll(range);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 分批读取（默认 128 片/批），避免 2GB 文件产生上万次 IDB 事务。
export async function assemble(fid, count, mime) {
  const d = await db();
  const parts = [];
  const BATCH = 128;
  for (let start = 0; start < count; start += BATCH) {
    const end = Math.min(count, start + BATCH) - 1;
    const range = IDBKeyRange.bound(key(fid, start), key(fid, end));
    const rows = await getAllRange(d, range);
    for (const v of rows) parts.push(new Uint8Array(v));
  }
  if (parts.length !== count) throw new Error(`分片不完整：${parts.length}/${count}`);
  return new Blob(parts, { type: mime || 'application/octet-stream' });
}

// 直传：按段序拼接，全程不产生分片索引。
export async function assembleDirect(fid, count, mime) {
  const d = await db();
  const parts = [];
  const BATCH = 64;
  for (let start = 0; start < count; start += BATCH) {
    const end = Math.min(count, start + BATCH) - 1;
    const range = IDBKeyRange.bound(segKey(fid, start), segKey(fid, end));
    for (const v of await getAllRange(d, range)) parts.push(v instanceof Blob ? v : new Blob([v]));
  }
  if (parts.length !== count) throw new Error(`传输段不完整：${parts.length}/${count}`);
  return new Blob(parts, { type: mime || 'application/octet-stream' });
}

// ---- 传输进度（断点续传） ----

export async function saveProgress(rec) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(PROGRESS, 'readwrite');
    tx.objectStore(PROGRESS).put(rec, rec.fid);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProgress(fid) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(PROGRESS, 'readonly').objectStore(PROGRESS).get(fid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listProgress() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(PROGRESS, 'readonly').objectStore(PROGRESS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProgress(fid) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(PROGRESS, 'readwrite');
    tx.objectStore(PROGRESS).delete(fid);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
