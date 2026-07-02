# ComputerCraft MCP 桥

这是一个给当前存档里的 CC:Tweaked 电脑使用的小型 MCP 桥。它通过存档目录里的文件队列和游戏内 `agent.lua` 通信，让 Codex 可以运行 Lua、读写电脑文件，并访问外设。

## 游戏内启动

在 ComputerCraft 电脑终端里运行：

```lua
agent
```

`agent.lua` 会监听 `cc_agent/inbox` 里的命令文件，执行后把结果写到 `cc_agent/outbox`。如果游戏重启或电脑重启，需要重新运行一次 `agent`。

## MCP 服务端

当前使用 Python 版服务端：

```text
mcp/computercraft-mcp.py
```

Codex 实际启动的是 wrapper：

```text
mcp/cc-mcp-wrapper.sh
```

wrapper 会调用 `/usr/bin/python3` 运行 Python MCP 服务端，并把启动日志写到：

```text
/tmp/cc-mcp-wrapper.log
/tmp/cc-mcp-python.log
```

默认情况下 wrapper 会从自身位置推导 `CC_ROOT`，也可以继续用环境变量覆盖。

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

Codex 通过 MCP 调用 `computercraft-mcp.py`。Python 服务端把命令写入 `computer/0/cc_agent/inbox`，游戏里的 `agent.lua` 读到命令后执行，并把结果写入 `computer/0/cc_agent/outbox`。MCP 服务端再把结果返回给 Codex，并默认删除已消费的结果文件，避免 outbox 慢慢堆积。
