// 样板编辑器:<dialog> 表单。样板承载配方(输入/输出/工序地址),是配方的
// 唯一权威——目标只经 recipeId 引用。产物/原料是 AE2 样板风格的结构化行
// 编辑器(图标 + 物品 ID 自动补全 + 每批数量),自原目标编辑器整体迁入;
// 样板条目不带目标库存(targetCount 是目标侧策略,在目标编辑器里填)。
import type { ControllerCommand, RecipeEntry, RecipeSnapshot } from "../shared/protocol";
import { defaultDisplayName } from "../shared/summary";
import { TARGET_DEFAULTS } from "../shared/target-fields";
import type { ItemAsset } from "./state";
import { app } from "./state";
import { el, must, text, toast } from "./dom";
import { flushRenderAfterDrag, itemIcon, itemName } from "./render";
import { sendCommand } from "./ws";

type RecipeRow = {
  root: HTMLElement;
  iconHost: HTMLElement;
  badge: HTMLElement | null; // 仅产物行:主产物/副产物
  item: HTMLInputElement;
  nameHint: HTMLElement;
  count: HTMLInputElement;
  removeBtn: HTMLButtonElement;
};

type EditorRefs = {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  editingId: HTMLInputElement;
  address: HTMLInputElement;
  productsHost: HTMLElement;
  inputsHost: HTMLElement;
  name: HTMLInputElement;
  id: HTMLInputElement;
  deleteBtn: HTMLButtonElement;
};

let refs: EditorRefs | null = null;
let productRows: RecipeRow[] = [];
let inputRows: RecipeRow[] = [];

// 拖拽结束后按 DOM 顺序回写行数组:readRecipeRows 以数组顺序为准,
// 条目顺序就是保存后 requestFiltered 的变参顺序
function syncRowsFromDom(isProduct: boolean) {
  if (!refs) return;
  const host = isProduct ? refs.productsHost : refs.inputsHost;
  const order = Array.from(host.children);
  const list = isProduct ? productRows : inputRows;
  list.sort((a, b) => order.indexOf(a.root) - order.indexOf(b.root));
  refreshRowDecorations();
}

// ---- 物品自动补全(数据源:/api/items 的物品索引,支持中文名/英文名/ID) ----

// 当前展开的补全下拉;滚动/换目标时统一收起(fixed 定位不随滚动移动)
let activeSuggest: { hide: () => void; list: HTMLElement } | null = null;

function itemMatches(query: string): ItemAsset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ score: number; asset: ItemAsset }> = [];
  for (const asset of Object.values(app.items)) {
    const id = asset.id.toLowerCase();
    const name = (asset.name || "").toLowerCase();
    const english = (asset.englishName || "").toLowerCase();
    let score = -1;
    if (id === q || name === q) score = 0;
    else if (name.startsWith(q) || english.startsWith(q) || id.startsWith(q)) score = 1;
    else if (id.includes(q) || name.includes(q) || english.includes(q)) score = 2;
    if (score >= 0) scored.push({ score, asset });
  }

  scored.sort((a, b) => a.score - b.score || a.asset.id.localeCompare(b.asset.id));
  return scored.slice(0, 12).map((entry) => entry.asset);
}

function attachItemSuggest(input: HTMLInputElement, anchor: HTMLElement, onPick: () => void) {
  const list = el("div", { className: "itemSuggest" });
  list.hidden = true;
  anchor.append(list);

  let options: ItemAsset[] = [];
  let active = -1;

  const hide = () => {
    list.hidden = true;
    options = [];
    active = -1;
    if (activeSuggest && activeSuggest.list === list) activeSuggest = null;
  };

  // 对话框字段区是滚动容器,absolute 定位会被裁剪;改用 fixed 按输入框实时定位
  const place = () => {
    const rect = input.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${rect.width}px`;
  };

  const pick = (asset: ItemAsset) => {
    input.value = asset.id;
    hide();
    onPick();
  };

  const renderList = () => {
    if (options.length === 0) {
      hide();
      return;
    }
    place();
    list.hidden = false;
    activeSuggest = { hide, list };
    list.replaceChildren(
      ...options.map((asset, index) => {
        const row = el("div", { className: `itemSuggestRow${index === active ? " active" : ""}` }, [
          itemIcon(asset.id, "s"),
          el("span", { className: "itemSuggestName", text: asset.name || defaultDisplayName(asset.id) }),
          el("span", { className: "mono muted itemSuggestId", text: asset.id }),
        ]);
        // mousedown 先于 input 的 blur,保证点选能生效
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          pick(asset);
        });
        return row;
      })
    );
  };

  input.addEventListener("input", () => {
    options = itemMatches(input.value);
    active = -1;
    renderList();
  });

  input.addEventListener("keydown", (event) => {
    if (list.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(options.length - 1, active + 1);
      renderList();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(-1, active - 1);
      renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[active >= 0 ? active : 0];
      if (chosen) pick(chosen);
      else hide();
    } else if (event.key === "Escape") {
      // 只收起补全,不让 Escape 冒泡成关闭整个对话框
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(hide, 150);
  });
}

// ---- 配方行 ------------------------------------------------------------------

function updateRowVisuals(row: RecipeRow) {
  const itemId = row.item.value.trim();
  row.iconHost.replaceChildren(itemIcon(itemId || undefined, "s"));
  row.nameHint.textContent = itemId ? itemName(itemId) : "";
}

// 主产物行驱动"样板名称/内部 ID"占位符
function syncPrimaryPlaceholders() {
  if (!refs) return;
  const item = productRows[0]?.item.value.trim() || "";
  refs.name.placeholder = item ? defaultDisplayName(item) : "自动生成";
  refs.id.placeholder = item ? recipeIdFromItem(item) : "自动生成";
}

// 行增删后统一刷新:主产/副产徽标、删除按钮可用性
function refreshRowDecorations() {
  for (const [index, row] of productRows.entries()) {
    const primary = index === 0;
    if (row.badge) {
      row.badge.textContent = primary ? "主产物" : "副产物";
      row.badge.classList.toggle("primary", primary);
    }
    row.removeBtn.disabled = productRows.length <= 1;
  }
  for (const row of inputRows) {
    row.removeBtn.disabled = inputRows.length <= 1;
  }
  syncPrimaryPlaceholders();
}

function buildRecipeRow(isProduct: boolean, entry: RecipeEntry): RecipeRow {
  const iconHost = el("span", { className: "recipeIconHost" });

  const item = el("input", {
    className: "mono recipeItem",
    attrs: {
      placeholder: isProduct ? "create:iron_sheet" : "minecraft:iron_ingot",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  item.value = entry.item || "";

  const badge = isProduct ? el("span", { className: "recipeBadge" }) : null;
  const nameHint = el("span", { className: "recipeNameHint" });
  const hintLine = el("span", { className: "recipeHint" }, [badge, nameHint]);
  const itemCell = el("div", { className: "recipeItemCell" }, [item, hintLine]);

  const count = el("input", { className: "recipeCount", attrs: { type: "number", step: "any", min: "0" } });
  count.value = String(entry.count ?? 1);

  const removeBtn = el("button", {
    className: "ghost recipeRemoveBtn",
    text: "✕",
    title: "移除此行",
    attrs: { type: "button", "aria-label": "移除此行" },
  });

  const row: RecipeRow = {
    root: el("div", { className: `recipeRow${isProduct ? " product" : ""}` }, [
      iconHost,
      itemCell,
      count,
      removeBtn,
    ]),
    iconHost,
    badge,
    item,
    nameHint,
    count,
    removeBtn,
  };

  // 整行背景即拖拽区:仅避开输入框/按钮/补全下拉,保留文本编辑与点击
  wireRowPointerDrag(row, isProduct);

  attachItemSuggest(item, itemCell, () => {
    updateRowVisuals(row);
    syncPrimaryPlaceholders();
  });
  item.addEventListener("input", () => {
    updateRowVisuals(row);
    syncPrimaryPlaceholders();
  });

  removeBtn.addEventListener("click", () => {
    const list = isProduct ? productRows : inputRows;
    if (list.length <= 1) return;
    const index = list.indexOf(row);
    if (index >= 0) list.splice(index, 1);
    row.root.remove();
    refreshRowDecorations();
  });

  updateRowVisuals(row);
  return row;
}

function appendRecipeRow(isProduct: boolean, entry: RecipeEntry): RecipeRow {
  if (!refs) throw new Error("编辑器尚未初始化");
  const row = buildRecipeRow(isProduct, entry);
  (isProduct ? productRows : inputRows).push(row);
  (isProduct ? refs.productsHost : refs.inputsHost).append(row.root);
  return row;
}

function setRecipeRows(isProduct: boolean, entries: RecipeEntry[]) {
  if (!refs) throw new Error("编辑器尚未初始化");
  (isProduct ? refs.productsHost : refs.inputsHost).replaceChildren();
  if (isProduct) productRows = [];
  else inputRows = [];
  for (const entry of entries) appendRecipeRow(isProduct, entry);
  refreshRowDecorations();
}

// 读取配方行为 RecipeEntry[];样板条目只有物品与每批数量。
// 原料允许同一物品多条条目:条目顺序 = requestFiltered 变参顺序 = 包裹装配
// 顺序,顺序敏感的产线依赖"白-灰-白-灰"这类交替样板;产物重复无意义,仍查重。
function readRecipeRows(isProduct: boolean): RecipeEntry[] {
  const rows = isProduct ? productRows : inputRows;
  const listLabel = isProduct ? "产物" : "原料";
  const entries: RecipeEntry[] = [];
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const item = row.item.value.trim();
    if (!item) throw new Error(`${listLabel}第 ${index + 1} 行缺少物品 ID`);
    if (isProduct) {
      if (seen.has(item)) throw new Error(`${listLabel}列表存在重复物品:${item}`);
      seen.add(item);
    }

    const count = Number(row.count.value);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`${listLabel}「${item}」的每批数量无效`);

    entries.push({ item, count });
  }

  if (entries.length === 0) throw new Error(isProduct ? "至少需要一个产物" : "至少需要一个原料");
  return entries;
}

// ---- 标签与 ID 推导 -----------------------------------------------------------

function manualLabel(label: unknown, item: string): string | null {
  const value = text(label, "").trim();
  if (!value || value === item || value === defaultDisplayName(item) || value === itemName(item)) return null;
  return value;
}

function preserveEntryLabels(entries: RecipeEntry[], previousEntries: RecipeEntry[] | undefined): RecipeEntry[] {
  return entries.map((entry) => {
    const previous = (previousEntries || []).find((item) => item.item === entry.item);
    const label = manualLabel(previous?.label, entry.item);
    return label ? { ...entry, label } : entry;
  });
}

function recipeIdFromItem(itemId: string): string {
  const value = text(itemId, "").toLowerCase();
  const id = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return id || "recipe";
}

function recipeManualName(recipe: RecipeSnapshot): string {
  const product = recipe.products && recipe.products[0];
  if (!product) return text(recipe.name, "");
  return manualLabel(recipe.name, product.item) || manualLabel(product.label, product.item) || "";
}

// ---- 拖拽排序(指针驱动) -------------------------------------------------------
// 不用 HTML5 DnD:原生拖拽只会显示半透明快照幽灵、本体留在原地,观感是"复制
// 出一张虚卡"。这里直接让卡片本体 transform 跟手移动,让位行 FLIP 平滑滑动,
// 松手后本体滑入落定槽位。按下位移超过阈值才算拖拽,行背景普通点击不受影响。

const DRAG_THRESHOLD_PX = 4;
const ROW_SLIDE_MS = 160;

// 拖拽进行中标记:render() 据此暂停整页重渲染(快照心跳每秒重建侧栏/表格,
// 大量 DOM 替换会与拖拽动画互相挤压出卡顿),落定后 flushRenderAfterDrag 补上
let dragActive = false;

export function isRecipeDragActive() {
  return dragActive;
}

// 每行进行中的 FLIP 回放帧:新一轮重排要先取消旧回调,否则过期回调会把
// 刚设好的起步变换提前清零,快速连续跨槽时让位行会乱跳
const pendingFlip = new WeakMap<HTMLElement, number>();

// 让位行 FLIP:记录当前视觉位置(含未完成的过渡) → 重排 → 清掉旧变换量出
// 纯布局位置 → 从视觉位差值起步过渡归零,动画可无缝接续
function flipSiblings(host: HTMLElement, dragged: HTMLElement, mutate: () => void) {
  const siblings = Array.from(host.children).filter(
    (node): node is HTMLElement => node !== dragged && node instanceof HTMLElement
  );
  const visualTop = new Map<HTMLElement, number>();
  for (const node of siblings) visualTop.set(node, node.getBoundingClientRect().top);

  mutate();

  for (const node of siblings) {
    const prior = pendingFlip.get(node);
    if (prior !== undefined) {
      cancelAnimationFrame(prior);
      pendingFlip.delete(node);
    }
    node.style.transition = "none";
    node.style.transform = "";
  }
  for (const node of siblings) {
    const delta = (visualTop.get(node) ?? 0) - node.getBoundingClientRect().top;
    if (!delta) continue;
    node.style.transform = `translateY(${delta}px)`;
    const frame = requestAnimationFrame(() => {
      pendingFlip.delete(node);
      node.style.transition = `transform ${ROW_SLIDE_MS}ms ease`;
      node.style.transform = "";
    });
    pendingFlip.set(node, frame);
  }
}

function wireRowPointerDrag(row: RecipeRow, isProduct: boolean) {
  row.root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !refs) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, button, .itemSuggest")) return;
    event.preventDefault();

    const host = isProduct ? refs.productsHost : refs.inputsHost;
    const dragged = row.root;
    // 字段区是滚动容器:滚轮/自动滚动会让列表在视口中移动,几何不能缓存
    const scroller = host.closest(".dialogFields");
    const startPointerY = event.clientY;
    let lastPointerY = startPointerY;
    let active = false;
    // 步长/槽数/抓取偏移在激活时量好(拖拽期间不变);hostTop 不缓存
    let step = 0;
    let maxIndex = 0;
    let currentIndex = 0;
    let grabOffset = 0;
    let scrollFrame = 0;

    // 期望视觉位与槽位判定:hostTop 每次实时读——滚动会让列表在视口中移动,
    // 用缓存值会让卡片和槽位判定一起漂移(拖动中滚滚轮就卡死的根源)
    const update = () => {
      const hostTop = host.getBoundingClientRect().top;
      const desiredTop = Math.max(hostTop, Math.min(hostTop + step * maxIndex, lastPointerY - grabOffset));
      const targetIndex = Math.round((desiredTop - hostTop) / step);
      if (targetIndex !== currentIndex) {
        flipSiblings(host, dragged, () => {
          host.insertBefore(dragged, host.children[targetIndex + (targetIndex > currentIndex ? 1 : 0)] ?? null);
        });
        currentIndex = targetIndex;
      }
      // 本体跟手:transform = 期望视觉位 - 当前槽位布局位
      dragged.style.transform = `translateY(${desiredTop - (hostTop + currentIndex * step)}px)`;
    };

    // 拖拽期间任何滚动(滚轮/自动滚动/滚动链)都重新对齐卡片与槽位
    const onScroll = () => {
      if (active) update();
    };

    // 指针贴近滚动容器上下边缘时持续滚动:长列表拖到视野外的槽位靠它
    const autoScrollTick = () => {
      scrollFrame = requestAnimationFrame(autoScrollTick);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const zone = 32;
      let velocity = 0;
      if (lastPointerY < rect.top + zone) velocity = -Math.min(14, (rect.top + zone - lastPointerY) * 0.4);
      else if (lastPointerY > rect.bottom - zone) velocity = Math.min(14, (lastPointerY - (rect.bottom - zone)) * 0.4);
      if (!velocity) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + velocity;
      if (scroller.scrollTop !== before) update();
    };

    const activate = () => {
      active = true;
      dragActive = true;
      dragged.classList.add("dragging");
      // 清掉可能残留的落定过渡,量出干净的布局几何
      dragged.style.transition = "none";
      dragged.style.transform = "";
      const gap = Number.parseFloat(getComputedStyle(host).rowGap) || 0;
      step = dragged.offsetHeight + gap;
      maxIndex = host.children.length - 1;
      currentIndex = Array.prototype.indexOf.call(host.children, dragged);
      // 锚定按下时刻的指针位置:快速甩动时首个 move 事件可能已离按下点
      // 几十像素,锚到激活时刻会把这段位移永久丢掉,卡片全程滞后于指针
      grabOffset = startPointerY - (host.getBoundingClientRect().top + currentIndex * step);
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      if (scroller) scrollFrame = requestAnimationFrame(autoScrollTick);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      lastPointerY = ev.clientY;
      if (!active) {
        if (Math.abs(ev.clientY - startPointerY) < DRAG_THRESHOLD_PX) return;
        activate();
      }
      update();
    };

    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      document.removeEventListener("scroll", onScroll, { capture: true });
      cancelAnimationFrame(scrollFrame);
      try {
        refs?.dialog.releasePointerCapture(event.pointerId);
      } catch {
        /* 指针已消失,无需释放 */
      }
      dragActive = false;
      if (active) {
        dragged.classList.remove("dragging");
        // 本体平滑滑入落定槽位,落定后光晕脉冲一次
        dragged.style.transition = `transform ${ROW_SLIDE_MS}ms ease`;
        dragged.style.transform = "";
        dragged.addEventListener(
          "transitionend",
          () => {
            dragged.style.transition = "";
          },
          { once: true }
        );
        syncRowsFromDom(isProduct);
        dragged.classList.add("dropSettle");
        dragged.addEventListener("animationend", () => dragged.classList.remove("dropSettle"), { once: true });
      }
      // 拖拽期间被跳过的快照重渲染在这里补上
      flushRenderAfterDrag();
    };

    // 监听挂 document 而非行自身:跨槽重排的 insertBefore 会隐式释放行上的
    // 指针捕获(规范:节点离开文档即释放,移动 = 移除+重插),快速拖动时指针
    // 一旦甩出行外事件就断流(慢拖卡片跟得上指针所以侥幸可用)。
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    // 捕获挂到对话框(拖拽中永不重排的稳定节点):指针拖出浏览器窗口也能跟手
    try {
      refs.dialog.setPointerCapture(event.pointerId);
    } catch {
      /* 无活动指针(合成事件等),document 监听仍然工作 */
    }
  });
}

// ---- 表单生成(一次性) --------------------------------------------------------

function recipeSection(
  title: string,
  hint: string,
  host: HTMLElement,
  isProduct: boolean,
  addLabel: string,
  addEntry: () => RecipeEntry
): HTMLElement {
  const head = el("div", { className: `recipeSectionHead${isProduct ? " product" : ""}` }, [
    el("span", { className: "recipeSectionTitle", text: title, title: hint }),
    el("span", { className: "recipeColLabel", text: isProduct ? "每批产出" : "每批消耗" }),
    el("span"),
  ]);

  const addBtn = el("button", {
    className: "ghost recipeAddBtn",
    text: addLabel,
    attrs: { type: "button" },
    onClick: () => {
      appendRecipeRow(isProduct, addEntry());
      refreshRowDecorations();
      const rows = isProduct ? productRows : inputRows;
      rows[rows.length - 1]?.item.focus();
    },
  });

  return el("div", { className: "recipeSection" }, [head, host, addBtn]);
}

function buildForm(): EditorRefs {
  const dialog = must<HTMLDialogElement>("#recipeDialog");
  const form = must<HTMLFormElement>("#recipeForm");
  const fieldsHost = must<HTMLElement>("#recipeFields");

  const editingId = el("input", { attrs: { type: "hidden" } });

  const address = el("input", { attrs: { required: "", placeholder: TARGET_DEFAULTS.address, name: "address" } });
  const addressField = el("label", { className: "field" }, [el("span", { text: "工序地址" }), address]);

  const productsHost = el("div", { className: "recipeRows" });
  const inputsHost = el("div", { className: "recipeRows" });
  const name = el("input", { attrs: { placeholder: "自动生成", name: "displayName" } });
  const id = el("input", { attrs: { placeholder: "自动生成", name: "id" } });

  fieldsHost.replaceChildren(
    editingId,
    el("div", { className: "fieldGrid two" }, [
      addressField,
      el("label", { className: "field" }, [el("span", { text: "样板名称(可选,主产物显示名)" }), name]),
    ]),
    recipeSection(
      "产物",
      "第一行是主产物,决定样板的名称与图标;目标库存在目标编辑器里按目标设置",
      productsHost,
      true,
      "+ 添加副产物",
      () => ({ item: "", count: 1 })
    ),
    recipeSection("原料", "每生产一批消耗的全部原料", inputsHost, false, "+ 添加原料", () => ({ item: "", count: 1 })),
    el("details", { className: "advancedFields" }, [
      el("summary", { text: "高级设置" }),
      el("label", { className: "field" }, [el("span", { text: "内部 ID" }), id]),
    ])
  );

  return {
    dialog,
    form,
    title: must<HTMLElement>("#recipeDialogTitle"),
    editingId,
    address,
    productsHost,
    inputsHost,
    name,
    id,
    deleteBtn: must<HTMLButtonElement>("#deleteRecipeBtn"),
  };
}

// ---- 读写表单 ----------------------------------------------------------------

function findRecipe(recipeId: string): RecipeSnapshot | null {
  const recipes = app.snapshot?.recipes || [];
  return recipes.find((recipe) => recipe.id === recipeId) || null;
}

export function openRecipeDialog(recipe: RecipeSnapshot | null) {
  if (!refs) refs = buildForm();
  const isEdit = Boolean(recipe);

  refs.title.textContent = isEdit ? "编辑样板" : "新增样板";
  refs.editingId.value = recipe ? recipe.id : "";
  refs.id.value = recipe ? recipe.id : "";
  refs.name.value = recipe ? recipeManualName(recipe) : "";
  refs.address.value = recipe ? text(recipe.address, TARGET_DEFAULTS.address) : TARGET_DEFAULTS.address;

  setRecipeRows(true, recipe?.products?.length ? recipe.products : [{ item: "", count: 1 }]);
  setRecipeRows(false, recipe?.inputs?.length ? recipe.inputs : [{ item: "", count: 1 }]);

  refs.deleteBtn.hidden = !isEdit;

  if (refs.dialog.showModal) refs.dialog.showModal();
  else refs.dialog.setAttribute("open", "open");
}

export function closeRecipeDialog() {
  if (!refs) return;
  if (refs.dialog.close) refs.dialog.close();
  else refs.dialog.removeAttribute("open");
}

function recipeFromForm(): Record<string, unknown> {
  if (!refs) throw new Error("编辑器尚未初始化");
  const previous = findRecipe(refs.editingId.value);
  const products = preserveEntryLabels(readRecipeRows(true), previous?.products);
  const inputs = preserveEntryLabels(readRecipeRows(false), previous?.inputs);
  const firstProduct = products[0]!;

  const result: Record<string, unknown> = {
    id: refs.id.value.trim() || recipeIdFromItem(firstProduct.item),
    address: refs.address.value.trim() || TARGET_DEFAULTS.address,
    products,
    inputs,
  };

  const name = manualLabel(refs.name.value, firstProduct.item);
  if (name) result.name = name;

  return result;
}

// 引用某样板的目标数(删除守卫与提示共用)
export function recipeUsageCount(recipeId: string): number {
  return (app.snapshot?.targets || []).filter((target) => target.recipeId === recipeId).length;
}

export function wireRecipeEditor() {
  if (!refs) refs = buildForm();
  const { form, dialog, deleteBtn } = refs;

  // 捕获阶段监听所有滚动:字段区滚动时收起 fixed 定位的补全下拉
  //(在下拉自身内滚动除外)
  document.addEventListener(
    "scroll",
    (event) => {
      if (!activeSuggest) return;
      if (event.target instanceof Node && activeSuggest.list.contains(event.target)) return;
      activeSuggest.hide();
    },
    true
  );

  must<HTMLButtonElement>("#closeRecipeDialogBtn").addEventListener("click", closeRecipeDialog);
  must<HTMLButtonElement>("#cancelRecipeBtn").addEventListener("click", closeRecipeDialog);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const recipe = recipeFromForm();
      const previousId = refs!.editingId.value || undefined;
      sendCommand({ kind: "upsert_recipe", recipeId: previousId, recipe } as unknown as ControllerCommand);
      toast("样板已保存,等待控制器确认", "good");
      closeRecipeDialog();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "bad");
    }
  });

  deleteBtn.addEventListener("click", () => {
    const recipeId = refs!.editingId.value;
    const recipe = findRecipe(recipeId);
    if (!recipeId || !recipe) return;
    const used = recipeUsageCount(recipeId);
    if (used > 0) {
      toast(`样板被 ${used} 个目标引用,先删除或改绑那些目标`, "bad");
      return;
    }
    const product = recipe.products && recipe.products[0];
    if (!confirm(`删除样板「${product ? itemName(product.item) : recipeId}」?`)) return;
    sendCommand({ kind: "delete_recipe", recipeId });
    closeRecipeDialog();
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRecipeDialog();
  });
}
