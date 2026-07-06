// 渲染层：保持"全量重渲染"模型——每次状态变化把各动态区域整体重建
//（静态骨架与输入框在 index.html 里，不参与重建，搜索框因此不丢焦点）。
// 自动合成页(订单卡片/详情/手动下单)在 crafting.ts,经 renderCrafting 挂入。
import type { RecipeSnapshot, StoredCommand, TargetSnapshot } from "../shared/protocol";
import { wholeBatchRequestItems } from "../shared/commands";
import { defaultDisplayName } from "../shared/summary";
import { app, itemAsset, subscribe, targetPending } from "./state";
import type { ViewId } from "./state";
import { asNumber, el, formatAmount, formatExact, formatTime, must, text, toast } from "./dom";
import { sendCommand } from "./ws";
import { openTargetDialog } from "./target-editor";
import { openRecipeDialog } from "./recipe-editor";
import { activeOrders, renderCrafting } from "./crafting";

// ---- 通用小部件 ------------------------------------------------------------

function statusClass(status: unknown): string {
  const value = text(status, "").toUpperCase();
  if (value === "ERROR") return "bad";
  if (value === "WAITING") return "warn";
  if (value === "SATISFIED" || value === "REQUESTED") return "good";
  return "";
}

const STATUS_LABELS: Record<string, string> = {
  ERROR: "错误",
  WAITING: "等待",
  SATISFIED: "已满足",
  REQUESTED: "已下单",
  DISABLED: "已停用",
  NEW: "初始化",
};

function statusLabel(status: unknown): string {
  const value = text(status, "").toUpperCase();
  return STATUS_LABELS[value] || text(status);
}

const COMMAND_KIND_LABELS: Record<string, string> = {
  request: "请求物品",
  request_recipe: "配方下单",
  cancel_order: "取消订单",
  set_enabled: "启停目标",
  target_enabled: "启停目标",
  reset_target_state: "重置状态",
  reset_target: "重置状态",
  delete_target: "删除目标",
  upsert_target: "保存目标",
  save_target: "保存目标",
  upsert_recipe: "保存样板",
  save_recipe: "保存样板",
  delete_recipe: "删除样板",
  reload_targets: "重载配置",
  snapshot: "读取快照",
  ping: "心跳",
};

function commandKindLabel(kind: unknown): string {
  const value = text(kind, "");
  return COMMAND_KIND_LABELS[value] || value || "-";
}

export function pill(label: string, tone: string) {
  return el("span", { className: `pill ${tone}`.trim(), text: label });
}

export function pendingPill(label: string) {
  return el("span", { className: "pill pending" }, [
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    label,
  ]);
}

// enabled 是权威配置;status 字段由 decide 循环滞后一拍重算——显示层以
// enabled 优先,消灭"刚停用的目标短暂显示已满足"的窗口。
function effectiveTargetStatus(target: TargetSnapshot): string {
  const status = text(target.status, "NEW").toUpperCase();
  if (target.enabled === false) return "DISABLED";
  if (status === "DISABLED") return "NEW";
  return status;
}

// 目标状态胶囊:有在途命令时显示转圈(不改写快照,乐观预测已移除)
function targetStatusPill(target: TargetSnapshot) {
  const pending = targetPending(target.id);
  if (pending) return pendingPill(pending.label);
  const status = effectiveTargetStatus(target);
  return pill(statusLabel(status), statusClass(status));
}

export function itemName(itemId: string | undefined | null): string {
  if (!itemId) return "-";
  const asset = itemAsset(itemId);
  return (asset && asset.name) || defaultDisplayName(itemId);
}

export function itemIcon(itemId: string | undefined | null, size: "s" | "m" | "l" = "m"): HTMLElement {
  const asset = itemAsset(itemId || undefined);
  if (asset?.icon) {
    // 立体合成图(64px)与游戏内导出图(64px+)缩到显示尺寸走平滑插值;16px 点阵图保持 pixelated
    const iso = asset.iconKind === "cube" || asset.iconKind === "export" ? " iso" : "";
    const img = el("img", { className: `itemIcon ${size}${iso}`, attrs: { alt: "", loading: "lazy" } });
    img.src = asset.icon;
    return img;
  }
  return el("span", {
    className: `itemIcon missing ${size}`,
    text: text(itemId, "?").slice(0, 1).toUpperCase(),
  });
}

function productLabel(target: TargetSnapshot): string {
  const product = target.products && target.products[0];
  return product ? itemName(product.item) : text(target.id);
}

function recipeById(recipeId: string | undefined): RecipeSnapshot | undefined {
  if (!recipeId) return undefined;
  return (app.snapshot?.recipes || []).find((recipe) => recipe.id === recipeId);
}

export function recipeDisplayName(recipe: RecipeSnapshot): string {
  const product = recipe.products && recipe.products[0];
  return text(recipe.name, "") || (product ? itemName(product.item) : recipe.id);
}

export function recipeLine(entries: TargetSnapshot["inputs"]): string {
  if (!entries || entries.length === 0) return "-";
  return entries.map((entry) => `${itemName(entry.item)} ×${entry.count || 1}`).join("、");
}

// 快照 productCounts 的值是 Lua 侧的产物数据表({count,targetCount,deficit,...}),
// 兼容直接给数字的旧形状
function productStockOf(counts: TargetSnapshot["productCounts"], item: string): number {
  const value = counts?.[item];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return asNumber((value as { count?: unknown }).count);
  }
  return asNumber(value);
}

// 副产物行(products[2..]):入账库存,目标库存为 0 时不驱动生产
function byproductLine(target: TargetSnapshot): string | null {
  const byproducts = (target.products || []).slice(1);
  if (byproducts.length === 0) return null;
  return byproducts
    .map((entry) => {
      const stock = formatExact(productStockOf(target.productCounts, entry.item));
      const goal = asNumber(entry.targetCount) > 0 ? `,目标 ${formatExact(asNumber(entry.targetCount))}` : "";
      return `${itemName(entry.item)} ×${entry.count || 1}(库存 ${stock}${goal})`;
    })
    .join("、");
}

export function emptyState(title: string, hints: string[] = []) {
  return el("div", { className: "emptyState" }, [
    el("p", { className: "emptyTitle", text: title }),
    ...hints.map((hint) => el("p", { className: "emptyHint", text: hint })),
  ]);
}

// ---- 侧边栏:能量核 + 网络状态 ---------------------------------------------

function renderSidebar() {
  const bridge = app.bridge || {};
  const network = app.snapshot?.network || {};
  const online = Boolean(bridge.connected);

  const core = must<HTMLElement>("#energyCore");
  core.classList.toggle("online", online);
  core.classList.toggle("offline", !online);

  must<HTMLElement>("#coreState").textContent = online ? "网络在线" : "网络离线";
  must<HTMLElement>("#coreDetail").textContent = online
    ? `${text(bridge.clientId, "控制器")} · 最后通信 ${formatTime(bridge.lastSeenAt)}`
    : app.uiConnected
      ? "等待游戏内桥接连接"
      : "正在连接控制台服务…";

  const rows: [string, string, string][] = [
    ["存储总线", network.ready ? "在线" : "离线", network.ready ? "good" : "bad"],
    ["库存条目", String(asNumber(network.stockEntries)), ""],
    ["桥接协议", text(bridge.protocol), ""],
  ];
  must<HTMLElement>("#coreStats").replaceChildren(
    ...rows.map(([label, value, tone]) =>
      el("div", { className: "coreStat" }, [
        el("span", { className: "coreStatLabel", text: label }),
        el("span", { className: `coreStatValue ${tone}`.trim(), text: value }),
      ])
    )
  );

  // 导航徽标：自动维持显示目标数,自动合成显示进行中订单数,样板管理显示样板数,
  // 命令日志显示未完成命令数
  const summary = app.snapshot?.summary || {};
  const badgeTargets = must<HTMLElement>("#navBadgeTargets");
  badgeTargets.textContent = String(asNumber(summary.total));
  badgeTargets.hidden = asNumber(summary.total) === 0;

  const orderCount = activeOrders().length;
  const badgeCrafting = must<HTMLElement>("#navBadgeCrafting");
  badgeCrafting.textContent = String(orderCount);
  badgeCrafting.hidden = orderCount === 0;

  const recipeCount = (app.snapshot?.recipes || []).length;
  const badgePatterns = must<HTMLElement>("#navBadgePatterns");
  badgePatterns.textContent = String(recipeCount);
  badgePatterns.hidden = recipeCount === 0;

  // 命令徽标只数还在等控制器回包的命令(sent);成功/失败都算已定型
  const activeCommands = (app.commands || []).filter(
    (command) => text(command.status, "").toLowerCase() === "sent"
  ).length;
  const badgeCommands = must<HTMLElement>("#navBadgeCommands");
  badgeCommands.textContent = String(activeCommands);
  badgeCommands.hidden = activeCommands === 0;
}

// ---- 总览 -------------------------------------------------------------------

function metricCard(label: string, value: string, tone = "") {
  return el("div", { className: `metric ${tone}`.trim() }, [
    el("span", { className: "metricLabel", text: label }),
    el("strong", { className: "metricValue", text: value }),
  ]);
}

function renderOverview() {
  const summary = app.snapshot?.summary || {};
  const network = app.snapshot?.network || {};

  must<HTMLElement>("#overviewMetrics").replaceChildren(
    metricCard("维持目标", String(asNumber(summary.total))),
    metricCard("已启用", String(asNumber(summary.enabled))),
    metricCard("已下单", String(asNumber(summary.requested)), asNumber(summary.requested) > 0 ? "accent" : ""),
    metricCard("等待中", String(asNumber(summary.waiting)), asNumber(summary.waiting) > 0 ? "warn" : ""),
    metricCard("错误", String(asNumber(summary.error)), asNumber(summary.error) > 0 ? "bad" : ""),
    metricCard("库存条目", String(asNumber(network.stockEntries)))
  );

  // 目标健康列表(紧凑)
  const targets = app.snapshot?.targets || [];
  const list = must<HTMLElement>("#overviewTargets");
  if (targets.length === 0) {
    list.replaceChildren(emptyState("还没有维持目标", ["到「自动维持」页新建第一个目标,网络就会自动补货。"]));
  } else {
    list.replaceChildren(
      ...targets.map((target) => {
        const product = target.products && target.products[0];
        const row = el("div", { className: "miniTarget" }, [
          itemIcon(product?.item || target.id, "s"),
          el("div", { className: "miniTargetName" }, [
            el("strong", { text: productLabel(target) }),
            el("span", { className: "muted", text: text(target.message, "") }),
          ]),
          el("span", { className: "miniTargetCount mono", text: `${formatExact(asNumber(target.productCount))} / ${formatExact(asNumber(target.targetCount))}` }),
          targetStatusPill(target),
        ]);
        return row;
      })
    );
  }

  // 最近命令(前 8 条)
  const commands = (app.commands || []).slice(0, 8);
  const commandsHost = must<HTMLElement>("#overviewCommands");
  if (commands.length === 0) {
    commandsHost.replaceChildren(emptyState("暂无命令记录"));
  } else {
    commandsHost.replaceChildren(...commands.map((command) => commandRow(command, true)));
  }

  // 消息日志
  const messagesHost = must<HTMLElement>("#overviewMessages");
  if (app.messages.length === 0) {
    messagesHost.replaceChildren(emptyState("暂无消息"));
  } else {
    messagesHost.replaceChildren(
      ...app.messages.map((message) =>
        el("div", { className: `message ${message.tone}` }, [
          el("span", { className: "mono muted", text: new Date(message.time).toLocaleTimeString("zh-CN", { hour12: false }) }),
          el("span", { text: message.text }),
        ])
      )
    );
  }
}

// ---- 物品终端 ---------------------------------------------------------------

type StockEntry = { item: string; count: number; name: string };

function stockEntries(): StockEntry[] | null {
  const counts = app.snapshot?.stockCounts;
  if (!counts) return null;
  return Object.entries(counts).map(([item, count]) => ({
    item,
    count: asNumber(count),
    name: itemName(item),
  }));
}

function renderTerminal() {
  const entries = stockEntries();
  const grid = must<HTMLElement>("#terminalGrid");
  const meta = must<HTMLElement>("#terminalMeta");
  const network = app.snapshot?.network || {};

  if (!entries) {
    meta.textContent = "";
    grid.replaceChildren(
      emptyState("快照未包含全网库存", [
        "控制器当前只上报库存条目数,未上报每种物品的数量。",
        "开启方法:编辑 computer/0/apps/me_controller/bridge.db,把 includeStock 设为 true;桥接下次重连时自动生效。",
        `当前网络共 ${asNumber(network.stockEntries)} 种库存条目(仅计数)。`,
      ])
    );
    return;
  }

  const query = app.terminalQuery.trim().toLowerCase();
  let filtered = entries;
  if (query) {
    filtered = entries.filter((entry) => {
      const asset = itemAsset(entry.item);
      return (
        entry.item.toLowerCase().includes(query) ||
        entry.name.toLowerCase().includes(query) ||
        (asset?.englishName || "").toLowerCase().includes(query)
      );
    });
  }

  filtered.sort((a, b) =>
    app.terminalSort === "name" ? a.name.localeCompare(b.name, "zh-CN") : b.count - a.count || a.name.localeCompare(b.name, "zh-CN")
  );

  meta.textContent = query
    ? `${filtered.length} / ${entries.length} 种物品 · 更新于 ${formatTime(network.lastStockReadAt)}`
    : `${entries.length} 种物品 · 更新于 ${formatTime(network.lastStockReadAt)}`;

  if (filtered.length === 0) {
    grid.replaceChildren(emptyState("没有匹配的物品", ["换个关键词试试,支持中文名、英文名和物品 ID。"]));
    return;
  }

  grid.replaceChildren(
    ...filtered.map((entry) =>
      el(
        "div",
        {
          className: "slot",
          title: `${entry.name}\n${entry.item}\n数量:${formatExact(entry.count)}`,
        },
        [itemIcon(entry.item, "l"), el("span", { className: "slotCount mono", text: formatAmount(entry.count) })]
      )
    )
  );
}

// ---- 自动维持 ---------------------------------------------------------------

function targetActions(target: TargetSnapshot): HTMLElement {
  const pending = targetPending(target.id);
  const locked = Boolean(pending);
  // 人工催单也走整批:请求量 = 每批消耗 × 整批数,Lua 侧还会按最新库存全量校验,
  // 任一原料不足整单拒发(不满足样板需求坚决不下单)
  const order = wholeBatchRequestItems(target);

  const toggle = el("button", {
    className: "ghost",
    text: target.enabled ? "停用" : "启用",
    onClick: () => sendCommand({ kind: "set_enabled", targetId: target.id, enabled: !target.enabled }),
  });
  toggle.disabled = locked;

  const edit = el("button", { className: "ghost", text: "编辑", onClick: () => openTargetDialog(target) });
  edit.disabled = locked;

  const reset = el("button", {
    className: "ghost",
    text: "重置",
    title: "清空该目标的承诺跟踪状态",
    onClick: () => sendCommand({ kind: "reset_target_state", targetId: target.id }),
  });
  reset.disabled = locked;

  const request = el("button", {
    className: "ghost",
    text: "请求",
    title: order.batches > 0
      ? `请求 ${order.batches} 整批(一张订单):${order.items.map((entry) => `${itemName(entry.item)} ×${entry.count}`).join("、")}`
      : "当前没有可请求的整批缺料",
    onClick: () => {
      sendCommand({ kind: "request", targetId: target.id, items: order.items });
    },
  });
  request.disabled = locked || order.batches === 0;

  const remove = el("button", {
    className: "ghost danger",
    text: "删除",
    onClick: () => {
      if (!confirm(`删除目标「${productLabel(target)}」?`)) return;
      sendCommand({ kind: "delete_target", targetId: target.id });
    },
  });
  remove.disabled = locked;

  return el("div", { className: "rowActions" }, [toggle, edit, reset, request, remove]);
}

function renderTargets() {
  const targets = app.snapshot?.targets || [];
  const body = must<HTMLElement>("#targetsBody");

  if (targets.length === 0) {
    const row = el("tr", {}, [el("td", { attrs: { colspan: "7" } }, [emptyState("暂无维持目标", ["点右上角「新增目标」,选择一块样板即可开始;还没有样板就先到「样板管理」创建。"])])]);
    body.replaceChildren(row);
    return;
  }

  body.replaceChildren(
    ...targets.map((target) => {
      const product = target.products && target.products[0];
      const productId = product?.item;
      const have = asNumber(target.productCount);
      const want = asNumber(target.targetCount);
      const pct = want > 0 ? Math.min(100, Math.round((have / want) * 100)) : 0;
      const byproducts = byproductLine(target);

      const bar = el("div", { className: "stockBar" }, [
        el("div", { className: `stockBarFill ${statusClass(effectiveTargetStatus(target))}`.trim() }),
      ]);
      (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;

      return el("tr", {}, [
        el("td", {}, [targetStatusPill(target)]),
        el("td", {}, [
          el("div", { className: "itemCell" }, [
            itemIcon(productId || target.id, "m"),
            el("div", { className: "targetName" }, [
              el("strong", { text: productLabel(target) }),
              el("span", { className: "mono", text: text(productId || target.id) }),
              target.recipeId
                ? el("span", {
                    className: "recipeRefLine",
                    title: `样板 ${target.recipeId}`,
                    text: `样板:${recipeById(target.recipeId) ? recipeDisplayName(recipeById(target.recipeId)!) : target.recipeId}`,
                  })
                : null,
              el("span", { title: recipeLine(target.inputs), text: `配方:${recipeLine(target.inputs)}` }),
              byproducts ? el("span", { className: "byproductLine", title: byproducts, text: `副产:${byproducts}` }) : null,
            ]),
          ]),
        ]),
        el("td", {}, [
          el("div", { className: "stockCell" }, [
            el("span", { className: "mono", text: `${formatExact(have)} / ${formatExact(want)}` }),
            bar,
          ]),
        ]),
        el("td", { className: "mono", text: String(asNumber(target.neededInputs)) }),
        el("td", { className: "mono", text: String(asNumber(target.promisedInputs)) }),
        el("td", { className: "mono", text: text(target.address) }),
        el("td", {}, [targetActions(target)]),
      ]);
    })
  );
}

// ---- 样板管理 ---------------------------------------------------------------

// 下单批数输入:配方下单 = 排队一张合成订单,原料齐备时由控制器派发,
// 进度与取消在「自动合成」页
function promptRecipeOrder(recipe: RecipeSnapshot) {
  const value = prompt(
    `下单「${recipeDisplayName(recipe)}」批数\n每批产出:${recipeLine(recipe.products)}\n每批消耗:${recipeLine(recipe.inputs)}`,
    "1"
  );
  if (value === null) return;
  const batches = Math.floor(Number(value));
  if (!Number.isFinite(batches) || batches <= 0) {
    toast("批数无效,需要正整数", "bad");
    return;
  }
  sendCommand({ kind: "request_recipe", recipeId: recipe.id, batches });
}

function recipeUsers(recipeId: string): TargetSnapshot[] {
  return (app.snapshot?.targets || []).filter((target) => target.recipeId === recipeId);
}

function renderPatterns() {
  const recipes = app.snapshot?.recipes || [];
  const body = must<HTMLElement>("#patternsBody");

  if (recipes.length === 0) {
    const row = el("tr", {}, [
      el("td", { attrs: { colspan: "6" } }, [
        emptyState("还没有样板", [
          "样板承载配方:输入、产出与工序地址;目标只引用样板。",
          "点右上角「新增样板」创建第一块,再到「自动维持」新建目标引用它。",
        ]),
      ]),
    ]);
    body.replaceChildren(row);
    return;
  }

  body.replaceChildren(
    ...recipes.map((recipe) => {
      const product = recipe.products && recipe.products[0];
      const users = recipeUsers(recipe.id);

      const order = el("button", {
        className: "ghost",
        text: "下单",
        title: "按此样板排队一张合成订单(原料齐备时派发;到「自动合成」页跟踪/取消)",
        onClick: () => promptRecipeOrder(recipe),
      });

      const edit = el("button", { className: "ghost", text: "编辑", onClick: () => openRecipeDialog(recipe) });

      const remove = el("button", {
        className: "ghost danger",
        text: "删除",
        onClick: () => {
          if (!confirm(`删除样板「${recipeDisplayName(recipe)}」?`)) return;
          sendCommand({ kind: "delete_recipe", recipeId: recipe.id });
        },
      });
      if (users.length > 0) {
        remove.disabled = true;
        remove.title = `被 ${users.length} 个目标引用:${users.map((target) => target.id).join("、")}`;
      }

      return el("tr", {}, [
        el("td", {}, [
          el("div", { className: "itemCell" }, [
            itemIcon(product?.item || recipe.id, "m"),
            el("div", { className: "targetName" }, [
              el("strong", { text: recipeDisplayName(recipe) }),
              el("span", { className: "mono", text: recipe.id }),
            ]),
          ]),
        ]),
        el("td", { title: recipeLine(recipe.products), text: recipeLine(recipe.products) }),
        el("td", { title: recipeLine(recipe.inputs), text: recipeLine(recipe.inputs) }),
        el("td", { className: "mono", text: text(recipe.address) }),
        el("td", { className: "mono", text: String(users.length) }),
        el("td", {}, [el("div", { className: "rowActions" }, [order, edit, remove])]),
      ]);
    })
  );
}

// ---- 命令日志 ---------------------------------------------------------------

// 命令状态按"执行结果"呈现:sent = 还没等到控制器回包(执行中,15 秒无回包
// 视为无响应);acknowledged/synced = Lua 执行成功后才回包,即"成功";
// failed = 执行失败,附带控制器返回的错误文本。
function commandStatusPill(command: StoredCommand) {
  const status = text(command.status, "").toLowerCase();
  if (status === "sent") {
    const age = Date.now() - asNumber(command.createdAt);
    return age > 15_000 ? pill("无响应", "warn") : pendingPill("执行中");
  }
  if (status === "failed") return pill("失败", "bad");
  if (status === "acknowledged" || status === "synced" || status === "done") return pill("成功", "good");
  return pill(text(command.status), "");
}

function commandErrorText(command: StoredCommand): string | null {
  if (text(command.status, "").toLowerCase() !== "failed") return null;
  const response = command.response;
  if (typeof response === "string" && response.trim()) return response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const error = (response as { error?: unknown }).error;
    if (error !== undefined && error !== null && error !== "") return String(error);
  }
  return "控制器未返回错误详情";
}

function commandRow(command: StoredCommand, compact = false): HTMLElement {
  const request = (command.request && typeof command.request === "object" && !Array.isArray(command.request)
    ? command.request
    : {}) as {
    kind?: string;
    targetId?: string;
    recipeId?: string;
    batches?: number;
    item?: string;
    count?: number;
    items?: Array<{ item?: string; count?: number }>;
  };
  const id = command.commandId || "";
  const kind = commandKindLabel(command.kind || request.kind);
  const detailParts: string[] = [];
  if (request.targetId) detailParts.push(`目标 ${request.targetId}`);
  if (request.recipeId) detailParts.push(`样板 ${request.recipeId}${request.batches ? ` ×${request.batches} 批` : ""}`);
  if (Array.isArray(request.items) && request.items.length > 0) {
    detailParts.push(request.items.map((entry) => `${itemName(String(entry.item || ""))} ×${asNumber(entry.count) || 1}`).join("、"));
  } else if (request.item) {
    detailParts.push(`${itemName(request.item)} ×${asNumber(request.count) || 1}`);
  }
  const errorText = commandErrorText(command);

  const children: (Node | string | null)[] = [
    el("span", { className: "mono muted", text: formatTime(command.createdAt) }),
    el("div", { className: "commandMain" }, [
      el("strong", { text: kind }),
      detailParts.length > 0 ? el("span", { className: "muted", text: detailParts.join(" · ") }) : null,
      errorText ? el("span", { className: "commandError", title: errorText, text: errorText }) : null,
      compact ? null : el("span", { className: "mono muted commandId", text: id }),
    ]),
    commandStatusPill(command),
  ];
  return el("div", { className: "listItem", title: id }, children);
}

function renderCommands() {
  const commands = app.commands || [];
  must<HTMLElement>("#commandCount").textContent = String(commands.length);
  const host = must<HTMLElement>("#commandsList");
  if (commands.length === 0) {
    host.replaceChildren(emptyState("暂无命令", ["在「自动维持」页操作目标,命令会出现在这里并跟踪到完成。"]));
    return;
  }
  host.replaceChildren(...commands.map((command) => commandRow(command)));
}

// ---- 视图切换 + 主渲染 --------------------------------------------------------

const VIEWS: ViewId[] = ["overview", "terminal", "targets", "crafting", "patterns", "commands"];

function renderActiveView() {
  for (const view of VIEWS) {
    const section = document.querySelector<HTMLElement>(`#view-${view}`);
    if (section) section.hidden = view !== app.view;
    const link = document.querySelector<HTMLElement>(`#nav-${view}`);
    if (link) link.classList.toggle("active", view === app.view);
  }

  switch (app.view) {
    case "overview":
      renderOverview();
      break;
    case "terminal":
      renderTerminal();
      break;
    case "targets":
      renderTargets();
      break;
    case "crafting":
      renderCrafting();
      break;
    case "patterns":
      renderPatterns();
      break;
    case "commands":
      renderCommands();
      break;
    default:
      break;
  }
}

export function render() {
  renderSidebar();
  renderActiveView();
}

export function startRendering() {
  subscribe(render);
  render();
}
