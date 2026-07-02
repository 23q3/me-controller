# fixtures/ — 重构基线样本（Phase 0 抓取，2026-07-02）

重构期间的对比基准。所有文件抓取自基线提交（7e84011）时的运行数据，**只读，不要更新**——它们的意义就是"重构前的行为"。

## 文件清单

| 文件 | 来源 | 用途 |
|---|---|---|
| `targets.db` | `computer/0/apps/me_controller/targets.db` 副本 | Lua 拆分后 normalize→save 往返对比（version=1，目标含 legacy 标量 + products[]/inputs[] 双表示） |
| `state.db` | 同目录副本 | stateVersion=6 结构参考 |
| `bridge.db` | 同目录副本 | Bridge 配置形状参考（url=ws://localhost:8787/bridge） |
| `api-status.json` | 本机起 web 服务后 `GET /api/status`（bridge 未连接，快照来自 sqlite 恢复） | Phase 3 重构后 `/api/status` 形状 deep-equal 对比 |
| `api-items-sample.json` | `GET /api/items` 截取前 3 项（全量 2539 项） | item-index 形状参考（items 是 dict，键为物品 id） |
| `command-snapshot-pairs.json` | sqlite `data/me-controller.sqlite` 提取的 12 组配对 | Phase 3 金样测试：`(preSnapshot, request) → postSnapshot`（2× upsert_target + 10× set_enabled，均 synced） |
| `latest-snapshot.json` | sqlite 最新一条快照 | 快照 schema `me_controller.snapshot.v1` 形状参考 |

## 抓取时确认的现状 bug（重构中要修，修完对照验证）

- `GET /generated/**.png` → content-type `application/octet-stream`（应为 `image/png`）
- `POST /api/commands` 非法 JSON → 500（应为 400 `{error:"invalid json"}`）

## 游戏内门禁 checklist（抓取时游戏离线，下次游戏在跑时补验）

- [ ] `cc_ping` / `cc_agent_status` 通
- [ ] `cc_run_lua "return 1+1"` 返回 2
- [ ] `me_controller once` 输出 summary 行且无报错
- [ ] `me_controller targets` / `events 5` / `commands 5` / `bridge status` 正常
