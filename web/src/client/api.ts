// fetch 封装：统一检查 response.ok（修原 app.js 未检查状态码的问题）。
import type { UiEnvelope } from "../shared/protocol";
import type { ItemAsset } from "./state";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} 请求失败（HTTP ${response.status}）`);
  return (await response.json()) as T;
}

export function fetchStatus() {
  return getJson<UiEnvelope>("/api/status");
}

export function fetchItems() {
  return getJson<{ items?: Record<string, ItemAsset> }>("/api/items");
}
