import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export type ItemAsset = {
  id: string;
  name: string;
  englishName?: string;
  icon?: string;
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

type ModelData = {
  parent?: string;
  textures?: Record<string, string>;
};

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

function collectSources(gameRoot: string): AssetSource[] {
  const sources: AssetSource[] = [];

  for (const name of readdirSync(gameRoot)) {
    const full = join(gameRoot, name);
    if (statSync(full).isFile() && name.endsWith(".jar")) sources.push(new ZipSource(name, full));
  }

  const modsRoot = join(gameRoot, "mods");
  for (const file of listFilesRecursive(modsRoot).filter((path) => path.endsWith(".jar"))) {
    const full = join(modsRoot, file.split("/").join(sep));
    sources.push(new ZipSource(`mods/${file}`, full));
  }

  const kubeAssets = join(gameRoot, "kubejs", "assets");
  if (existsSync(kubeAssets)) sources.push(new DirectorySource("kubejs/assets", kubeAssets, "assets"));

  const resourcePacks = join(gameRoot, "resourcepacks");
  if (existsSync(resourcePacks)) {
    for (const name of readdirSync(resourcePacks)) {
      const full = join(resourcePacks, name);
      const stat = statSync(full);
      if (stat.isDirectory()) sources.push(new DirectorySource(`resourcepacks/${name}`, full));
      else if (stat.isFile() && (name.endsWith(".zip") || name.endsWith(".jar"))) {
        sources.push(new ZipSource(`resourcepacks/${name}`, full));
      }
    }
  }

  return sources;
}

function resolveTextureReference(textures: Record<string, string>, key: string): string | undefined {
  let value = textures[key];
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

function pickTexture(models: Map<string, ModelData>, textures: Map<string, { buffer: Buffer; source: string }>, itemId: string) {
  const namespace = itemId.split(":", 1)[0];
  const model = models.get(`${namespace}:item/${itemId.split(":")[1]}`);
  const merged = model ? mergeModelTextures(models, `${namespace}:item/${itemId.split(":")[1]}`) : {};

  for (const key of ["layer0", "all", "particle", "front", "side", "top"]) {
    const picked = resolveTextureReference(merged, key);
    if (picked) {
      const loc = resourceLocation(picked, namespace);
      const texture = textures.get(loc);
      if (texture) return { location: loc, ...texture };
    }
  }

  for (const guess of [`${namespace}:item/${itemId.split(":")[1]}`, `${namespace}:block/${itemId.split(":")[1]}`]) {
    const texture = textures.get(guess);
    if (texture) return { location: guess, ...texture };
  }

  return undefined;
}

export function buildAssetIndex() {
  const gameRoot = findGameRoot();
  const startedAt = now();
  const sources = collectSources(gameRoot);
  const namesZh = new Map<string, string>();
  const namesEn = new Map<string, string>();
  const models = new Map<string, ModelData>();
  const itemIds = new Set<string>();
  const textures = new Map<string, { buffer: Buffer; source: string }>();

  for (const source of sources) {
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

      const texture = parseAssetPath(path, /^assets\/([^/]+)\/textures\/(.+)\.png$/);
      if (texture) {
        const buffer = source.readBuffer(path);
        if (buffer) textures.set(`${texture.namespace}:${texture.name}`, { buffer, source: source.label });
      }
    }
  }

  mkdirSync(ITEM_ICON_DIR, { recursive: true });

  const items: Record<string, ItemAsset> = {};
  for (const id of [...itemIds].sort()) {
    const [namespace, itemPath] = id.split(":", 2);
    const nameKey = `item.${namespace}.${itemPath.replaceAll("/", ".")}`;
    const blockNameKey = `block.${namespace}.${itemPath.replaceAll("/", ".")}`;
    const name = namesZh.get(nameKey) || namesZh.get(blockNameKey) || namesEn.get(nameKey) || namesEn.get(blockNameKey) || id;
    const englishName = namesEn.get(nameKey) || namesEn.get(blockNameKey);
    const picked = pickTexture(models, textures, id);

    const asset: ItemAsset = {
      id,
      name,
      englishName,
    };

    if (picked) {
      const icon = generatedIconPath(id);
      mkdirSync(dirname(icon.file), { recursive: true });
      writeFileSync(icon.file, picked.buffer);
      asset.icon = icon.url;
      asset.iconSource = picked.location;
      asset.source = picked.source;
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

export function getAssetIndex() {
  if (!cachedIndex) cachedIndex = buildAssetIndex();
  return cachedIndex;
}

export function getItemAsset(id: string) {
  return getAssetIndex().items[id];
}
