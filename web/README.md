# ME Controller Web

Bun-based local backend and browser console for the ComputerCraft ME controller.

## Run

```sh
cd web
bun install
bun run dev
```

`bun run dev` / `bun run start` 会先把前端(`src/client/main.ts`)打包到 `public/assets/main.js` 再起服务器;改前端后重跑即可,或用 `bun run dev:client` 挂 watch 增量打包。端口默认 8787,可用 `PORT` 环境变量覆盖。

前端开发不必开游戏:`PORT=8787 bun run scripts/fake-bridge.ts` 可模拟游戏内桥接(发送带 `stockCounts` 的快照、确认命令),物品终端等视图即可看到数据。

Open:

```text
http://localhost:8787
```

Connect the Lua controller:

```text
me_controller bridge enable ws://localhost:8787/bridge
me_controller
```

If ComputerCraft rejects local/LAN addresses, make sure `config/computercraft-server.toml`
allows the `$private` HTTP rule. This instance is configured as:

```toml
[[http.rules]]
host = "$private"
action = "allow"
```

If `localhost` resolves to the Minecraft process instead of the host backend, use the host
LAN IP instead, such as `ws://192.168.1.20:8787/bridge`.

## WebSocket Endpoints

- `/bridge`: Lua edge controller connects here.
- `/ui`: browser console connects here.

## HTTP Endpoints

- `GET /api/status`: current bridge state, latest snapshot, recent commands.
- `POST /api/commands`: send a command to Lua bridge.

Example command:

```json
{
  "kind": "set_enabled",
  "targetId": "create_iron_sheet",
  "enabled": false
}
```

The backend assigns `commandId` when absent and stores command state in `../data/me-controller.sqlite`（存档 computercraft/data/ 下，与 web/ 平级）.

## Item Names And Icons

The backend scans local game resources and generates:

```text
public/generated/item-index.json
public/generated/items/<namespace>/<item>.png
```

Sources are scanned in this order:

```text
instance root jars
mods/**/*.jar
kubejs/assets
resourcepacks/*
```

Chinese names come from `assets/*/lang/zh_cn.json`, with `en_us.json` and item id fallback.
Icons are copied from item model `layer0` textures first, then simple block/item texture guesses.
Generated assets are local cache files and are ignored by git.
