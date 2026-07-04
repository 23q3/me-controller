// 命令清洗的单实现 + Lua applyCommand 语义的 TS 对照。
// applyCommandToSnapshot 已不再用于生产乐观层（UI/服务端的乐观预测已移除，
// 界面改为 pending 转圈等待权威快照）；保留它是作为 Lua 侧命令语义的可执行
// 文档，由 tests/commands.test.ts 的金样配对锁定，勿删。
// 它只是"会被下一份控制器快照覆盖的预览"——Lua 侧 applyCommand 才是权威。
// 命令别名对（红线，与 Lua commands.lua 对齐）：
//   set_enabled/target_enabled、upsert_target/save_target、
//   reset_target_state/reset_target、delete_target
import type { ControllerCommand, ControllerSnapshot, TargetSnapshot } from "./protocol";
import type { AssetNameResolver } from "./target-fields";
import { sanitizeTargetForController } from "./target-fields";
import { recomputeSummary } from "./summary";

function primaryProduct(target: Record<string, unknown>) {
  const products = Array.isArray(target.products) ? target.products : [];
  return products[0] as Record<string, unknown> | undefined;
}

export function targetDisplayId(target: Record<string, unknown>) {
  return String(target.id || (primaryProduct(target)?.item ?? "target"));
}

export function sanitizeCommandForController(
  command: ControllerCommand,
  resolveAssetName?: AssetNameResolver
): ControllerCommand {
  if ((command.kind !== "upsert_target" && command.kind !== "save_target") || command.target === undefined) {
    return command;
  }

  return {
    ...command,
    target: sanitizeTargetForController(command.target, resolveAssetName),
  };
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
