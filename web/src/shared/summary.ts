// 汇总统计与显示名推导 —— 服务端与客户端 bundle 共用的单实现
// （消灭原 index.ts / app.js 各一份的复制）。
// defaultDisplayName 与 Lua 侧 items.lua 的同名函数语义对齐，勿单边改。
import type { ControllerSnapshot } from "./protocol";

export function defaultDisplayName(itemId: string) {
  const rawName = itemId.includes(":") ? itemId.slice(itemId.lastIndexOf(":") + 1) : itemId;
  const words = rawName
    .replace(/[_\-./]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return itemId || "Item";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export function recomputeSummary(snapshot: ControllerSnapshot) {
  const targets = snapshot.targets || [];
  const summary = {
    total: targets.length,
    enabled: 0,
    requested: 0,
    waiting: 0,
    error: 0,
    satisfied: 0,
    disabled: 0,
  };

  for (const target of targets) {
    if (target.enabled) summary.enabled += 1;
    if (target.status === "REQUESTED") summary.requested += 1;
    else if (target.status === "WAITING") summary.waiting += 1;
    else if (target.status === "ERROR") summary.error += 1;
    else if (target.status === "SATISFIED") summary.satisfied += 1;
    else if (target.status === "DISABLED") summary.disabled += 1;
  }

  snapshot.summary = summary;
}
