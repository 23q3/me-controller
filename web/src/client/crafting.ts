// 自动合成页(AE2 合成任务风格):订单卡片网格 + 订单详情 dialog + 手动下单 dialog。
// 数据源是快照的 orders 数组(下单纳管:自动维持/样板下单/缺料催单都以订单呈现);
// 快照 1s 心跳全量刷新,详情 dialog 打开时跟随快照实时重绘。
// 取消语义(与 Lua orders.lua 对齐):排队单真取消;在途单只是释放跟踪——
// Create 物流没有召回 API,包裹已物理发出无法撤回。
// 手动下单 = request_recipe(样板 × 批数);未来"请求合成"的合成链规划器
// 沿用同一入口与订单协议(jobId/parentOrderId 已预留)。
import type { OrderSnapshot, RecipeSnapshot } from "../shared/protocol";
import { app, markPendingOrder, orderPending, subscribe } from "./state";
import { asNumber, el, formatExact, formatTime, must, text, toast } from "./dom";
import { makeCommandId, sendCommand } from "./ws";
import { emptyState, itemIcon, itemName, pendingPill, pill, recipeDisplayName, recipeLine } from "./render";

// ---- 订单数据助手 -----------------------------------------------------------

const ACTIVE_STATUS = new Set(["queued", "dispatched"]);

const ORDER_STATUS_LABELS: Record<string, [string, string]> = {
  queued: ["排队中", "warn"],
  dispatched: ["进行中", "good"],
  completed: ["已完成", "good"],
  expired: ["跟踪超时", "warn"],
  failed: ["失败", "bad"],
  cancelled: ["已取消", ""],
};

const ORDER_KIND_LABELS: Record<string, string> = {
  maintain: "自动维持",
  recipe: "样板订单",
  manual: "手动请求",
  chain: "合成链",
};

const ORDER_SOURCE_LABELS: Record<string, string> = {
  web: "网页",
  local: "控制器",
  remote: "远程",
};

function orderStatus(order: OrderSnapshot): string {
  return text(order.status, "").toLowerCase();
}

function isActiveOrder(order: OrderSnapshot): boolean {
  return ACTIVE_STATUS.has(orderStatus(order));
}

// Lua 空表序列化成 {} 而非 []:凡是数组字段都要 Array.isArray 守卫
function ordersOf(): OrderSnapshot[] {
  const orders = app.snapshot?.orders;
  return Array.isArray(orders) ? orders : [];
}

function orderItems(order: OrderSnapshot): Array<{ item: string; count: number }> {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.map((entry) => ({ item: text(entry.item, ""), count: asNumber(entry.count) }));
}

function orderProducts(order: OrderSnapshot): Array<{ item: string; count: number }> {
  const products = Array.isArray(order.products) ? order.products : [];
  return products.map((entry) => ({ item: text(entry.item, ""), count: asNumber(entry.count) }));
}

export function activeOrders(): OrderSnapshot[] {
  return ordersOf().filter(isActiveOrder);
}

function targetById(targetId: string | undefined) {
  if (!targetId) return undefined;
  return (app.snapshot?.targets || []).find((target) => target.id === targetId);
}

function orderIconItem(order: OrderSnapshot): string | undefined {
  const product = orderProducts(order)[0];
  if (product?.item) return product.item;
  const target = targetById(order.targetId);
  const targetProduct = target?.products && target.products[0];
  if (targetProduct?.item) return targetProduct.item;
  return orderItems(order)[0]?.item;
}

function orderTitle(order: OrderSnapshot): string {
  if (order.recipeName) return order.recipeName;
  const product = orderProducts(order)[0];
  if (product?.item) return itemName(product.item);
  const target = targetById(order.targetId);
  const targetProduct = target?.products && target.products[0];
  if (targetProduct?.item) return itemName(targetProduct.item);
  if (order.targetId) return order.targetId;
  const first = orderItems(order)[0];
  return first ? itemName(first.item) : text(order.id);
}

function orderKindLabel(order: OrderSnapshot): string {
  const kind = text(order.kind, "");
  return ORDER_KIND_LABELS[kind] || kind || "-";
}

function orderSourceLabel(order: OrderSnapshot): string {
  const source = text(order.source, "");
  return ORDER_SOURCE_LABELS[source] || source || "-";
}

function orderStatusPill(order: OrderSnapshot) {
  const pending = order.id ? orderPending(order.id) : null;
  if (pending) return pendingPill(pending.label);
  const status = orderStatus(order);
  const entry = ORDER_STATUS_LABELS[status];
  if (!entry) return pill(text(order.status), "");
  return pill(entry[0], entry[1]);
}

// 进度:目标联动单看承诺结算(已交付原料),样板单看主产物入账(基线观测)
function orderProgress(order: OrderSnapshot): { done: number; total: number; label: string } | null {
  if (orderStatus(order) !== "dispatched") return null;
  if (order.tracked) {
    const total = asNumber(order.trackedInputs);
    if (total <= 0) return null;
    const done = Math.max(0, Math.min(total, total - asNumber(order.remainingInputs)));
    return { done, total, label: "原料结算" };
  }
  const product = orderProducts(order)[0];
  if (product && product.count > 0) {
    const done = Math.max(0, Math.min(product.count, asNumber(order.deliveredProducts)));
    return { done, total: product.count, label: "产出入账" };
  }
  return null;
}

function progressBar(progress: { done: number; total: number; label: string }) {
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const bar = el("div", { className: "stockBar" }, [el("div", { className: "stockBarFill good" })]);
  (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  return el("div", { className: "orderProgress", title: `${progress.label} ${formatExact(progress.done)} / ${formatExact(progress.total)}` }, [
    bar,
    el("span", { className: "mono muted", text: `${formatExact(progress.done)}/${formatExact(progress.total)}` }),
  ]);
}

// ---- 取消 --------------------------------------------------------------------

function confirmCancelText(order: OrderSnapshot): string {
  return orderStatus(order) === "queued"
    ? `取消排队订单「${orderTitle(order)}」?(尚未派发,原料不会发出)`
    : `取消在途订单「${orderTitle(order)}」?\n包裹已发出无法召回,取消只是释放跟踪(目标承诺同时解除,决策器会按真实库存重新评估)。`;
}

function cancelOrder(order: OrderSnapshot) {
  if (!order.id) return;
  if (!confirm(confirmCancelText(order))) return;
  const commandId = makeCommandId();
  if (sendCommand({ kind: "cancel_order", orderId: order.id, commandId, id: commandId })) {
    markPendingOrder(order.id, { commandId, label: "取消中" });
  }
}

// ---- 订单卡片 ----------------------------------------------------------------

function orderChips(order: OrderSnapshot): HTMLElement {
  const items = orderItems(order);
  const chips: (Node | null)[] = [
    el("span", { className: "orderChip", text: orderKindLabel(order) }),
    el("span", { className: "orderChip", text: orderSourceLabel(order) }),
    order.batches ? el("span", { className: "orderChip", text: `×${formatExact(asNumber(order.batches))} 批` }) : null,
    el("span", { className: "orderChip", text: `${items.length} 种原料 · ${formatExact(asNumber(order.wanted))} 件` }),
    order.jobId ? el("span", { className: "orderChip", title: `合成链作业 ${order.jobId}`, text: `作业 ${order.jobId}` }) : null,
  ];
  return el("div", { className: "orderChips" }, chips);
}

function orderNoteLine(order: OrderSnapshot): HTMLElement | null {
  const error = text(order.error, "");
  if (error && error !== "-") {
    return el("p", { className: "orderNote bad", title: error, text: error });
  }
  const note = text(order.note, "");
  if (note && note !== "-") {
    return el("p", { className: "orderNote muted", title: note, text: note });
  }
  return null;
}

function orderCard(order: OrderSnapshot): HTMLElement {
  const active = isActiveOrder(order);
  const status = orderStatus(order);
  const progress = orderProgress(order);
  const pending = order.id ? orderPending(order.id) : null;

  const cancel = active
    ? el("button", {
        className: "ghost danger",
        text: status === "queued" ? "取消" : "取消跟踪",
        title: status === "queued" ? "真取消:订单尚未派发" : "释放跟踪:包裹已发出无法召回",
        onClick: (event) => {
          event.stopPropagation();
          cancelOrder(order);
        },
      })
    : null;
  if (cancel) cancel.disabled = Boolean(pending);

  const foot = el("div", { className: "orderCardFoot" }, [
    el("span", {
      className: "mono muted",
      text: active
        ? `创建 ${formatTime(order.createdAt)}${order.dispatchedAt ? ` · 派发 ${formatTime(order.dispatchedAt)}` : ""}`
        : `${formatTime(order.completedAt || order.createdAt)}`,
    }),
    cancel,
  ]);

  const card = el(
    "div",
    {
      className: `orderCard${active ? "" : " done"}`,
      title: `${orderTitle(order)}\n${text(order.id)}`,
      onClick: () => openOrderDetail(order.id),
    },
    [
      el("div", { className: "orderCardHead" }, [
        itemIcon(orderIconItem(order), "m"),
        el("div", { className: "orderCardTitle" }, [
          el("strong", { text: orderTitle(order) }),
          el("span", { className: "mono muted", text: `${text(order.address)} · ${text(order.id)}` }),
        ]),
        orderStatusPill(order),
      ]),
      orderChips(order),
      progress ? progressBar(progress) : null,
      orderNoteLine(order),
      foot,
    ]
  );
  return card;
}

// ---- 页面渲染 ----------------------------------------------------------------

export function renderCrafting() {
  const orders = ordersOf();
  const active = orders.filter(isActiveOrder);
  const finished = orders.filter((order) => !isActiveOrder(order));
  const queued = active.filter((order) => orderStatus(order) === "queued").length;

  must<HTMLElement>("#craftingMeta").textContent = orders.length
    ? `排队 ${queued} · 在途 ${active.length - queued} · 历史 ${finished.length}`
    : "";

  const activeHost = must<HTMLElement>("#ordersActive");
  if (active.length === 0) {
    activeHost.replaceChildren(
      emptyState("没有进行中的订单", [
        "自动维持的补货请求、样板下单与缺料催单都会以订单形式出现在这里。",
        "点右上角「手动下单」按样板直接下一单;原料不足会排队等待。",
      ])
    );
  } else {
    activeHost.replaceChildren(...active.map(orderCard));
  }

  const historyHost = must<HTMLElement>("#ordersHistory");
  if (finished.length === 0) {
    historyHost.replaceChildren(emptyState("暂无历史订单"));
  } else {
    historyHost.replaceChildren(...finished.map(orderCard));
  }
}

// ---- 订单详情 dialog -----------------------------------------------------------

let openOrderId: string | null = null;

function detailRow(label: string, value: string, mono = true): HTMLElement {
  return el("div", { className: "orderKV" }, [
    el("span", { className: "muted", text: label }),
    el("span", { className: mono ? "mono" : "", title: value, text: value }),
  ]);
}

function detailSection(title: string, children: (Node | null)[]): HTMLElement {
  return el("div", { className: "orderDetailSection" }, [
    el("h4", { text: title }),
    ...children,
  ]);
}

function itemRows(entries: Array<{ item: string; count: number }>, extra?: (item: string) => string | null): HTMLElement {
  return el(
    "div",
    { className: "orderItems" },
    entries.map((entry) => {
      const extraText = extra ? extra(entry.item) : null;
      return el("div", { className: "orderItemRow" }, [
        itemIcon(entry.item, "s"),
        el("div", { className: "orderItemName" }, [
          el("span", { text: itemName(entry.item) }),
          el("span", { className: "mono muted", text: entry.item }),
        ]),
        extraText ? el("span", { className: "mono muted", text: extraText }) : null,
        el("span", { className: "mono orderItemCount", text: `×${formatExact(entry.count)}` }),
      ]);
    })
  );
}

function renderOrderDetail() {
  const host = must<HTMLElement>("#orderDetailBody");
  const cancelBtn = must<HTMLButtonElement>("#cancelOrderBtn");
  const order = ordersOf().find((entry) => entry.id === openOrderId);

  if (!order) {
    host.replaceChildren(emptyState("订单不在当前快照中", ["可能已被历史裁剪,或控制器尚未上报。"]));
    cancelBtn.hidden = true;
    return;
  }

  const status = orderStatus(order);
  const active = isActiveOrder(order);
  const pending = order.id ? orderPending(order.id) : null;
  const progress = orderProgress(order);
  const products = orderProducts(order);
  const primary = products[0];

  cancelBtn.hidden = !active;
  cancelBtn.disabled = Boolean(pending);
  cancelBtn.textContent = pending ? "取消中…" : status === "queued" ? "取消订单" : "取消跟踪";
  cancelBtn.title = status === "queued" ? "真取消:订单尚未派发" : "释放跟踪:包裹已发出无法召回";

  const head = el("div", { className: "orderDetailHead" }, [
    itemIcon(orderIconItem(order), "l"),
    el("div", { className: "orderCardTitle" }, [
      el("strong", { text: orderTitle(order) }),
      el("span", { className: "mono muted", text: text(order.id) }),
    ]),
    orderStatusPill(order),
  ]);

  const meta = detailSection("订单信息", [
    detailRow("类型", `${orderKindLabel(order)} · 来源 ${orderSourceLabel(order)}`, false),
    detailRow("工序地址", text(order.address)),
    order.recipeId ? detailRow("样板", `${text(order.recipeName, order.recipeId)}(${order.recipeId})`, false) : null,
    order.targetId ? detailRow("关联目标", text(order.targetId)) : null,
    order.batches ? detailRow("批数", `×${formatExact(asNumber(order.batches))}`) : null,
    order.jobId ? detailRow("合成链作业", text(order.jobId)) : null,
    order.parentOrderId ? detailRow("父订单", text(order.parentOrderId)) : null,
    detailRow("创建", formatTime(order.createdAt)),
    order.dispatchedAt ? detailRow("派发", formatTime(order.dispatchedAt)) : null,
    order.completedAt ? detailRow("结束", formatTime(order.completedAt)) : null,
    active && order.expiresAt ? detailRow("跟踪窗口至", formatTime(order.expiresAt)) : null,
    order.commandId ? detailRow("派发命令", text(order.commandId)) : null,
  ]);

  const dispatched = asNumber(order.requested);
  const wanted = asNumber(order.wanted);
  const itemsTitle = status === "queued" ? `原料清单(计划 ${formatExact(wanted)} 件)` : `原料清单(接受 ${formatExact(dispatched)} / ${formatExact(wanted)} 件)`;
  const items = detailSection(itemsTitle, [itemRows(orderItems(order))]);

  const productsSection = products.length
    ? detailSection("预期产物", [
        itemRows(products, (item) =>
          primary && item === primary.item && status !== "queued"
            ? `已入账 ${formatExact(asNumber(order.deliveredProducts))}`
            : null
        ),
      ])
    : null;

  const trackSection = progress
    ? detailSection("跟踪进度", [progressBar(progress)])
    : null;

  host.replaceChildren(head, meta, items, ...(productsSection ? [productsSection] : []), ...(trackSection ? [trackSection] : []), orderNoteLine(order) || el("span"));
}

export function openOrderDetail(orderId: string | undefined) {
  if (!orderId) return;
  openOrderId = orderId;
  renderOrderDetail();
  const dialog = must<HTMLDialogElement>("#orderDialog");
  if (!dialog.open) dialog.showModal();
}

// ---- 手动下单 dialog -----------------------------------------------------------

function recipesOf(): RecipeSnapshot[] {
  const recipes = app.snapshot?.recipes;
  return Array.isArray(recipes) ? recipes : [];
}

function updateNewOrderPreview() {
  const select = must<HTMLSelectElement>("#newOrderRecipe");
  const batchesInput = must<HTMLInputElement>("#newOrderBatches");
  const preview = must<HTMLElement>("#newOrderPreview");
  const recipe = recipesOf().find((entry) => entry.id === select.value);

  if (!recipe) {
    preview.textContent = "";
    return;
  }
  const batches = Math.max(1, Math.floor(Number(batchesInput.value) || 1));
  const inputs = (recipe.inputs || []).map((entry) => `${itemName(entry.item)} ×${formatExact(asNumber(entry.count) * batches)}`);
  preview.textContent = `每批产出:${recipeLine(recipe.products)}\n本单消耗:${inputs.join("、") || "-"} → ${text(recipe.address)}`;
}

function openNewOrderDialog() {
  const recipes = recipesOf();
  if (recipes.length === 0) {
    toast("还没有样板,先到「样板管理」创建", "bad");
    return;
  }

  const select = must<HTMLSelectElement>("#newOrderRecipe");
  const sorted = [...recipes].sort((a, b) => recipeDisplayName(a).localeCompare(recipeDisplayName(b), "zh-CN"));
  select.replaceChildren(
    ...sorted.map((recipe) => {
      const option = el("option", { text: recipeDisplayName(recipe) });
      option.value = recipe.id;
      return option;
    })
  );
  must<HTMLInputElement>("#newOrderBatches").value = "1";
  updateNewOrderPreview();
  must<HTMLDialogElement>("#newOrderDialog").showModal();
}

function submitNewOrder() {
  const select = must<HTMLSelectElement>("#newOrderRecipe");
  const batchesInput = must<HTMLInputElement>("#newOrderBatches");
  const batches = Math.floor(Number(batchesInput.value));
  if (!select.value) {
    toast("请选择样板", "bad");
    return;
  }
  if (!Number.isFinite(batches) || batches <= 0) {
    toast("批数无效,需要正整数", "bad");
    return;
  }
  sendCommand({ kind: "request_recipe", recipeId: select.value, batches });
  must<HTMLDialogElement>("#newOrderDialog").close();
}

// ---- 事件接线 ------------------------------------------------------------------

export function wireCrafting() {
  const orderDialog = must<HTMLDialogElement>("#orderDialog");
  must<HTMLButtonElement>("#closeOrderDialogBtn").addEventListener("click", () => orderDialog.close());
  must<HTMLButtonElement>("#closeOrderBtn").addEventListener("click", () => orderDialog.close());
  orderDialog.addEventListener("close", () => {
    openOrderId = null;
  });
  must<HTMLButtonElement>("#cancelOrderBtn").addEventListener("click", () => {
    const order = ordersOf().find((entry) => entry.id === openOrderId);
    if (order) cancelOrder(order);
  });

  must<HTMLButtonElement>("#newOrderBtn").addEventListener("click", () => openNewOrderDialog());
  const newOrderDialog = must<HTMLDialogElement>("#newOrderDialog");
  must<HTMLButtonElement>("#closeNewOrderDialogBtn").addEventListener("click", () => newOrderDialog.close());
  must<HTMLButtonElement>("#cancelNewOrderBtn").addEventListener("click", () => newOrderDialog.close());
  must<HTMLSelectElement>("#newOrderRecipe").addEventListener("change", updateNewOrderPreview);
  must<HTMLInputElement>("#newOrderBatches").addEventListener("input", updateNewOrderPreview);
  must<HTMLFormElement>("#newOrderForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitNewOrder();
  });

  // 快照/状态更新时,打开中的详情跟随重绘(取消按钮状态、进度条实时变化)
  subscribe(() => {
    if (openOrderId && must<HTMLDialogElement>("#orderDialog").open) {
      renderOrderDetail();
    }
  });
}
