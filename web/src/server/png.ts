// 纯 TS PNG 编解码（零依赖）。解码目标是 Minecraft 资源贴图：
// 支持颜色类型 0/2/3/4/6、位深 1/2/4/8/16、tRNS 透明；不支持 Adam7 交错
// （MC 素材里几乎不存在）——遇到解不了的一律返回 undefined，调用方回退到
// "原样拷贝源文件"，宁可丢特效也不产出坏图。
import { deflateSync, inflateSync } from "node:zlib";

export type RgbaImage = { width: number; height: number; pixels: Uint8Array };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 20_000_000;

function channelsOf(colorType: number) {
  if (colorType === 0) return 1; // 灰度
  if (colorType === 2) return 3; // RGB
  if (colorType === 3) return 1; // 调色板
  if (colorType === 4) return 2; // 灰度+alpha
  if (colorType === 6) return 4; // RGBA
  return 0;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 读取一行里第 index 个样本（MSB 优先的位打包；16 位取高字节）
function readSample(lines: Buffer, rowStart: number, index: number, bitDepth: number) {
  if (bitDepth === 8) return lines[rowStart + index];
  if (bitDepth === 16) return lines[rowStart + index * 2];
  const bitPos = index * bitDepth;
  const shift = 8 - bitDepth - (bitPos & 7);
  return (lines[rowStart + (bitPos >> 3)] >> shift) & ((1 << bitDepth) - 1);
}

export function decodePng(buffer: Buffer): RgbaImage | undefined {
  try {
    return decode(buffer);
  } catch {
    return undefined;
  }
}

function decode(data: Buffer): RgbaImage | undefined {
  if (data.length < 8 + 25) return undefined;
  for (let i = 0; i < 8; i++) if (data[i] !== SIGNATURE[i]) return undefined;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > data.length) return undefined;
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) return undefined; // Adam7 交错：不支持
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    offset += 12 + length;
  }

  const channels = channelsOf(colorType);
  if (!width || !height || !channels) return undefined;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return undefined;
  if (width * height > MAX_PIXELS) return undefined;
  if (idat.length === 0) return undefined;

  const raw = inflateSync(Buffer.concat(idat));
  const lineBytes = Math.ceil((width * channels * bitDepth) / 8);
  if (raw.length < (lineBytes + 1) * height) return undefined;
  // 滤波以"整像素字节数"为步长（不足 1 字节按 1 算）
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));

  const lines = Buffer.alloc(lineBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (lineBytes + 1)];
    const src = y * (lineBytes + 1) + 1;
    const dst = y * lineBytes;
    for (let x = 0; x < lineBytes; x++) {
      const value = raw[src + x];
      const left = x >= bpp ? lines[dst + x - bpp] : 0;
      const up = y > 0 ? lines[dst - lineBytes + x] : 0;
      const upLeft = y > 0 && x >= bpp ? lines[dst - lineBytes + x - bpp] : 0;
      let out = value;
      if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) out = value + paeth(left, up, upLeft);
      else if (filter !== 0) return undefined;
      lines[dst + x] = out & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  const maxValue = bitDepth === 16 ? 255 : (1 << bitDepth) - 1;
  const scale = (value: number) => (maxValue === 255 ? value : Math.round((value * 255) / maxValue));
  // tRNS 精确匹配值（16 位只比较高字节，误差可忽略）
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? (bitDepth === 16 ? trns[0] : trns.readUInt16BE(0) & maxValue) : undefined;
  const trnsRgb =
    colorType === 2 && trns && trns.length >= 6
      ? bitDepth === 16
        ? [trns[0], trns[2], trns[4]]
        : [trns.readUInt16BE(0) & maxValue, trns.readUInt16BE(2) & maxValue, trns.readUInt16BE(4) & maxValue]
      : undefined;

  for (let y = 0; y < height; y++) {
    const rowStart = y * lineBytes;
    for (let x = 0; x < width; x++) {
      const base = x * channels;
      const out = (y * width + x) * 4;
      if (colorType === 3) {
        const index = readSample(lines, rowStart, base, bitDepth);
        const p = index * 3;
        if (palette && p + 2 < palette.length) {
          pixels[out] = palette[p];
          pixels[out + 1] = palette[p + 1];
          pixels[out + 2] = palette[p + 2];
          pixels[out + 3] = trns && index < trns.length ? trns[index] : 255;
        }
      } else if (colorType === 0) {
        const value = readSample(lines, rowStart, base, bitDepth);
        const gray = scale(value);
        pixels[out] = gray;
        pixels[out + 1] = gray;
        pixels[out + 2] = gray;
        pixels[out + 3] = trnsGray !== undefined && value === trnsGray ? 0 : 255;
      } else if (colorType === 2) {
        const r = readSample(lines, rowStart, base, bitDepth);
        const g = readSample(lines, rowStart, base + 1, bitDepth);
        const b = readSample(lines, rowStart, base + 2, bitDepth);
        pixels[out] = scale(r);
        pixels[out + 1] = scale(g);
        pixels[out + 2] = scale(b);
        pixels[out + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
      } else if (colorType === 4) {
        const gray = scale(readSample(lines, rowStart, base, bitDepth));
        pixels[out] = gray;
        pixels[out + 1] = gray;
        pixels[out + 2] = gray;
        pixels[out + 3] = scale(readSample(lines, rowStart, base + 1, bitDepth));
      } else {
        pixels[out] = scale(readSample(lines, rowStart, base, bitDepth));
        pixels[out + 1] = scale(readSample(lines, rowStart, base + 1, bitDepth));
        pixels[out + 2] = scale(readSample(lines, rowStart, base + 2, bitDepth));
        pixels[out + 3] = scale(readSample(lines, rowStart, base + 3, bitDepth));
      }
    }
  }

  return { width, height, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...buffers: Buffer[]) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(header.subarray(4), body), 0);
  return Buffer.concat([header, body, crc]);
}

// 始终输出 8 位 RGBA、无滤波——体积换简单，本地图标无所谓
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, pixels } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
