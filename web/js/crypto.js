import { b64encode, b64decode } from './util.js';

export const PBKDF2_ROUNDS = 120000;

// 会话密钥模型：房间创建时生成一把随机 roomKey，全生命周期不变。
// 密码只派生 KEK 来「包装」roomKey（wrapRoomKey），服务端仅保存密文，
// 因此房主随时添加/修改/移除密码都不会改变已连接成员的密钥。
export function randomRoomKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function importRoomKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function wrapRoomKey(kek, keyBytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kek, keyBytes);
  return { nonce: b64encode(nonce), data: b64encode(new Uint8Array(ct)) };
}

export async function unwrapRoomKey(kek, frame) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(frame.nonce) }, kek, b64decode(frame.data),
  );
  return new Uint8Array(pt);
}

// deriveRoomKey 现在只用作包装会话密钥的 KEK（密码 + keySalt）。
export async function deriveRoomKey(password, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function seal(key, obj) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  return { t: 'enc', nonce: b64encode(nonce), data: b64encode(ct) };
}

export async function open(key, frame) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(frame.nonce) }, key, b64decode(frame.data),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// 每个 chunk 独立加密：nonce = fid前4字节 || idx(大端4B) || 0，AAD = fid。
function chunkNonce(fidBytes, idx) {
  const n = new Uint8Array(12);
  n.set(fidBytes.subarray(0, 4), 0);
  new DataView(n.buffer).setUint32(4, idx, false);
  return n;
}

export async function sealChunk(key, fidBytes, idx, plain) {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: chunkNonce(fidBytes, idx), additionalData: fidBytes },
    key, plain,
  );
  return new Uint8Array(ct);
}

export async function openChunk(key, fidBytes, idx, cipher) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: chunkNonce(fidBytes, idx), additionalData: fidBytes },
    key, cipher,
  );
  return new Uint8Array(pt);
}

