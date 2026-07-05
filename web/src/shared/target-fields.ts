// 目标字段清洗（自原 server/index.ts 95-237 提取）。
// 红线：sanitizeTargetForController 必须继续产出"双表示"——
// products[]/inputs[] 数组与 legacy 标量（productItem/productLabel/inputItem/
// inputLabel）同时在场且一致；仅当 inputs 数组非空时删除 inputPerProduct
// （交由 Lua 侧按配方重新推导）。
// 资产名解析经 resolveAssetName 注入：服务端传 assets 索引查询，客户端传自己的
// item-index 查询——本模块保持纯净，两端 bundle 均可引用。
import type { JsonValue } from "./protocol";
import { defaultDisplayName } from "./summary";

export type JsonRecord = { [key: string]: JsonValue };
export type AssetNameResolver = (itemId: string) => string | undefined;

// 目标可编辑字段的默认值（与 Lua config.lua 的 TARGET_DEFAULTS 对齐，勿单边改）
export const TARGET_DEFAULTS = {
  enabled: true,
  address: "press",
  priority: 100,
  targetCount: 2048,
  requestCooldownSeconds: 5,
  minImmediateRequest: 64,
  delayedRequestSeconds: 20,
  promiseTtlSeconds: 90,
  maxOutstandingInputs: 1024,
  maxRequestPerCycle: 576,
  deficitConfirmScans: 3,
  deficitConfirmSeconds: 2,
  stockDropConfirmScans: 3,
  stockDropConfirmSeconds: 2,
} as const;

// 数值配置字段描述符——目标编辑器的表单由它驱动（新增字段只改这张表）。
// group 决定字段渲染进哪个区块；min 是 UI 与读取时共同的下限。
export type TargetNumberField = {
  key:
    | "priority"
    | "requestCooldownSeconds"
    | "minImmediateRequest"
    | "delayedRequestSeconds"
    | "promiseTtlSeconds"
    | "maxOutstandingInputs"
    | "maxRequestPerCycle"
    | "deficitConfirmScans"
    | "deficitConfirmSeconds"
    | "stockDropConfirmScans"
    | "stockDropConfirmSeconds";
  label: string;
  min: number;
  group: "basic" | "advanced";
  hint?: string;
};

export const TARGET_NUMBER_FIELDS: TargetNumberField[] = [
  { key: "priority", label: "优先级", min: 0, group: "basic" },
  { key: "requestCooldownSeconds", label: "请求冷却（秒）", min: 0, group: "advanced" },
  { key: "minImmediateRequest", label: "立即请求批量", min: 1, group: "advanced" },
  { key: "delayedRequestSeconds", label: "小批量等待（秒）", min: 0, group: "advanced" },
  { key: "promiseTtlSeconds", label: "承诺 TTL（秒）", min: 1, group: "advanced" },
  { key: "maxOutstandingInputs", label: "最大在途输入", min: 1, group: "advanced" },
  { key: "maxRequestPerCycle", label: "单轮最大请求", min: 1, group: "advanced" },
  { key: "deficitConfirmScans", label: "低库存确认扫描", min: 1, group: "advanced" },
  { key: "deficitConfirmSeconds", label: "低库存确认（秒）", min: 0, group: "advanced" },
  { key: "stockDropConfirmScans", label: "库存下降确认扫描", min: 1, group: "advanced" },
  { key: "stockDropConfirmSeconds", label: "库存下降确认（秒）", min: 0, group: "advanced" },
];

// upsert 时从既有目标带回的全部可编辑键（与 Lua targets_store 的可持久字段对齐）
export const TARGET_CONFIG_KEYS = [
  "id",
  "enabled",
  "recipeId",
  "address",
  "priority",
  "products",
  "inputs",
  "productItem",
  "productLabel",
  "targetCount",
  "inputItem",
  "inputLabel",
  ...TARGET_NUMBER_FIELDS.filter((field) => field.key !== "priority").map((field) => field.key),
] as const;

// 这些是控制器运行时回填的字段，upsert 回传时必须剥掉
export const RUNTIME_TARGET_FIELDS = [
  "status",
  "message",
  "productCount",
  "productCounts",
  "inputCount",
  "inputCounts",
  "baseTargetCount",
  "dependencyDemand",
  "deficitProducts",
  "desiredBatches",
  "neededBatches",
  "neededInputs",
  "neededInputItems",
  "promisedInputs",
  "promisedInputItems",
  "promisedBatches",
  "promisedProducts",
  "nextExpiry",
  "lastChangedAt",
];

export function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function manualDisplayLabel(value: JsonValue | undefined, itemId: string, resolveAssetName?: AssetNameResolver) {
  const label = stringValue(value);
  const assetName = resolveAssetName?.(itemId);
  if (!label || label === itemId || label === assetName || label === defaultDisplayName(itemId)) return null;
  return label;
}

function recipeEntryItem(entry: JsonRecord) {
  return stringValue(entry.item) || stringValue(entry.name) || stringValue(entry.itemId);
}

function sanitizeRecipeEntry(value: JsonValue, resolveAssetName?: AssetNameResolver) {
  if (!isJsonRecord(value)) return value;
  const entry: JsonRecord = { ...value };
  const item = recipeEntryItem(entry);
  if (item) {
    entry.item = item;
    const label = manualDisplayLabel(entry.label ?? entry.displayName, item, resolveAssetName);
    if (label) entry.label = label;
    else delete entry.label;
  }
  return entry;
}

function sanitizeRecipeEntries(value: JsonValue | undefined, resolveAssetName?: AssetNameResolver): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((entry) => sanitizeRecipeEntry(entry, resolveAssetName));
  if (isJsonRecord(value)) return sanitizeRecipeEntry(value, resolveAssetName);
  return value;
}

function firstRecipeItem(value: JsonValue | undefined) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      const item = recipeEntryItem(entry);
      if (item) return item;
    }
    return null;
  }

  if (isJsonRecord(value)) return recipeEntryItem(value);
  return null;
}

function firstRecipeLabel(value: JsonValue | undefined) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      const label = stringValue(entry.label);
      if (label) return label;
    }
    return null;
  }

  if (isJsonRecord(value)) return stringValue(value.label);
  return null;
}

function setFirstRecipeLabel(value: JsonValue | undefined, label: string) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      if (!stringValue(entry.label)) entry.label = label;
      return;
    }
  } else if (isJsonRecord(value) && !stringValue(value.label)) {
    value.label = label;
  }
}

export function sanitizeTargetForController(rawTarget: JsonValue, resolveAssetName?: AssetNameResolver) {
  if (!isJsonRecord(rawTarget)) return rawTarget;

  const target: JsonRecord = { ...rawTarget };
  for (const field of RUNTIME_TARGET_FIELDS) delete target[field];

  const products = sanitizeRecipeEntries(target.products ?? target.outputs, resolveAssetName);
  const inputs = sanitizeRecipeEntries(target.inputs ?? target.ingredients, resolveAssetName);
  if (products !== undefined) target.products = products;
  if (inputs !== undefined) target.inputs = inputs;

  const productItem = firstRecipeItem(products) || stringValue(target.productItem);
  if (productItem) {
    const productLabel =
      firstRecipeLabel(products) ||
      manualDisplayLabel(target.productLabel, productItem, resolveAssetName) ||
      defaultDisplayName(productItem);
    target.productItem = productItem;
    target.productLabel = productLabel;
    setFirstRecipeLabel(products, productLabel);
  }

  const inputItem = firstRecipeItem(inputs) || stringValue(target.inputItem);
  if (inputItem) {
    const inputLabel =
      firstRecipeLabel(inputs) ||
      manualDisplayLabel(target.inputLabel, inputItem, resolveAssetName) ||
      defaultDisplayName(inputItem);
    target.inputItem = inputItem;
    target.inputLabel = inputLabel;
    setFirstRecipeLabel(inputs, inputLabel);
  }

  if (Array.isArray(target.inputs) && target.inputs.length > 0) delete target.inputPerProduct;

  return target;
}

// 样板 upsert 的字段白名单：样板只有配方内容（输入/输出/地址）与展示名
export const RECIPE_CONFIG_KEYS = ["id", "name", "address", "products", "inputs"] as const;

// 样板清洗：白名单字段 + 条目标签清洗（自动生成形态剥除，交 Lua/显示层推导）。
// 样板条目不携带 targetCount——那是目标侧库存策略，混入时一并剥掉。
export function sanitizeRecipeForController(rawRecipe: JsonValue, resolveAssetName?: AssetNameResolver) {
  if (!isJsonRecord(rawRecipe)) return rawRecipe;

  const recipe: JsonRecord = {};
  for (const key of RECIPE_CONFIG_KEYS) {
    if (rawRecipe[key] !== undefined) recipe[key] = rawRecipe[key];
  }

  for (const key of ["products", "inputs"] as const) {
    const entries = sanitizeRecipeEntries(recipe[key], resolveAssetName);
    if (entries === undefined) continue;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (isJsonRecord(entry)) delete entry.targetCount;
    }
    recipe[key] = entries;
  }

  const primaryItem = firstRecipeItem(recipe.products);
  if (primaryItem) {
    const name = manualDisplayLabel(recipe.name, primaryItem, resolveAssetName);
    if (name) {
      recipe.name = name;
      setFirstRecipeLabel(recipe.products, name);
    } else {
      delete recipe.name;
    }
  }

  return recipe;
}
