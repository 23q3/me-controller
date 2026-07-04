# ME Controller Web 控制台

基于 Bun 的本地后端 + 浏览器控制台,配合游戏内 ComputerCraft ME 控制器使用。前后端全部 TypeScript,无框架,界面为 AE2 风格(侧边导航:总览 / 物品终端 / 自动维持 / 命令日志,自动合成与样板管理为规划中的占位)。

## 运行

```sh
cd web
bun install
bun run dev
```

脚本说明(`package.json`):

| 脚本 | 作用 |
|---|---|
| `bun run dev` | 先打包前端再启动服务器(改前端后重跑即可) |
| `bun run dev:client` | 前端打包挂 `--watch`,增量重打包 |
| `bun run dev:server` | 只启动服务器 |
| `bun run start` | 打包 + 启动(与 dev 等价的正式入口) |
| `bun test` | 跑 `tests/` 下的金样测试 |

前端入口 `src/client/main.ts` 打包到 `public/assets/main.js`(带 sourcemap)。端口默认 `8787`,可用 `PORT` 环境变量覆盖;注意部分 Windows 机器上 8787 落在系统保留端口区,启动失败时换一个端口即可。

浏览器打开:

```text
http://localhost:8787
```

### 不开游戏做前端开发

`scripts/fake-bridge.ts` 可模拟游戏内桥接(发送带 `stockCounts` 的快照心跳、确认命令),物品终端等视图即可看到数据:

```sh
PORT=8787 bun run scripts/fake-bridge.ts
```

`FAKE_SILENT=1` 可模拟"收到命令但不回包",用于测试前端的命令超时提示。注意 fake-bridge 的 `PORT` 要与服务器一致。

## 连接游戏内 Lua 控制器

在 CC 电脑终端里:

```text
me_controller bridge enable ws://localhost:8787/bridge
me_controller
```

如果 ComputerCraft 拒绝本地/局域网地址,确认 `config/computercraft-server.toml` 放行了 `$private` 规则(本实例已配置):

```toml
[[http.rules]]
host = "$private"
action = "allow"
```

如果游戏内 `localhost` 解析到 Minecraft 进程而不是宿主机,改用宿主机局域网 IP,例如 `ws://192.168.1.20:8787/bridge`。

### 物品终端(库存快照)

物品终端视图需要 Lua 侧快照携带 `stockCounts`,默认关闭(快照会大很多)。开启方式:编辑 `computer/0/apps/me_controller/bridge.db`,加上/改为 `includeStock = true`。桥接每次重连都会热加载 `bridge.db`,无需重启 Lua 程序;未开启时前端物品终端会显示开启指引空态。

## 目录结构

```text
web/
├── src/
│   ├── shared/          # 服务端与前端共用(协议类型、目标字段描述符、命令规范化、summary 重算)
│   ├── server/          # index(bootstrap)、routes、static、bridge-ws、ui-ws、state、store(sqlite)、assets
│   └── client/          # main、state(极简 store)、ws(重连)、api、render(全量重渲染)、target-editor、dom
├── scripts/fake-bridge.ts
├── tests/               # bun:test 金样测试(基于 fixtures/ 的真实快照)
└── public/              # index.html、styles.css;assets/ 与 generated/ 为构建产物(git 忽略)
```

## WebSocket 端点

- `/bridge`:游戏内 Lua 控制器连接(协议 `me_controller.bridge.v1`)。
- `/ui`:浏览器控制台连接,快照与命令状态实时广播。

## HTTP 端点

- `GET /api/status`:桥接状态、最新快照、近期命令。
- `GET /api/items`:物品资产索引(中文名/图标路径)。
- `POST /api/commands`:向 Lua 桥下发命令;body 不是合法 JSON 时返回 400 `{"error":"invalid json"}`。

命令示例:

```json
{
  "kind": "set_enabled",
  "targetId": "create_iron_sheet",
  "enabled": false
}
```

缺 `commandId` 时由后端补齐(mutating 命令幂等去重靠它)。命令状态存于 `../data/me-controller.sqlite`(存档 `computercraft/data/` 下,与 `web/` 平级),状态机为 sent → acknowledged/failed → synced。

快照不做乐观改写:界面上"启用中/停用中"等转圈状态只是 pending 标记,一切以 Lua 回传的权威快照为准。

## 物品名称与图标

后端扫描本地游戏资源,生成:

```text
public/generated/item-index.json
public/generated/items/<namespace>/<item>.png
```

扫描顺序:实例根目录 jar → `mods/**/*.jar` → `kubejs/assets` → `resourcepacks/*`。中文名取自 `assets/*/lang/zh_cn.json`,回退 `en_us.json`,再回退物品 id;图标优先取物品模型的 `layer0` 纹理,其次按方块/物品纹理猜测。

资产索引在**服务器启动时异步构建一次**,`/api/items` 会等待构建完成;装了新 mod 或资源包后需重启服务器重建。`/generated/*` 与 item-index 带缓存头,生成物是本地缓存,git 忽略。
