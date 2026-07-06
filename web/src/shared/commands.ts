// 命令清洗的单实现 + Lua applyCommand 语义的 TS 对照。
// applyCommandToSnapshot 已不再用于生产乐观层（UI/服务端的乐观预测已移除，
// 界面改为 pending 转圈等待权威快照）；保留它是作为 Lua 侧命令语义的可执行
// 文档，由 tests/commands.test.ts 的金样配对锁定，勿删。
// 它只是"会被下一份控制器快照覆盖的预览"——Lua 侧 applyCommand 才是权威。
// 命令别名对（红线，与 Lua commands.lua 对齐）：
//   set_enabled/target_enabled、upsert_target/save_target、
//   reset_target_state/reset_target、delete_target、
//   upsert_recipe/save_recipe、delete_recipe、request_recipe
import type { ControllerCommand, ControllerSnapshot, TargetSnapshot } from "./protocol";
import type { AssetNameResolver } from "./target-fields";
import { sanitizeRecipeForController, sanitizeTargetForController } from "./target-fields";
import { recomputeSummary } from "./summary";

function primaryProduct(target: Record<string, unknown>) {
  const products = Array.isArray(target.products) ? target.products : [];
  return products[0] as Record<string, unknown> | undefined;
}

export function targetDisplayId(target: Record<string, unknown>) {
  return String(target.id || (primaryProduct(target)?.item ?? "target"));
}

// 人工催单也必须整批对齐样板:请求量 = 每批消耗 × 整批数,批数取
// min(neededBatches, 单物品 64 上限换算的批数上限;超大配方保底 1 批)。
// Lua 侧同样校验(残缺/畸比/库存不足直接拒单),这里算出的就是合法请求。
// batches 为 0 表示当前没有可请求的整批缺料(按钮应禁用)。
export function wholeBatchRequestItems(
  target: TargetSnapshot
): { batches: number; items: Array<{ item: string; count: number }> } {
  const inputs = (target.inputs || [])
    .filter((entry) => Boolean(entry.item))
    .map((entry) => ({ item: entry.item, per: Math.max(1, Math.floor(Number(entry.count) || 1)) }));
  const neededBatches = Math.max(0, Math.floor(Number(target.neededBatches) || 0));
  if (inputs.length === 0 || neededBatches <= 0) return { batches: 0, items: [] };

  const maxPer = Math.max(...inputs.map((entry) => entry.per));
  const capBatches = Math.max(1, Math.floor(64 / maxPer));
  const batches = Math.min(neededBatches, capBatches);
  return { batches, items: inputs.map((entry) => ({ item: entry.item, count: entry.per * batches })) };
}

export function sanitizeCommandForController(
  command: ControllerCommand,
  resolveAssetName?: AssetNameResolver
): ControllerCommand {
  if ((command.kind === "upsert_target" || command.kind === "save_target") && command.target !== undefined) {
    return {
      ...command,
      target: sanitizeTargetForController(command.target, resolveAssetName),
    };
  }

  if ((command.kind === "upsert_recipe" || command.kind === "save_recipe") && command.recipe !== undefined) {
    return {
      ...command,
      recipe: sanitizeRecipeForController(command.recipe, resolveAssetName),
    };
  }

  return command;
}

export function optimisticTargetFromCommandTarget(raw: unknown): TargetSnapshot {
  const target = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const products = Array.isArray(target.products) ? target.products : [];
  const firstProduct = products[0] as Record<string, unknown> | undefined;
  const id = targetDisplayId(target);
  return {
    id,
    enabled: target.enabled !== false,
    address: String(target.address || "press"),
    priority: Number(target.priority || 100),
    products: products as never[],
    inputs: (Array.isArray(target.inputs) ? target.inputs : []) as never[],
    status: target.enabled === false ? "DISABLED" : "NEW",
    message: "等待下一次控制器快照确认",
    productCount: 0,
    targetCount: Number(firstProduct?.targetCount || 0),
    neededInputs: 0,
    promisedInputs: 0,
  };
}

export function applyCommandToSnapshot(
  snapshot: ControllerSnapshot | null,
  command: ControllerCommand
): ControllerSnapshot | null {
  if (!snapshot) return snapshot;
  const next = JSON.parse(JSON.stringify(snapshot)) as ControllerSnapshot;
  const targets = next.targets || [];
  next.targets = targets;

  if ((command.kind === "set_enabled" || command.kind === "target_enabled") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    if (target) {
      target.enabled = command.enabled !== false;
      target.status = target.enabled ? "NEW" : "DISABLED";
      target.message = target.enabled ? "已发送启用命令，等待确认" : "已发送停用命令，等待确认";
    }
  } else if (command.kind === "delete_target" && command.targetId) {
    next.targets = targets.filter((item) => item.id !== command.targetId);
  } else if ((command.kind === "upsert_target" || command.kind === "save_target") && command.target) {
    const optimistic = optimisticTargetFromCommandTarget(command.target);
    const targetId = command.targetId || optimistic.id;
    const index = targets.findIndex((item) => item.id === targetId);
    if (index >= 0) targets[index] = { ...targets[index], ...optimistic };
    else targets.push(optimistic);
  } else if ((command.kind === "reset_target_state" || command.kind === "reset_target") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    if (target) {
      target.promisedInputs = 0;
      target.promisedInputItems = {};
      target.message = "已发送重置命令，等待确认";
    }
  }

  recomputeSummary(next);
  return next;
}
