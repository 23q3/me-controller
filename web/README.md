# ME Controller Web

Bun-based local backend and browser console for the ComputerCraft ME controller.

## Run

```sh
cd web
bun install
bun run dev
```

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

The backend assigns `commandId` when absent and stores command state in `data/me-controller.sqlite`.

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
