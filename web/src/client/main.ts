// 入口:hash 路由(#/terminal 等,刷新后停留在原视图)、事件接线、启动加载。
import { app, notify, pushMessage, sweepPendingTargets } from "./state";
import type { ViewId } from "./state";
import { must, toast } from "./dom";
import { fetchItems } from "./api";
import { connect, reloadStatus, requestRefresh } from "./ws";
import { startRendering } from "./render";
import { openTargetDialog, wireTargetEditor } from "./target-editor";
import { openRecipeDialog, wireRecipeEditor } from "./recipe-editor";

const VIEW_ROUTES: Record<string, ViewId> = {
  "#/overview": "overview",
  "#/terminal": "terminal",
  "#/targets": "targets",
  "#/crafting": "crafting",
  "#/patterns": "patterns",
  "#/commands": "commands",
};

function syncViewFromHash() {
  app.view = VIEW_ROUTES[location.hash] || "overview";
  notify();
}

function wireEvents() {
  window.addEventListener("hashchange", syncViewFromHash);

  must<HTMLButtonElement>("#refreshBtn").addEventListener("click", () => requestRefresh());
  must<HTMLButtonElement>("#addTargetBtn").addEventListener("click", () => openTargetDialog(null));
  must<HTMLButtonElement>("#addRecipeBtn").addEventListener("click", () => openRecipeDialog(null));

  const search = must<HTMLInputElement>("#terminalSearch");
  search.addEventListener("input", () => {
    app.terminalQuery = search.value;
    notify();
  });

  const sort = must<HTMLSelectElement>("#terminalSort");
  sort.addEventListener("change", () => {
    app.terminalSort = sort.value === "name" ? "name" : "count";
    notify();
  });

  wireTargetEditor();
  wireRecipeEditor();
}

async function loadItems() {
  const payload = await fetchItems();
  app.items = payload.items || {};
  pushMessage(`已加载 ${Object.keys(app.items).length} 个物品索引`, "info");
  notify();
}

syncViewFromHash();
wireEvents();
startRendering();

// 在途命令超时清扫:转圈最多挂 12 秒,超时给出明确提示而不是永远转下去
setInterval(() => {
  const expired = sweepPendingTargets();
  if (expired.length === 0) return;
  for (const { targetId, entry } of expired) {
    toast(`操作超时:${targetId} ${entry.label.replace(/中$/, "")}未收到控制器确认`, "bad");
    pushMessage(`操作超时:${targetId} ${entry.label}(${entry.commandId})`, "bad");
  }
  notify();
}, 2000);

reloadStatus().catch((error) => {
  pushMessage(error instanceof Error ? error.message : String(error), "bad");
  notify();
});
loadItems().catch((error) => {
  const message = `物品索引加载失败:${error instanceof Error ? error.message : String(error)}`;
  pushMessage(message, "bad");
  toast(message, "bad");
  notify();
});
connect();
