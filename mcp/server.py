"""ComputerCraft 文件队列 MCP 服务端（官方 SDK / FastMCP 版）。

工具面与旧 computercraft-mcp.py 完全一致：9 个 cc_* 工具 + 1 个状态资源。
协议逻辑在 cc_queue.py；本文件只做 MCP 声明与参数校验。
"""
import json

from mcp.server.fastmcp import FastMCP

import cc_queue

mcp = FastMCP("computercraft-file-agent")


@mcp.tool()
def cc_ping(timeoutMs: float = 10000) -> dict:
    """Ping the ComputerCraft agent running on the in-game computer."""
    return cc_queue.wait_result(cc_queue.write_command("ping"), int(timeoutMs))


@mcp.tool()
def cc_agent_status(ping: bool = False, timeoutMs: float = 10000) -> dict:
    """Show local ComputerCraft agent queue status, optionally pinging the in-game agent."""
    status = cc_queue.queue_status()
    if ping:
        try:
            status["ping"] = cc_queue.wait_result(cc_queue.write_command("ping"), int(timeoutMs))
        except Exception as exc:
            status["pingError"] = str(exc)
    return status


@mcp.tool()
def cc_run_lua(code: str, timeoutMs: float = 10000) -> dict:
    """Run a Lua snippet inside the ComputerCraft computer via agent.lua."""
    return cc_queue.wait_result(cc_queue.write_command("lua", code), int(timeoutMs))


@mcp.tool()
def cc_run_shell(command: str, timeoutMs: float = 10000) -> dict:
    """Run a CraftOS shell command inside the ComputerCraft computer via agent.lua."""
    return cc_queue.wait_result(cc_queue.write_command("shell", command), int(timeoutMs))


@mcp.tool()
def cc_compile(path: str | None = None, paths: list[str] | None = None, timeoutMs: float = 10000) -> dict:
    """Compile one or more Lua files inside the ComputerCraft computer with loadfile, without executing them."""
    if paths is None and path is not None:
        paths = [path]
    if paths is None:
        raise RuntimeError("path must be a string or paths must be an array of strings")
    return cc_queue.compile_files(paths, int(timeoutMs))


@mcp.tool()
def cc_list_files(path: str = ".") -> list:
    """List files inside the mapped ComputerCraft filesystem."""
    directory = cc_queue.safe_path(path)
    return [
        {"name": child.name, "type": "directory" if child.is_dir() else "file"}
        for child in sorted(directory.iterdir(), key=lambda p: p.name)
    ]


@mcp.tool()
def cc_read_file(path: str) -> str:
    """Read a file from the mapped ComputerCraft filesystem."""
    return cc_queue.safe_path(path).read_text(encoding="utf-8")


@mcp.tool()
def cc_write_file(path: str, content: str) -> dict:
    """Write a file into the mapped ComputerCraft filesystem."""
    target = cc_queue.safe_path(path)
    cc_queue.ensure_dir(target.parent)
    target.write_text(content, encoding="utf-8")
    return {"path": path, "bytes": len(content.encode("utf-8"))}


@mcp.tool()
def cc_stop_agent(timeoutMs: float = 10000) -> dict:
    """Stop the ComputerCraft agent loop."""
    return cc_queue.wait_result(cc_queue.write_command("stop"), int(timeoutMs))


@mcp.resource(
    f"cc://computer/{cc_queue.COMPUTER_ID}/status",
    name=f"ComputerCraft Computer {cc_queue.COMPUTER_ID}",
    description="Status for the mapped ComputerCraft computer and in-game agent.",
    mime_type="application/json",
)
def computer_status() -> str:
    status = cc_queue.wait_result(cc_queue.write_command("ping"), 2000)
    return json.dumps(status, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    mcp.run()
