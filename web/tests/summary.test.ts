// 金样测试：recomputeSummary 对 fixture 快照重算的结果必须与 Lua 侧
// summarize 写入快照的 summary 完全一致；defaultDisplayName 与 Lua
// items.lua 的推导语义对齐。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultDisplayName, recomputeSummary } from "../src/shared/summary";
import type { ControllerSnapshot } from "../src/shared/protocol";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

type Pair = { commandId: string; preSnapshot: ControllerSnapshot; postSnapshot: ControllerSnapshot };
const pairs: Pair[] = JSON.parse(await Bun.file(join(FIXTURES, "command-snapshot-pairs.json")).text());
const latest: ControllerSnapshot = JSON.parse(await Bun.file(join(FIXTURES, "latest-snapshot.json")).text());

describe("recomputeSummary 金样（与 Lua summarize 一致）", () => {
  const snapshots: Array<[string, ControllerSnapshot]> = [
    ["latest-snapshot", latest],
    ...pairs.flatMap((p): Array<[string, ControllerSnapshot]> => [
      [`pre ${p.commandId}`, p.preSnapshot],
      [`post ${p.commandId}`, p.postSnapshot],
    ]),
  ];

  for (const [name, snapshot] of snapshots) {
    test(name, () => {
      const authoritative = snapshot.summary;
      expect(authoritative).toBeDefined();
      const copy = JSON.parse(JSON.stringify(snapshot)) as ControllerSnapshot;
      recomputeSummary(copy);
      expect(copy.summary).toEqual(authoritative as never);
    });
  }
});

describe("defaultDisplayName（与 Lua items.defaultDisplayName 对齐）", () => {
  const cases: Array<[string, string]> = [
    ["create:iron_sheet", "Iron Sheet"],
    ["minecraft:iron_ingot", "Iron Ingot"],
    ["create:andesite_encased_large_cogwheel", "Andesite Encased Large Cogwheel"],
    ["plain_item", "Plain Item"],
    ["", "Item"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(defaultDisplayName(input)).toBe(expected);
    });
  }
});
