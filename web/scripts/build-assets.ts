// 手动重建物品资产索引与图标(不必启动服务器):bun run assets
// 装/删 mod 或整合包更新后跑一次;服务器启动时也会自动重建。
import { buildAssetIndex } from "../src/server/assets";

const startedAt = Date.now();
const index = buildAssetIndex();

const namespaces = new Map<string, number>();
let withIcon = 0;
let exported = 0;
let cubes = 0;
for (const [id, item] of Object.entries(index.items)) {
  const namespace = id.split(":", 1)[0];
  namespaces.set(namespace, (namespaces.get(namespace) || 0) + 1);
  if (item.icon) withIcon++;
  if (item.iconKind === "export") exported++;
  if (item.iconKind === "cube") cubes++;
}

console.log(`游戏目录: ${index.gameRoot}`);
console.log(
  `物品 ${index.count} 个 | 带图标 ${withIcon} 个(游戏内导出 ${exported}、方块立体合成 ${cubes}) | 命名空间 ${namespaces.size} 个 | 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);
if (exported === 0) {
  console.log("提示: 未发现游戏内导出图(实例根目录的 icon-exports-x*),当前全部为本地合成;要最佳效果先在游戏里跑 /iconexporter export 64(见 README)");
}
const top = [...namespaces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [namespace, count] of top) console.log(`  ${namespace}: ${count}`);
