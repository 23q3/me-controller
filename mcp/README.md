# ComputerCraft MCP 桥

这是一个给当前存档里的 CC:Tweaked 电脑使用的小型 MCP 桥。它通过存档目录里的文件队列和游戏内 `agent.lua` 通信，让 MCP 客户端（Codex、Claude Code 等）可以运行 Lua、读写电脑文件，并访问外设。

## 游戏内启动

在 ComputerCraft 电脑终端里运行：

```lua
agent
```

`agent.lua` 会监听 `cc_agent/inbox` 里的命令文件，执行后把结果写到 `cc_agent/outbox`。如果游戏重启或电脑重启，需要重新运行一次 `agent`。

## MCP 服务端

基于官方 Python SDK（FastMCP）的 uv 项目：

```text
mcp/
├── pyproject.toml    # uv 项目，依赖 mcp>=1.2
├── server.py         # FastMCP：9 个 @mcp.tool() + 1 个状态资源
├── cc_queue.py       # inbox/outbox 文件队列协议（从旧脚本逐字移植）
└── cc-mcp-wrapper.sh # MCP 客户端实际启动的入口
```

wrapper 优先用 `uv run --project` 启动（自动创建 `.venv` 并安装依赖）；`uv` 不在 PATH 时回退到 `mcp/.venv/bin/python`。启动日志写到：

```text
/tmp/cc-mcp-wrapper.log
```

默认情况下 wrapper 会从自身位置推导 `CC_ROOT`，也可以用环境变量覆盖。

> **与旧版的行为差异**：旧的手写服务端（`computercraft-mcp.py`）同时支持 `Content-Length` 分帧和 newline JSON-RPC 两种 stdio 分帧；SDK 版只走标准的 newline JSON-RPC。现代 MCP 客户端（Codex、Claude Code、Inspector）都用后者。旧脚本保留到游戏内门禁 B 通过后删除。

## Codex 配置示例

```toml
[mcp_servers.cc]
type = "stdio"
command = "/mnt/d/我的世界/客户端/版本隔离的通用端/.minecraft/versions/Mechanomania-航空学/saves/test1/computercraft/mcp/cc-mcp-wrapper.sh"
args = []

[mcp_servers.cc.env]
CC_ROOT = "/mnt/d/我的世界/客户端/版本隔离的通用端/.minecraft/versions/Mechanomania-航空学/saves/test1/computercraft"
CC_COMPUTER_ID = "0"
```

改完 MCP 配置后，通常需要重启 Codex 或 VS Code，让 MCP 客户端重新加载。

## 可用工具

- `cc_ping`：确认游戏内 agent 是否在线。
- `cc_agent_status`：查看本地 inbox/current/outbox 队列，可选顺手 ping agent。
- `cc_run_lua`：在 CC 电脑内执行 Lua 代码。
- `cc_run_shell`：在 CC 电脑内执行 CraftOS shell 命令。
- `cc_compile`：用 `loadfile` 编译一个或多个 Lua 文件，不执行文件主体。
- `cc_list_files`：列出映射到存档里的电脑文件。
- `cc_read_file`：读取电脑文件。
- `cc_write_file`：写入电脑文件。
- `cc_stop_agent`：停止游戏内 agent 循环。

## 可用资源

- `cc://computer/0/status`：读取电脑和 agent 的状态。

## 工作原理

MCP 客户端通过 stdio 调用 `server.py`。服务端把命令写入 `computer/0/cc_agent/inbox`，游戏里的 `agent.lua` 读到命令后执行，并把结果写入 `computer/0/cc_agent/outbox`。服务端再把结果返回给客户端，并默认删除已消费的结果文件，避免 outbox 慢慢堆积。协议细节（命令文件格式、结果的 `VALUE/OUTPUT` 段式）见 `cc_queue.py` 文件头注释。
