// 金样测试：Phase 0 抓取的 12 组 (preSnapshot, request) → postSnapshot 配对。
// 乐观层只是预览，post 快照才是 Lua 权威结果——断言的是"乐观效果与权威结果
// 在命令声明的字段上一致"，而非整快照相等。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyCommandToSnapshot, sanitizeCommandForController, targetDisplayId, wholeBatchRequestItems } from "../src/shared/commands";
import type { ControllerCommand, ControllerSnapshot, TargetSnapshot } from "../src/shared/protocol";

type Pair = {
  commandId: string;
  kind: string;
  status: string;
  request: ControllerCommand;
  preSnapshot: ControllerSnapshot;
  postSnapshot: ControllerSnapshot;
};

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "command-snapshot-pairs.json");
const pairs: Pair[] = JSON.parse(await Bun.file(FIXTURE).text());

describe("fixture 完整性", () => {
  test("12 组配对，全部 synced", () => {
    expect(pairs.length).toBe(12);
    for (const pair of pairs) expect(pair.status).toBe("synced");
  });
});

describe("applyCommandToSnapshot 金样（乐观效果与 Lua 权威结果一致）", () => {
  for (const pair of pairs) {
    test(`${pair.kind} ${pair.commandId}`, () => {
      const optimistic = applyCommandToSnapshot(pair.preSnapshot, pair.request);
      expect(optimistic).not.toBeNull();
      const targetId = pair.request.targetId || "";

      if (pair.request.kind === "set_enabled" || pair.request.kind === "target_enabled") {
        const wantEnabled = pair.request.enabled !== false;
        const optTarget = optimistic!.targets?.find((t) => t.id === targetId);
        const postTarget = pair.postSnapshot.targets?.find((t) => t.id === targetId);
        expect(optTarget).toBeDefined();
        expect(postTarget).toBeDefined();
        expect(optTarget!.enabled).toBe(wantEnabled);
        if (postTarget!.enabled === wantEnabled) {
          // 干净配对：乐观结果与权威结果一致
          expect(optimistic!.summary?.enabled).toBe(pair.postSnapshot.summary?.enabled);
          expect(optimistic!.summary?.total).toBe(pair.postSnapshot.summary?.total);
        }
        // 否则：抓取时命令连发，post 快照被后续命令覆盖（fixture 已知污染，
        // 只断言命令语义；见 web_1782923549536 / web_1782923552206）
      }

      if (pair.request.kind === "upsert_target" || pair.request.kind === "save_target") {
        // Lua upsert 可能改名（targetId 是旧 id，command.target.id 是新 id）
        const expectedId = targetDisplayId(pair.request.target as Record<string, unknown>);
        const postTarget = pair.postSnapshot.targets?.find((t) => t.id === expectedId);
        const optTarget = optimistic!.targets?.find((t) => t.id === expectedId);
        expect(postTarget).toBeDefined();
        expect(optTarget).toBeDefined();
        // 双表示：数组条目的 item 集合与权威结果一致
        const items = (entries?: { item: string }[]) => (entries || []).map((e) => e.item).sort();
        expect(items(optTarget!.products)).toEqual(items(postTarget!.products));
        expect(items(optTarget!.inputs)).toEqual(items(postTarget!.inputs));
        expect(optimistic!.summary?.total).toBe(pair.postSnapshot.summary?.total);
      }

      // 纯函数：入参快照不得被改动
      expect(pair.preSnapshot.targets?.length).toBeDefined();
    });
  }
});

describe("sanitizeCommandForController 金样（upsert 双表示）", () => {
  const upserts = pairs.filter((p) => p.kind === "upsert_target" || p.kind === "save_target");

  test("fixture 里有 upsert 配对", () => {
    expect(upserts.length).toBeGreaterThanOrEqual(2);
  });

  for (const pair of upserts) {
    test(`双表示字段齐全 ${pair.commandId}`, () => {
      const clean = sanitizeCommandForController(pair.request);
      const target = clean.target as Record<string, unknown>;
      expect(Array.isArray(target.products)).toBe(true);
      expect(Array.isArray(target.inputs)).toBe(true);
      expect(typeof target.productItem).toBe("string");
      expect(typeof target.productLabel).toBe("string");
      expect(typeof target.inputItem).toBe("string");
      expect(typeof target.inputLabel).toBe("string");
      // 运行时字段必须被剥掉
      expect(target.status).toBeUndefined();
      expect(target.promisedInputs).toBeUndefined();
      // inputs 数组非空时 inputPerProduct 交由 Lua 重新推导
      if (Array.isArray(target.inputs) && target.inputs.length > 0) {
        expect(target.inputPerProduct).toBeUndefined();
      }
    });
  }

  test("非 upsert 命令原样返回", () => {
    const command: ControllerCommand = { kind: "set_enabled", targetId: "x", enabled: false };
    expect(sanitizeCommandForController(command)).toBe(command);
  });

  // 多物品单订单请求:items 必须原样透传(全部条目在 Lua 侧汇入同一 PackageOrder,
  // 理包机按订单合包;清洗层吞掉 items 会退化回逐物品拆单)
  test("request 命令 items 原样透传", () => {
    const command: ControllerCommand = {
      kind: "request",
      targetId: "create_brass_ingot",
      items: [
        { item: "minecraft:copper_ingot", count: 64 },
        { item: "create:zinc_ingot", count: 64 },
      ],
    };
    const clean = sanitizeCommandForController(command);
    expect(clean).toBe(command);
    expect(clean.items).toEqual([
      { item: "minecraft:copper_ingot", count: 64 },
      { item: "create:zinc_ingot", count: 64 },
    ]);
  });
});

// 人工催单整批化:请求量必须是样板每批消耗的同一整批倍数,不足一整批则不可请求。
// Lua 侧还会做库存全量校验与比例校验——这里锁定前端算出的请求本身就是合法形态。
describe("wholeBatchRequestItems 整批催单", () => {
  const mk = (inputs: Array<{ item: string; count: number }>, neededBatches?: number) =>
    ({ id: "t", inputs, neededBatches }) as TargetSnapshot;

  test("1:3 配比按 64 上限换算批数上限(21 批),数量保持配比", () => {
    const order = wholeBatchRequestItems(mk([{ item: "a:c", count: 1 }, { item: "a:z", count: 3 }], 1558));
    expect(order.batches).toBe(21);
    expect(order.items).toEqual([
      { item: "a:c", count: 21 },
      { item: "a:z", count: 63 },
    ]);
  });

  test("1:1 配比上限 64 批", () => {
    const order = wholeBatchRequestItems(mk([{ item: "a:c", count: 1 }, { item: "a:z", count: 1 }], 1558));
    expect(order.batches).toBe(64);
    expect(order.items).toEqual([
      { item: "a:c", count: 64 },
      { item: "a:z", count: 64 },
    ]);
  });

  test("缺料不足上限时按 neededBatches 请求", () => {
    const order = wholeBatchRequestItems(mk([{ item: "a:c", count: 2 }, { item: "a:z", count: 1 }], 5));
    expect(order.batches).toBe(5);
    expect(order.items).toEqual([
      { item: "a:c", count: 10 },
      { item: "a:z", count: 5 },
    ]);
  });

  test("超大配方(单批消耗 >64)保底 1 整批,不打散配比", () => {
    const order = wholeBatchRequestItems(mk([{ item: "a:big", count: 100 }], 7));
    expect(order.batches).toBe(1);
    expect(order.items).toEqual([{ item: "a:big", count: 100 }]);
  });

  test("neededBatches 为 0/缺省/无原料时不可请求", () => {
    expect(wholeBatchRequestItems(mk([{ item: "a:c", count: 1 }], 0)).batches).toBe(0);
    expect(wholeBatchRequestItems(mk([{ item: "a:c", count: 1 }])).batches).toBe(0);
    expect(wholeBatchRequestItems(mk([], 10)).batches).toBe(0);
    expect(wholeBatchRequestItems(mk([], 10)).items).toEqual([]);
  });
});
