import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { renderIcon } from "./icons";

export type ItemAsset = {
  id: string;
  name: string;
  englishName?: string;
  icon?: string;
  iconKind?: "flat" | "cube" | "export";
  source?: string;
  iconSource?: string;
};

export type AssetIndex = {
  generatedAt: number;
  gameRoot: string;
  count: number;
  items: Record<string, ItemAsset>;
};

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

type AssetSource = {
  label: string;
  list(): string[];
  readBuffer(path: string): Buffer | undefined;
  readText(path: string): string | undefined;
};

// 惰性来源引用:open() 时才把 jar 读进内存,处理完一个释放一个,
// 避免整合包上百个 mod jar 同时驻留
type SourceRef = { label: string; open: () => AssetSource };

type ModelData = {
  parent?: string;
  textures?: Record<string, string>;
};

type PickedTexture = { location: string; buffer: Buffer; source: string };

type IconPlan =
  | { kind: "flat"; layers: PickedTexture[] }
  | { kind: "cube"; top: PickedTexture; left: PickedTexture; right: PickedTexture };

const PUBLIC_DIR = resolve(import.meta.dir, "..", "..", "public");
const GENERATED_DIR = join(PUBLIC_DIR, "generated");
const ITEM_ICON_DIR = join(GENERATED_DIR, "items");
const INDEX_PATH = join(GENERATED_DIR, "item-index.json");

function now() {
  return Date.now();
}

function normalPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function findGameRoot() {
  if (process.env.MC_INSTANCE_ROOT) return resolve(process.env.MC_INSTANCE_ROOT);
  if (process.env.GAME_ROOT) return resolve(process.env.GAME_ROOT);

  let current = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, "mods")) && existsSync(join(current, "config"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return resolve(process.cwd(), "../../../..");
}

function listFilesRecursive(root: string, prefix = "") {
  const out: string[] = [];
  if (!existsSync(root)) return out;

  for (const name of readdirSync(root)) {
    const absolute = join(root, name);
    const rel = normalPath(prefix ? `${prefix}/${name}` : name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) out.push(...listFilesRecursive(absolute, rel));
    else if (stat.isFile()) out.push(rel);
  }

  return out;
}

class DirectorySource implements AssetSource {
  label: string;
  private files: string[];
  private paths = new Map<string, string>();

  constructor(label: string, root: string, prefix = "") {
    this.label = label;
    this.files = [];
    for (const localPath of listFilesRecursive(root)) {
      const assetPath = normalPath(prefix ? `${prefix}/${localPath}` : localPath);
      if (!assetPath.startsWith("assets/")) continue;
      this.files.push(assetPath);
      this.paths.set(assetPath, join(root, localPath.split("/").join(sep)));
    }
  }

  list() {
    return this.files;
  }

  readBuffer(path: string) {
    const rel = normalPath(path);
    const local = this.paths.get(rel);
    return local ? readFileSync(local) : undefined;
  }

  readText(path: string) {
    const buffer = this.readBuffer(path);
    return buffer ? buffer.toString("utf8") : undefined;
  }
}

class ZipSource implements AssetSource {
  label: string;
  private data: Buffer;
  private entries = new Map<string, ZipEntry>();

  constructor(label: string, path: string) {
    this.label = label;
    this.data = readFileSync(path);
    this.readCentralDirectory();
  }

  list() {
    return [...this.entries.keys()];
  }

  readBuffer(path: string) {
    const entry = this.entries.get(normalPath(path));
    if (!entry) return undefined;

    const local = entry.localOffset;
    if (this.data.readUInt32LE(local) !== 0x04034b50) return undefined;
    const nameLength = this.data.readUInt16LE(local + 26);
    const extraLength = this.data.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const compressed = this.data.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(compressed);
    if (entry.method === 8) return inflateRawSync(compressed);
    return undefined;
  }

  readText(path: string) {
    const buffer = this.readBuffer(path);
    return buffer ? buffer.toString("utf8") : undefined;
  }

  private readCentralDirectory() {
    const min = Math.max(0, this.data.length - 65557);
    let eocd = -1;
    for (let i = this.data.length - 22; i >= min; i--) {
      if (this.data.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return;

    const total = this.data.readUInt16LE(eocd + 10);
    let offset = this.data.readUInt32LE(eocd + 16);
    for (let i = 0; i < total; i++) {
      if (this.data.readUInt32LE(offset) !== 0x02014b50) break;

      const method = this.data.readUInt16LE(offset + 10);
      const compressedSize = this.data.readUInt32LE(offset + 20);
      const nameLength = this.data.readUInt16LE(offset + 28);
      const extraLength = this.data.readUInt16LE(offset + 30);
      const commentLength = this.data.readUInt16LE(offset + 32);
      const localOffset = this.data.readUInt32LE(offset + 42);
      const name = normalPath(this.data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));

      if (!name.endsWith("/") && name.startsWith("assets/")) {
        this.entries.set(name, { name, method, compressedSize, localOffset });
      }

      offset += 46 + nameLength + extraLength + commentLength;
    }
  }
}

function safeJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function parseAssetPath(path: string, pattern: RegExp) {
  const match = normalPath(path).match(pattern);
  if (!match) return undefined;
  return {
    namespace: match[1],
    name: match[2],
  };
}

function resourceLocation(value: string, defaultNamespace: string) {
  const clean = value.replace(/\.png$/, "");
  if (clean.includes(":")) return clean;
  return `${defaultNamespace}:${clean}`;
}

function generatedIconPath(itemId: string) {
  const [namespace, itemPath] = itemId.split(":", 2);
  return {
    file: join(ITEM_ICON_DIR, namespace, `${itemPath}.png`),
    url: `/generated/items/${namespace}/${itemPath}.png`,
  };
}

// 来源顺序(后者覆盖前者):版本 jar(原版) → mods/*.jar → automodpack 注入的
// mods → kubejs/assets。刻意不扫 resourcepacks:整合包会往那儿放未启用的
// 高清材质包(此包就带了个 64x 写实包),混进来会整批污染"原版长相"的图标。
function collectSourceRefs(gameRoot: string): SourceRef[] {
  const refs: SourceRef[] = [];
  const addJar = (label: string, path: string) => refs.push({ label, open: () => new ZipSource(label, path) });

  for (const name of readdirSync(gameRoot)) {
    const full = join(gameRoot, name);
    if (statSync(full).isFile() && name.endsWith(".jar")) addJar(name, full);
  }

  const modDirs = [{ prefix: "mods", root: join(gameRoot, "mods") }];
  const modpacksRoot = join(gameRoot, "automodpack", "modpacks");
  if (existsSync(modpacksRoot)) {
    for (const name of readdirSync(modpacksRoot)) {
      const root = join(modpacksRoot, name, "mods");
      if (existsSync(root) && statSync(root).isDirectory()) {
        modDirs.push({ prefix: `automodpack/${name}/mods`, root });
      }
    }
  }
  for (const { prefix, root } of modDirs) {
    for (const file of listFilesRecursive(root).filter((path) => path.endsWith(".jar"))) {
      addJar(`${prefix}/${file}`, join(root, file.split("/").join(sep)));
    }
  }

  const kubeDirs = [join(gameRoot, "kubejs", "assets")];
  if (existsSync(modpacksRoot)) {
    for (const name of readdirSync(modpacksRoot)) kubeDirs.push(join(modpacksRoot, name, "kubejs", "assets"));
  }
  for (const dir of kubeDirs) {
    if (existsSync(dir)) refs.push({ label: "kubejs/assets", open: () => new DirectorySource("kubejs/assets", dir, "assets") });
  }

  return refs;
}

// 原版 zh_cn 不在客户端 jar 里(jar 只带 en_us),而在启动器共享的
// assets 资源库中按 hash 寻址:versions/<ver>.json 的 assetIndex →
// assets/indexes/<id>.json → objects/<hash 前两位>/<hash>
function loadVanillaZhLang(gameRoot: string): Record<string, string> | undefined {
  try {
    const versionJsonPath = join(gameRoot, `${basename(gameRoot)}.json`);
    if (!existsSync(versionJsonPath)) return undefined;
    const versionJson = safeJson<{ assetIndex?: { id?: string }; assets?: string }>(readFileSync(versionJsonPath, "utf8"));
    const indexId = versionJson?.assetIndex?.id || versionJson?.assets;
    if (!indexId) return undefined;

    const assetsRoot = resolve(gameRoot, "..", "..", "assets");
    const indexPath = join(assetsRoot, "indexes", `${indexId}.json`);
    if (!existsSync(indexPath)) return undefined;
    const index = safeJson<{ objects?: Record<string, { hash?: string }> }>(readFileSync(indexPath, "utf8"));
    const hash = index?.objects?.["minecraft/lang/zh_cn.json"]?.hash;
    if (!hash) return undefined;

    const objectPath = join(assetsRoot, "objects", hash.slice(0, 2), hash);
    if (!existsSync(objectPath)) return undefined;
    return safeJson<Record<string, string>>(readFileSync(objectPath, "utf8"));
  } catch {
    return undefined;
  }
}

type ExportedIcon = {
  file: string; // 绝对路径
  label: string; // <目录名>/<文件名>,写进 iconSource 便于排查
  dir: string; // 目录名,写进 source
  parts: number; // 文件名 "__" 段数,越少越是基础款
  nameLength: number;
};

// 游戏内 IconExporter 导出的成品图标(/iconexporter export N):游戏引擎亲自渲染,
// 箱子/楼梯/代码渲染物品/染色/附魔光效都与游戏内完全一致,优先级最高。
// 目录:实例根下的 icon-exports-xN(N=分辨率),多个时取最近修改的;
// 可用环境变量 ICON_EXPORTS_DIR 指定其他目录。
// 文件名格式 modid__itemid[__元数据][__NBT或哈希].png(双下划线分隔),
// 同一物品有多个变体文件时取后缀段数最少、名字最短的"基础款"。
function loadExportedIcons(gameRoot: string): Map<string, ExportedIcon> {
  const icons = new Map<string, ExportedIcon>();

  let dir: string | undefined;
  if (process.env.ICON_EXPORTS_DIR) {
    dir = resolve(process.env.ICON_EXPORTS_DIR);
  } else {
    let newest = -1;
    try {
      for (const name of readdirSync(gameRoot)) {
        if (!/^icon-exports-x\d+$/.test(name)) continue;
        const full = join(gameRoot, name);
        const stat = statSync(full);
        if (stat.isDirectory() && stat.mtimeMs > newest) {
          newest = stat.mtimeMs;
          dir = full;
        }
      }
    } catch {
      return icons;
    }
  }
  if (!dir || !existsSync(dir)) return icons;

  const dirName = basename(dir);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".png")) continue;
    const parts = name.slice(0, -4).split("__");
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const id = `${parts[0]}:${parts[1]}`;
    const existing = icons.get(id);
    const better =
      !existing ||
      parts.length < existing.parts ||
      (parts.length === existing.parts && name.length < existing.nameLength);
    if (better) {
      icons.set(id, {
        file: join(dir, name),
        label: `${dirName}/${name}`,
        dir: dirName,
        parts: parts.length,
        nameLength: name.length,
      });
    }
  }
  return icons;
}

// 数据驱动 mod 的"容器物品"没有基础翻译键(名字由组件运行时解析,官方 lang
// 里压根不写),lang 查找必然落空。这里给合并行一个可读的兜底名。
// 注:TACZ 所有枪共享 modern_kinetic_gun 一个 id,Create 报点器聚合后只剩
// 物品 id,每把枪单独识别需要伴生 mod 暴露组件(见 README),纯读取做不到。
const EXTRA_NAMES: Record<string, { name: string; englishName?: string }> = {
  "tacz:modern_kinetic_gun": { name: "现代动能枪械", englishName: "Modern Kinetic Gun" },
  "tacz:ammo": { name: "枪械弹药", englishName: "Gun Ammo" },
  "tacz:attachment": { name: "枪械配件", englishName: "Gun Attachment" },
  "tacz:ammo_box": { name: "弹药盒", englishName: "Ammo Box" },
};

function resolveTextureReference(textures: Record<string, string>, key: string): string | undefined {  let value = textures[key];
  const seen = new Set<string>();
  while (value && value.startsWith("#")) {
    const next = value.slice(1);
    if (seen.has(next)) return undefined;
    seen.add(next);
    value = textures[next];
  }
  return value;
}

function mergeModelTextures(models: Map<string, ModelData>, location: string, depth = 0): Record<string, string> {
  if (depth > 12) return {};
  const model = models.get(location);
  if (!model) return {};

  const namespace = location.split(":", 1)[0];
  const parent = model.parent ? resourceLocation(model.parent, namespace) : undefined;
  return {
    ...(parent ? mergeModelTextures(models, parent, depth + 1) : {}),
    ...(model.textures || {}),
  };
}

// 物品模型的 parent 链(含最末一个解析不到的 parent id,如 minecraft:builtin/entity)
function modelChain(models: Map<string, ModelData>, location: string) {
  const chain: string[] = [];
  let current: string | undefined = location;
  while (current && chain.length < 16 && !chain.includes(current)) {
    chain.push(current);
    const model = models.get(current);
    if (!model) break;
    current = model.parent ? resourceLocation(model.parent, current.split(":", 1)[0]) : undefined;
  }
  return chain;
}

// 图标选取策略:
// 1) 有 layer0 → 平面物品(叠加 layer1+,如药水的液体层+瓶身层)
// 2) cross 类模型(花/树苗/菌类) → 平面
// 3) 模型链途经 block/ → 立方体等距渲染,分别挑 顶/左/右 三面贴图
// 4) 其余回退平面单贴图,最后按物品 id 猜贴图路径
function pickIconPlan(
  models: Map<string, ModelData>,
  textures: Map<string, { buffer: Buffer; source: string }>,
  itemId: string,
): IconPlan | undefined {
  const [namespace, itemPath] = itemId.split(":", 2);
  const modelId = `${namespace}:item/${itemPath}`;
  const merged = mergeModelTextures(models, modelId);
  const chain = modelChain(models, modelId);

  const tex = (key: string): PickedTexture | undefined => {
    const value = resolveTextureReference(merged, key);
    if (!value) return undefined;
    const location = resourceLocation(value, namespace);
    const texture = textures.get(location);
    return texture ? { location, ...texture } : undefined;
  };

  const layer0 = tex("layer0");
  if (layer0) {
    const layers = [layer0];
    for (const key of ["layer1", "layer2", "layer3", "layer4"]) {
      const layer = tex(key);
      if (layer) layers.push(layer);
    }
    return { kind: "flat", layers };
  }

  const cross = tex("cross");
  if (cross) return { kind: "flat", layers: [cross] };

  if (chain.some((entry) => entry.includes(":block/"))) {
    const top = tex("up") || tex("top") || tex("end") || tex("all") || tex("texture") || tex("particle") || tex("side");
    const left = tex("front") || tex("north") || tex("side") || tex("west") || tex("all") || tex("texture") || tex("particle") || top;
    const right = tex("side") || tex("east") || tex("south") || tex("all") || tex("texture") || tex("particle") || top;
    if (top && left && right) return { kind: "cube", top, left, right };
  }

  for (const key of ["all", "texture", "particle", "front", "side", "top"]) {
    const picked = tex(key);
    if (picked) return { kind: "flat", layers: [picked] };
  }

  const itemGuess = textures.get(`${namespace}:item/${itemPath}`);
  if (itemGuess) return { kind: "flat", layers: [{ location: `${namespace}:item/${itemPath}`, ...itemGuess }] };
  const blockGuess = textures.get(`${namespace}:block/${itemPath}`);
  if (blockGuess) {
    const face = { location: `${namespace}:block/${itemPath}`, ...blockGuess };
    return { kind: "cube", top: face, left: face, right: face };
  }

  return undefined;
}

export function buildAssetIndex() {
  const gameRoot = findGameRoot();
  const startedAt = now();
  const namesZh = new Map<string, string>();
  const namesEn = new Map<string, string>();
  const models = new Map<string, ModelData>();
  const itemIds = new Set<string>();
  const textures = new Map<string, { buffer: Buffer; source: string }>();

  // 原版中文名垫底,mod/kubejs 的 lang 在后面覆盖
  for (const [key, value] of Object.entries(loadVanillaZhLang(gameRoot) || {})) namesZh.set(key, value);

  for (const ref of collectSourceRefs(gameRoot)) {
    let source: AssetSource;
    try {
      source = ref.open();
    } catch {
      continue; // 损坏/读不了的 jar 跳过,不拖垮整个索引
    }
    for (const path of source.list()) {
      const lang = parseAssetPath(path, /^assets\/([^/]+)\/lang\/(zh_cn|en_us)\.json$/);
      if (lang) {
        const data = safeJson<Record<string, string>>(source.readText(path));
        const target = lang.name === "zh_cn" ? namesZh : namesEn;
        for (const [key, value] of Object.entries(data || {})) target.set(key, value);
        continue;
      }

      const itemModel = parseAssetPath(path, /^assets\/([^/]+)\/models\/item\/(.+)\.json$/);
      if (itemModel) {
        itemIds.add(`${itemModel.namespace}:${itemModel.name}`);
        const data = safeJson<ModelData>(source.readText(path));
        if (data) models.set(`${itemModel.namespace}:item/${itemModel.name}`, data);
        continue;
      }

      const blockModel = parseAssetPath(path, /^assets\/([^/]+)\/models\/block\/(.+)\.json$/);
      if (blockModel) {
        const data = safeJson<ModelData>(source.readText(path));
        if (data) models.set(`${blockModel.namespace}:block/${blockModel.name}`, data);
        continue;
      }

      // 只留 item*/block* 前缀:物品图标只会引用这两类,gui/entity/环境贴图
      // 留着只会白吃内存(199 个 mod 的贴图全量驻留会到 GB 级)
      const texture = parseAssetPath(path, /^assets\/([^/]+)\/textures\/((?:item|items|block|blocks)\/.+)\.png$/);
      if (texture) {
        const buffer = source.readBuffer(path);
        if (buffer) textures.set(`${texture.namespace}:${texture.name}`, { buffer, source: source.label });
      }
    }
  }

  // 全量重建:清掉上一次的产物,防止旧图(比如被材质包污染过的)残留被继续伺服
  rmSync(ITEM_ICON_DIR, { recursive: true, force: true });
  mkdirSync(ITEM_ICON_DIR, { recursive: true });

  // 游戏内导出图优先;导出里出现但没有物品模型文件的 id(运行时生成模型的
  // mod 物品)也并入索引,名字走 lang 查找
  const exported = loadExportedIcons(gameRoot);
  for (const id of exported.keys()) itemIds.add(id);

  const cacheTag = startedAt.toString(36);
  const items: Record<string, ItemAsset> = {};
  for (const id of [...itemIds].sort()) {
    const [namespace, itemPath] = id.split(":", 2);
    const nameKey = `item.${namespace}.${itemPath.replaceAll("/", ".")}`;
    const blockNameKey = `block.${namespace}.${itemPath.replaceAll("/", ".")}`;
    const extra = EXTRA_NAMES[id];
    const name =
      namesZh.get(nameKey) || namesZh.get(blockNameKey) || namesEn.get(nameKey) || namesEn.get(blockNameKey) || extra?.name || id;
    const englishName = namesEn.get(nameKey) || namesEn.get(blockNameKey) || extra?.englishName;

    const asset: ItemAsset = {
      id,
      name,
      englishName,
    };

    const exportedIcon = exported.get(id);
    if (exportedIcon) {
      // 游戏引擎渲染的成品,原样拷贝即是"完美"效果
      const icon = generatedIconPath(id);
      mkdirSync(dirname(icon.file), { recursive: true });
      writeFileSync(icon.file, readFileSync(exportedIcon.file));
      asset.icon = `${icon.url}?v=${cacheTag}`;
      asset.iconKind = "export";
      asset.iconSource = exportedIcon.label;
      asset.source = exportedIcon.dir;
    } else {
      const plan = pickIconPlan(models, textures, id);
      if (plan) {
        const primary = plan.kind === "flat" ? plan.layers[0] : plan.top;
        // 合成失败(源 PNG 解不开)时原样拷贝首选贴图,保底有图
        const rendered = renderIcon(plan) ?? primary.buffer;
        const icon = generatedIconPath(id);
        mkdirSync(dirname(icon.file), { recursive: true });
        writeFileSync(icon.file, rendered);
        // 内容随重建变化但 URL 不变,挂个版本参数击穿浏览器的一天缓存
        asset.icon = `${icon.url}?v=${cacheTag}`;
        asset.iconKind = plan.kind;
        asset.iconSource = primary.location;
        asset.source = primary.source;
      }
    }

    items[id] = asset;
  }

  const index: AssetIndex = {
    generatedAt: startedAt,
    gameRoot,
    count: Object.keys(items).length,
    items,
  };

  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  return index;
}

let cachedIndex: AssetIndex | undefined;
let indexPromise: Promise<AssetIndex> | undefined;

// 启动时调用一次（server/index.ts bootstrap）。扫描是同步 IO，放进微任务里
// memoize，避免第一个 /api/items 请求在请求内同步扫盘。重建靠重启（见 README）。
export function ensureAssetIndex() {
  if (!indexPromise) {
    indexPromise = Promise.resolve().then(() => {
      cachedIndex = buildAssetIndex();
      return cachedIndex;
    });
  }
  return indexPromise;
}

// 同步查询：索引未就绪时返回 undefined，标签清洗会退回 defaultDisplayName
export function getItemAsset(id: string) {
  return cachedIndex?.items[id];
}
