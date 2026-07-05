// 物品图标合成：
// - flat：平面贴图，多层 alpha 叠加（药水=液体层+瓶身层这类）
// - cube：方块物品按游戏内物品栏的等距(isometric)视角合成 顶/左/右 三面,
//   明暗 1.0 / 0.8 / 0.6,输出 64px 左右的图,前端平滑缩小显示
// 所有入口都可能返回 undefined（源 PNG 解不开等），由调用方回退到拷贝原图。
import { decodePng, encodePng, type RgbaImage } from "./png";

export type FaceTexture = { location: string; buffer: Buffer };

export type IconPlan =
  | { kind: "flat"; layers: FaceTexture[] }
  | { kind: "cube"; top: FaceTexture; left: FaceTexture; right: FaceTexture };

// 灰度贴图在游戏内由代码按群系/固定色染色。这里只染确定无疑的原版贴图,
// 统一用平原群系色——染错比不染更糟,宁缺毋滥。
const TINTS: Record<string, number> = {
  "minecraft:block/grass_block_top": 0x91bd59,
  "minecraft:block/short_grass": 0x91bd59,
  "minecraft:block/tall_grass_top": 0x91bd59,
  "minecraft:block/tall_grass_bottom": 0x91bd59,
  "minecraft:block/fern": 0x91bd59,
  "minecraft:block/large_fern_top": 0x91bd59,
  "minecraft:block/large_fern_bottom": 0x91bd59,
  "minecraft:block/oak_leaves": 0x77ab2f,
  "minecraft:block/jungle_leaves": 0x77ab2f,
  "minecraft:block/acacia_leaves": 0x77ab2f,
  "minecraft:block/dark_oak_leaves": 0x77ab2f,
  "minecraft:block/spruce_leaves": 0x619961,
  "minecraft:block/birch_leaves": 0x80a755,
  "minecraft:block/mangrove_leaves": 0x92c648,
  "minecraft:block/vine": 0x77ab2f,
  "minecraft:block/lily_pad": 0x71c35c,
  "minecraft:item/potion_overlay": 0x385dc6,
  "minecraft:item/leather_helmet": 0xa06540,
  "minecraft:item/leather_chestplate": 0xa06540,
  "minecraft:item/leather_leggings": 0xa06540,
  "minecraft:item/leather_boots": 0xa06540,
  "minecraft:item/leather_horse_armor": 0xa06540,
};

// 动画贴图是纵向逐帧排列的长条（高是宽的整数倍），裁第一帧当图标
function firstFrame(image: RgbaImage): RgbaImage {
  const { width, height } = image;
  if (width === 0 || height <= width || height % width !== 0) return image;
  return { width, height: width, pixels: image.pixels.subarray(0, width * width * 4) };
}

function tinted(image: RgbaImage, location: string): RgbaImage {
  const tint = TINTS[location];
  if (tint === undefined) return image;
  const tr = (tint >> 16) & 0xff;
  const tg = (tint >> 8) & 0xff;
  const tb = tint & 0xff;
  const pixels = new Uint8Array(image.pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (image.pixels[i] * tr) / 255;
    pixels[i + 1] = (image.pixels[i + 1] * tg) / 255;
    pixels[i + 2] = (image.pixels[i + 2] * tb) / 255;
    pixels[i + 3] = image.pixels[i + 3];
  }
  return { width: image.width, height: image.height, pixels };
}

function decodeFace(face: FaceTexture): RgbaImage | undefined {
  const decoded = decodePng(face.buffer);
  if (!decoded) return undefined;
  return tinted(firstFrame(decoded), face.location);
}

// 最近邻采样（uv ∈ [0,1)）
function sample(image: RgbaImage, u: number, v: number) {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
  return (y * image.width + x) * 4;
}

function renderFlat(layers: FaceTexture[]): Buffer | undefined {
  const images: RgbaImage[] = [];
  for (let i = 0; i < layers.length; i++) {
    const decoded = decodeFace(layers[i]);
    if (!decoded) {
      if (i === 0) return undefined; // 底层都解不开:整体回退原图
      continue; // 上层解不开就少叠一层
    }
    images.push(decoded);
  }
  if (images.length === 0) return undefined;
  if (images.length === 1) return encodePng(images[0]);

  // 以最大层为画布,其余层最近邻放大后自上而下 alpha-over
  const width = Math.max(...images.map((image) => image.width));
  const height = Math.max(...images.map((image) => image.height));
  const pixels = new Uint8Array(width * height * 4);
  for (const image of images) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = sample(image, x / width, y / height);
        const alpha = image.pixels[src + 3] / 255;
        if (alpha === 0) continue;
        const dst = (y * width + x) * 4;
        const back = pixels[dst + 3] / 255;
        const outAlpha = alpha + back * (1 - alpha);
        for (let c = 0; c < 3; c++) {
          pixels[dst + c] = (image.pixels[src + c] * alpha + pixels[dst + c] * back * (1 - alpha)) / outAlpha;
        }
        pixels[dst + 3] = outAlpha * 255;
      }
    }
  }
  return encodePng({ width, height, pixels });
}

// 等距立方体投影。半宽 A 像素,画布 2A×2A:
//   顶面菱形 (u,v)→(A+(u-v)A, (u+v)A/2),左/右面为两块平行四边形,
//   对每个画布像素反解 uv 判断落在哪个面,天然无缝无重叠。
function renderCube(topFace: FaceTexture, leftFace: FaceTexture, rightFace: FaceTexture): Buffer | undefined {
  const top = decodeFace(topFace);
  const left = decodeFace(leftFace);
  const right = decodeFace(rightFace);
  if (!top || !left || !right) return undefined;

  const A = Math.min(128, Math.max(32, top.width));
  const size = 2 * A;
  const pixels = new Uint8Array(size * size * 4);

  const put = (dst: number, image: RgbaImage, src: number, shade: number) => {
    pixels[dst] = image.pixels[src] * shade;
    pixels[dst + 1] = image.pixels[src + 1] * shade;
    pixels[dst + 2] = image.pixels[src + 2] * shade;
    pixels[dst + 3] = image.pixels[src + 3];
  };

  for (let py = 0; py < size; py++) {
    const Y = py + 0.5;
    for (let px = 0; px < size; px++) {
      const X = px + 0.5;
      const dst = (py * size + px) * 4;

      const tu = ((X - A) / A + (2 * Y) / A) / 2;
      const tv = ((2 * Y) / A - (X - A) / A) / 2;
      if (tu >= 0 && tu < 1 && tv >= 0 && tv < 1) {
        put(dst, top, sample(top, tu, tv), 1.0);
        continue;
      }

      if (X < A) {
        const u = X / A;
        const v = Y / A - (u + 1) / 2;
        if (v >= 0 && v < 1) put(dst, left, sample(left, u, v), 0.8);
      } else {
        const u = (X - A) / A;
        const v = Y / A - 1 + u / 2;
        if (v >= 0 && v < 1) put(dst, right, sample(right, u, v), 0.6);
      }
    }
  }

  return encodePng({ width: size, height: size, pixels });
}

export function renderIcon(plan: IconPlan): Buffer | undefined {
  if (plan.kind === "flat") return renderFlat(plan.layers);
  // 立方体渲染失败（某面 PNG 解不开）退回顶面平铺
  return renderCube(plan.top, plan.left, plan.right) ?? renderFlat([plan.top]);
}
