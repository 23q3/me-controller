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
