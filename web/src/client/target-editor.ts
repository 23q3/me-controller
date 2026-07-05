// 目标编辑器:<dialog> 表单,数值配置字段完全由 TARGET_NUMBER_FIELDS 描述符
// 驱动生成。产物/原料是 AE2 样板风格的结构化行编辑器(图标 + 物品 ID 自动
// 补全 + 每批数量),替代原逗号分隔文本框。
// 语义与 Lua targets_store 的位置化默认对齐:products[1] 为主产物(目标库存
// 缺省继承 2048 默认),其余为副产物(目标库存缺省 0,不驱动生产,仅供下游
// 依赖需求拉动或显式设定)。
import type { ControllerCommand, RecipeEntry, TargetSnapshot } from "../shared/protocol";
import { defaultDisplayName } from "../shared/summary";
import { TARGET_CONFIG_KEYS, TARGET_DEFAULTS, TARGET_NUMBER_FIELDS } from "../shared/target-fields";
import type { ItemAsset } from "./state";
import { app } from "./state";
import { el, must, text, toast } from "./dom";
import { itemIcon, itemName } from "./render";
import { sendCommand } from "./ws";

type RecipeRow = {
  root: HTMLElement;
  iconHost: HTMLElement;
  badge: HTMLElement | null; // 仅产物行:主产物/副产物
  item: HTMLInputElement;
  nameHint: HTMLElement;
  count: HTMLInputElement;
  targetCount: HTMLInputElement | null; // 仅产物行
  removeBtn: HTMLButtonElement;
};

type EditorRefs = {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  editingId: HTMLInputElement;
  enabled: HTMLInputElement;
  address: HTMLInputElement;
  productsHost: HTMLElement;
  inputsHost: HTMLElement;
  name: HTMLInputElement;
  id: HTMLInputElement;
  numbers: Map<string, HTMLInputElement>;
  deleteBtn: HTMLButtonElement;
};

let refs: EditorRefs | null = null;
let productRows: RecipeRow[] = [];
let inputRows: RecipeRow[] = [];

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

// 主产物行驱动"显示名称/内部 ID"占位符(与旧文本框行为一致)
function syncPrimaryPlaceholders() {
  if (!refs) return;
  const item = productRows[0]?.item.value.trim() || "";
  refs.name.placeholder = item ? defaultDisplayName(item) : "自动生成";
  refs.id.placeholder = item ? targetIdFromItem(item) : "自动生成";
}

// 行增删后统一刷新:主产/副产徽标、目标库存占位、删除按钮可用性
function refreshRowDecorations() {
  for (const [index, row] of productRows.entries()) {
    const primary = index === 0;
    if (row.badge) {
      row.badge.textContent = primary ? "主产物" : "副产物";
      row.badge.classList.toggle("primary", primary);
    }
    if (row.targetCount) {
      row.targetCount.placeholder = primary ? String(TARGET_DEFAULTS.targetCount) : "0(副产物)";
      row.targetCount.title = primary
        ? "网络中要维持的库存量"
        : "0 = 副产物,不驱动生产;设为正数则按共产物维持";
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

  let targetCount: HTMLInputElement | null = null;
  if (isProduct) {
    targetCount = el("input", { className: "recipeTarget", attrs: { type: "number", step: "1", min: "0" } });
    if (entry.targetCount !== undefined) targetCount.value = String(entry.targetCount);
  }

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
      targetCount,
      removeBtn,
    ]),
    iconHost,
    badge,
    item,
    nameHint,
    count,
    targetCount,
    removeBtn,
  };

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

// 读取配方行为 RecipeEntry[];目标库存留空按位置补默认(主产 2048/副产 0),
// 与 Lua 侧位置化默认一致
function readRecipeRows(isProduct: boolean): RecipeEntry[] {
  const rows = isProduct ? productRows : inputRows;
  const listLabel = isProduct ? "产物" : "原料";
  const entries: RecipeEntry[] = [];
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const item = row.item.value.trim();
    if (!item) throw new Error(`${listLabel}第 ${index + 1} 行缺少物品 ID`);
    if (seen.has(item)) throw new Error(`${listLabel}列表存在重复物品:${item}`);
    seen.add(item);

    const count = Number(row.count.value);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`${listLabel}「${item}」的每批数量无效`);

    const entry: RecipeEntry = { item, count };
    if (isProduct && row.targetCount) {
      const raw = row.targetCount.value.trim();
      const fallback = index === 0 ? TARGET_DEFAULTS.targetCount : 0;
      const targetCount = raw === "" ? fallback : Number(raw);
      if (!Number.isFinite(targetCount) || targetCount < 0) throw new Error(`产物「${item}」的目标库存无效`);
      entry.targetCount = Math.floor(targetCount);
    }
    entries.push(entry);
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

function targetIdFromItem(itemId: string): string {
  const value = text(itemId, "").toLowerCase();
  const id = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return id || "target";
}

function primaryManualLabel(target: TargetSnapshot): string {
  const product = target.products && target.products[0];
  const item = product?.item;
  if (!item) return "";
  return manualLabel(product?.label, item) || manualLabel((target as { productLabel?: string }).productLabel, item) || "";
}

// ---- 表单生成(一次性,描述符驱动) -------------------------------------------

function numberInput(key: string, label: string, min: number): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { attrs: { type: "number", min: String(min), step: "1", name: key } });
  const wrap = el("label", { className: "field" }, [el("span", { text: label }), input]);
  return { wrap, input };
}

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
    isProduct ? el("span", { className: "recipeColLabel", text: "目标库存" }) : null,
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
  const dialog = must<HTMLDialogElement>("#targetDialog");
  const form = must<HTMLFormElement>("#targetForm");
  const fieldsHost = must<HTMLElement>("#targetFields");
  const numbers = new Map<string, HTMLInputElement>();

  const editingId = el("input", { attrs: { type: "hidden" } });

  const enabled = el("input", { attrs: { type: "checkbox" } });
  enabled.checked = true;
  const enabledLine = el("label", { className: "checkboxLine" }, [enabled, el("span", { text: "启用该目标" })]);

  const address = el("input", { attrs: { required: "", placeholder: TARGET_DEFAULTS.address, name: "address" } });
  const addressField = el("label", { className: "field" }, [el("span", { text: "工序地址" }), address]);

  const basicNumbers: HTMLElement[] = [];
  const advancedNumbers: HTMLElement[] = [];
  for (const field of TARGET_NUMBER_FIELDS) {
    const { wrap, input } = numberInput(field.key, field.label, field.min);
    numbers.set(field.key, input);
    (field.group === "basic" ? basicNumbers : advancedNumbers).push(wrap);
  }

  const productsHost = el("div", { className: "recipeRows" });
  const inputsHost = el("div", { className: "recipeRows" });
  const name = el("input", { attrs: { placeholder: "自动生成", name: "displayName" } });
  const id = el("input", { attrs: { placeholder: "自动生成", name: "id" } });

  const advanced = el("details", { className: "advancedFields" }, [
    el("summary", { text: "高级设置" }),
    el("label", { className: "field" }, [el("span", { text: "内部 ID" }), id]),
    el("div", { className: "fieldGrid" }, advancedNumbers),
  ]);

  fieldsHost.replaceChildren(
    editingId,
    enabledLine,
    el("div", { className: "fieldGrid two" }, [addressField, ...basicNumbers]),
    recipeSection(
      "产物",
      "第一行是主产物,驱动生产;其余为副产物(目标库存 0 时只入账不驱动)",
      productsHost,
      true,
      "+ 添加副产物",
      () => ({ item: "", count: 1, targetCount: 0 })
    ),
    el("label", { className: "field" }, [el("span", { text: "显示名称(可选,主产物)" }), name]),
    recipeSection("原料", "每生产一批消耗的全部原料", inputsHost, false, "+ 添加原料", () => ({ item: "", count: 1 })),
    advanced
  );

  return {
    dialog,
    form,
    title: must<HTMLElement>("#targetDialogTitle"),
    editingId,
    enabled,
    address,
    productsHost,
    inputsHost,
    name,
    id,
    numbers,
    deleteBtn: must<HTMLButtonElement>("#deleteTargetBtn"),
  };
}

// ---- 读写表单 ----------------------------------------------------------------

function fieldDefault(key: string): number {
  return (TARGET_DEFAULTS as Record<string, number | string | boolean>)[key] as number;
}

function numberFieldValue(input: HTMLInputElement, fallback: number, minimum: number): number {
  const value = Number(input.value);
  const result = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, result);
}

function findTarget(targetId: string): TargetSnapshot | null {
  const targets = app.snapshot?.targets || [];
  return targets.find((target) => target.id === targetId) || null;
}

function editableTargetBase(target: TargetSnapshot | null): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (!target) return base;
  const source = target as unknown as Record<string, unknown>;
  for (const key of TARGET_CONFIG_KEYS) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  return base;
}

export function openTargetDialog(target: TargetSnapshot | null) {
  if (!refs) refs = buildForm();
  const isEdit = Boolean(target);
  const source = (target || {}) as unknown as Record<string, unknown>;

  refs.title.textContent = isEdit ? "编辑目标" : "新增目标";
  refs.editingId.value = target ? target.id : "";
  refs.id.value = target ? target.id : "";
  refs.name.value = target ? primaryManualLabel(target) : "";
  refs.enabled.checked = target ? target.enabled !== false : TARGET_DEFAULTS.enabled;
  refs.address.value = target ? text(target.address, TARGET_DEFAULTS.address) : TARGET_DEFAULTS.address;

  setRecipeRows(
    true,
    target?.products?.length ? target.products : [{ item: "", count: 1, targetCount: TARGET_DEFAULTS.targetCount }]
  );
  setRecipeRows(false, target?.inputs?.length ? target.inputs : [{ item: "", count: 1 }]);

  for (const field of TARGET_NUMBER_FIELDS) {
    const input = refs.numbers.get(field.key);
    if (!input) continue;
    const value = source[field.key];
    input.value = String(value !== undefined && value !== null ? value : fieldDefault(field.key));
  }

  refs.deleteBtn.hidden = !isEdit;

  if (refs.dialog.showModal) refs.dialog.showModal();
  else refs.dialog.setAttribute("open", "open");
}

export function closeTargetDialog() {
  if (!refs) return;
  if (refs.dialog.close) refs.dialog.close();
  else refs.dialog.removeAttribute("open");
}

function targetFromForm(): Record<string, unknown> {
  if (!refs) throw new Error("编辑器尚未初始化");
  const base = editableTargetBase(findTarget(refs.editingId.value));
  const products = preserveEntryLabels(readRecipeRows(true), base.products as RecipeEntry[] | undefined);
  const inputs = preserveEntryLabels(readRecipeRows(false), base.inputs as RecipeEntry[] | undefined);
  const firstProduct = products[0]!;
  const firstInput = inputs[0]!;

  const productName = manualLabel(refs.name.value, firstProduct.item);
  if (productName) firstProduct.label = productName;
  else delete firstProduct.label;
  const productLabelValue = productName || firstProduct.item;
  const inputLabel = firstInput.label || manualLabel(base.inputLabel, firstInput.item) || firstInput.item;

  const result: Record<string, unknown> = {
    ...base,
    id: refs.id.value.trim() || targetIdFromItem(firstProduct.item),
    enabled: refs.enabled.checked,
    address: refs.address.value.trim() || TARGET_DEFAULTS.address,
    products,
    inputs,
    productItem: firstProduct.item,
    productLabel: productLabelValue,
    targetCount: firstProduct.targetCount ?? TARGET_DEFAULTS.targetCount,
    inputItem: firstInput.item,
    inputLabel,
  };

  for (const field of TARGET_NUMBER_FIELDS) {
    const input = refs.numbers.get(field.key);
    if (!input) continue;
    result[field.key] = numberFieldValue(input, fieldDefault(field.key), field.min);
  }

  return result;
}

export function wireTargetEditor() {
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

  must<HTMLButtonElement>("#closeTargetDialogBtn").addEventListener("click", closeTargetDialog);
  must<HTMLButtonElement>("#cancelTargetBtn").addEventListener("click", closeTargetDialog);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const target = targetFromForm();
      const previousId = refs!.editingId.value || (target.id as string);
      sendCommand({ kind: "upsert_target", targetId: previousId, target } as unknown as ControllerCommand);
      toast("目标已保存,等待控制器确认", "good");
      closeTargetDialog();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "bad");
    }
  });

  deleteBtn.addEventListener("click", () => {
    const targetId = refs!.editingId.value;
    const target = findTarget(targetId);
    if (!targetId || !target) return;
    const product = target.products && target.products[0];
    if (!confirm(`删除目标「${product ? itemName(product.item) : targetId}」?`)) return;
    sendCommand({ kind: "delete_target", targetId });
    closeTargetDialog();
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeTargetDialog();
  });
}
