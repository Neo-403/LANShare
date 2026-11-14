// 零依赖 QR Code 生成器：Byte 模式 / 纠错级别 L / 版本 1-9（最大 232 字节）/ mask 0。
// 分享链接形如 https://host/#rid=ABC123&pwd=xxx，远在该容量内。
// mask 固定为 0 并把编号写进格式信息，标准解码器可正常识别，省去 8 次惩罚评估。

const EC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30];
const NUM_BLOCKS   = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2];
const DATA_WORDS   = [0, 19, 34, 55, 80, 108, 136, 156, 194, 232];
const ALIGN_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46],
];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const poly = new Array(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMul(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMul(root, 2);
  }
  return poly;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function makeCodewords(text, version) {
  const bytes = new TextEncoder().encode(text);
  const cap = DATA_WORDS[version];
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(4, 4);                  // Byte 模式
  push(bytes.length, 8);       // 版本 1-9 用 8 位字符计数
  for (const b of bytes) push(b, 8);
  const room = cap * 8 - bits.length;
  push(0, Math.min(4, room));  // 终止符
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  let pad = 0xec;
  while (data.length < cap) {
    data.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }

  const blocks = NUM_BLOCKS[version];
  const ecLen = EC_PER_BLOCK[version];
  const divisor = rsDivisor(ecLen);
  const blockLen = cap / blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const part = data.slice(b * blockLen, (b + 1) * blockLen);
    dataBlocks.push(part);
    ecBlocks.push(rsRemainder(part, divisor));
  }
  const raw = [];
  for (let i = 0; i < blockLen; i++)
    for (let b = 0; b < blocks; b++) raw.push(dataBlocks[b][i]);
  for (let i = 0; i < ecLen; i++)
    for (let b = 0; b < blocks; b++) raw.push(ecBlocks[b][i]);
  return raw;
}

function formatBits() {
  const ecLevelL = 1; // L = 01
  const data = (ecLevelL << 3) | 0; // mask 0
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

function buildMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 9; v++) {
    // 4(模式) + 8(计数) + 8*len + 4(终止) <= 数据容量 bits
    if (12 + bytes.length * 8 + 4 <= DATA_WORDS[v] * 8) { version = v; break; }
  }
  if (!version) throw new Error('链接过长，无法生成二维码');

  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    m[y][x] = dark ? 1 : 0;
    fn[y][x] = true;
  };
  const getBit = (bits, i) => ((bits >>> i) & 1) !== 0;

  // 定位图案 + 分隔符
  const finderCenters = [[3, 3], [size - 4, 3], [3, size - 4]];
  for (const [cx, cy] of finderCenters) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d <= 3 && d !== 2);
      }
    }
  }
  // 定时图案
  for (let i = 0; i < size; i++) {
    if (!fn[6][i]) set(i, 6, i % 2 === 0);
    if (!fn[i][6]) set(6, i, i % 2 === 0);
  }
  // 校正图案（跳过与定位图案重叠的三个角）
  const centers = ALIGN_CENTERS[version - 1];
  const last = centers[centers.length - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, d !== 1);
        }
      }
    }
  }
  // 格式信息（两份）+ 固定黑点
  const fmt = formatBits();
  for (let i = 0; i <= 5; i++) set(8, i, getBit(fmt, i));
  set(8, 7, getBit(fmt, 6));
  set(8, 8, getBit(fmt, 7));
  set(7, 8, getBit(fmt, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(fmt, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(fmt, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(fmt, i));
  set(8, size - 8, true);
  // 版本信息（v >= 7）
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(vb, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // 数据放置：右下起，每两列一组，上下交替蛇形
  const raw = makeCodewords(text, version);
  const totalBits = raw.length * 8;
  const mask = (x, y) => (x + y) % 2 === 0;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (raw[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        m[y][x] = bit ^ (mask(x, y) ? 1 : 0);
      }
    }
  }
  return { size, modules: m };
}

// 导出纯矩阵，便于自检 / 将来改用 SVG 渲染。
export function qrMatrix(text) { return buildMatrix(text); }

// 渲染到 canvas；quiet zone 4 模块，scale 自适应容器宽度。
export function renderQR(canvas, text, maxWidth = 240) {
  const { size, modules } = buildMatrix(text);
  const quiet = 4;
  const dim = size + quiet * 2;
  const scale = Math.max(2, Math.floor(maxWidth / dim));
  const px = dim * scale;
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = px + 'px';
  canvas.style.height = px + 'px';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#0b1220';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
}
