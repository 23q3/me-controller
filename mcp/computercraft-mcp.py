#!/usr/bin/env python3
import json
import os
import random
import string
import sys
import time
from pathlib import Path


ROOT = Path(os.environ.get("CC_ROOT", Path(__file__).resolve().parents[1])).resolve()
COMPUTER_ID = os.environ.get("CC_COMPUTER_ID", "0")
COMPUTER_ROOT = ROOT / "computer" / COMPUTER_ID
AGENT_ROOT = COMPUTER_ROOT / "cc_agent"
INBOX = AGENT_ROOT / "inbox"
OUTBOX = AGENT_ROOT / "outbox"
DEBUG_LOG = Path("/tmp/cc-mcp-python.log")
OUTPUT_MODE = "content-length"


def debug(message: str) -> None:
    try:
        with DEBUG_LOG.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S%z')}] {message}\n")
    except Exception:
        pass


debug(f"start argv={sys.argv!r} cwd={os.getcwd()!r}")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def safe_path(rel_path: str) -> Path:
    resolved = (COMPUTER_ROOT / (rel_path or ".")).resolve()
    if resolved != COMPUTER_ROOT and COMPUTER_ROOT not in resolved.parents:
        raise RuntimeError("Path escapes computer root")
    return resolved


def make_id() -> str:
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    return f"{int(time.time() * 1000):x}-{suffix}"


def write_command(kind: str, body: str = "") -> str:
    ensure_dir(INBOX)
    ensure_dir(OUTBOX)
    command_id = make_id()
    (INBOX / f"{command_id}.cmd").write_text(f"id={command_id} kind={kind}\n{body}", encoding="utf-8")
    return command_id


def parse_result(text: str) -> dict:
    header, _, body = text.partition("\n\n")
    fields = {}
    for line in header.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    marker = body.find("\nOUTPUT\n")
    value = body[len("VALUE\n"):marker] if marker != -1 else ""
    output = body[marker + len("\nOUTPUT\n"):] if marker != -1 else body
    return {
        "id": fields.get("id"),
        "ok": fields.get("ok") == "true",
        "value": value,
        "output": output,
    }


def wait_result(command_id: str, timeout_ms: int = 10000, consume: bool = True) -> dict:
    result_file = OUTBOX / f"{command_id}.txt"
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if result_file.exists():
            result = parse_result(result_file.read_text(encoding="utf-8"))
            if consume:
                try:
                    result_file.unlink()
                except FileNotFoundError:
                    pass
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for CC agent result {command_id}. Is computer/0/agent.lua running?")


def lua_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'


def compile_files(paths: list[str], timeout_ms: int) -> dict:
    if not paths:
        raise RuntimeError("paths must not be empty")
    if len(paths) > 50:
        raise RuntimeError("Refusing to compile more than 50 files at once")

    quoted_paths = ", ".join(lua_quote(path) for path in paths)
    code = "\n".join(
        [
            f"local paths = {{ {quoted_paths} }}",
            "local compiled = {}",
            "for _, path in ipairs(paths) do",
            "  local fn, err = loadfile(path)",
            "  if not fn then return { ok = false, path = path, error = tostring(err), compiled = compiled } end",
            "  compiled[#compiled + 1] = path",
            "end",
            "return { ok = true, compiled = compiled }",
        ]
    )
    result = wait_result(write_command("lua", code), timeout_ms)
    if not result.get("ok"):
        return result
    return result


def queue_status() -> dict:
    ensure_dir(INBOX)
    ensure_dir(OUTBOX)
    current = AGENT_ROOT / "current"
    ensure_dir(current)

    def entries(path: Path) -> list[str]:
        return sorted(child.name for child in path.iterdir() if child.is_file())

    return {
        "computerRoot": str(COMPUTER_ROOT),
        "agentRoot": str(AGENT_ROOT),
        "inbox": entries(INBOX),
        "current": entries(current),
        "outbox": entries(OUTBOX),
    }


def call_tool(name: str, args: dict | None = None):
    args = args or {}
    timeout_ms = int(args.get("timeoutMs", 10000))

    if name == "cc_ping":
        return wait_result(write_command("ping"), timeout_ms)
    if name == "cc_agent_status":
        status = queue_status()
        if args.get("ping"):
            try:
                status["ping"] = wait_result(write_command("ping"), timeout_ms)
            except Exception as exc:
                status["pingError"] = str(exc)
        return status
    if name == "cc_run_lua":
        code = args.get("code")
        if not isinstance(code, str):
            raise RuntimeError("code must be a string")
        return wait_result(write_command("lua", code), timeout_ms)
    if name == "cc_run_shell":
        command = args.get("command")
        if not isinstance(command, str):
            raise RuntimeError("command must be a string")
        return wait_result(write_command("shell", command), timeout_ms)
    if name == "cc_compile":
        paths = args.get("paths")
        path = args.get("path")
        if paths is None and path is not None:
            paths = [path]
        if not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
            raise RuntimeError("path must be a string or paths must be an array of strings")
        return compile_files(paths, timeout_ms)
    if name == "cc_list_files":
        directory = safe_path(args.get("path", "."))
        return [
            {"name": child.name, "type": "directory" if child.is_dir() else "file"}
            for child in sorted(directory.iterdir(), key=lambda p: p.name)
        ]
    if name == "cc_read_file":
        path = args.get("path")
        if not isinstance(path, str):
            raise RuntimeError("path must be a string")
        return safe_path(path).read_text(encoding="utf-8")
    if name == "cc_write_file":
        path = args.get("path")
        content = args.get("content")
        if not isinstance(path, str):
            raise RuntimeError("path must be a string")
        if not isinstance(content, str):
            raise RuntimeError("content must be a string")
        target = safe_path(path)
        ensure_dir(target.parent)
        target.write_text(content, encoding="utf-8")
        return {"path": path, "bytes": len(content.encode("utf-8"))}
    if name == "cc_stop_agent":
        return wait_result(write_command("stop"), timeout_ms)
    raise RuntimeError(f"Unknown tool: {name}")


TOOLS = [
    {
        "name": "cc_ping",
        "description": "Ping the ComputerCraft agent running on the in-game computer.",
        "inputSchema": {"type": "object", "properties": {"timeoutMs": {"type": "number"}}},
    },
    {
        "name": "cc_agent_status",
        "description": "Show local ComputerCraft agent queue status, optionally pinging the in-game agent.",
        "inputSchema": {"type": "object", "properties": {"ping": {"type": "boolean"}, "timeoutMs": {"type": "number"}}},
    },
    {
        "name": "cc_run_lua",
        "description": "Run a Lua snippet inside the ComputerCraft computer via agent.lua.",
        "inputSchema": {
            "type": "object",
            "required": ["code"],
            "properties": {"code": {"type": "string"}, "timeoutMs": {"type": "number"}},
        },
    },
    {
        "name": "cc_run_shell",
        "description": "Run a CraftOS shell command inside the ComputerCraft computer via agent.lua.",
        "inputSchema": {
            "type": "object",
            "required": ["command"],
            "properties": {"command": {"type": "string"}, "timeoutMs": {"type": "number"}},
        },
    },
    {
        "name": "cc_compile",
        "description": "Compile one or more Lua files inside the ComputerCraft computer with loadfile, without executing them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "timeoutMs": {"type": "number"},
            },
        },
    },
    {
        "name": "cc_list_files",
        "description": "List files inside the mapped ComputerCraft filesystem.",
        "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}},
    },
    {
        "name": "cc_read_file",
        "description": "Read a file from the mapped ComputerCraft filesystem.",
        "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}},
    },
    {
        "name": "cc_write_file",
        "description": "Write a file into the mapped ComputerCraft filesystem.",
        "inputSchema": {
            "type": "object",
            "required": ["path", "content"],
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        },
    },
    {
        "name": "cc_stop_agent",
        "description": "Stop the ComputerCraft agent loop.",
        "inputSchema": {"type": "object", "properties": {"timeoutMs": {"type": "number"}}},
    },
]


def result_content(value):
    return {"content": [{"type": "text", "text": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)}]}


def handle(message: dict):
    method = message.get("method")
    params = message.get("params") or {}

    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "computercraft-file-agent", "version": "0.2.0"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return result_content(call_tool(params.get("name"), params.get("arguments") or {}))
    if method == "resources/list":
        return {
            "resources": [
                {
                    "uri": f"cc://computer/{COMPUTER_ID}/status",
                    "name": f"ComputerCraft Computer {COMPUTER_ID}",
                    "description": "Status for the mapped ComputerCraft computer and in-game agent.",
                    "mimeType": "application/json",
                }
            ]
        }
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        uri = params.get("uri")
        if uri != f"cc://computer/{COMPUTER_ID}/status":
            raise RuntimeError(f"Unknown resource: {uri}")
        status = call_tool("cc_ping", {"timeoutMs": 2000})
        return {"contents": [{"uri": uri, "mimeType": "application/json", "text": json.dumps(status, ensure_ascii=False, indent=2)}]}
    if method == "notifications/initialized":
        return None
    raise RuntimeError(f"Unsupported method: {method}")


def send(message: dict) -> None:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    debug(f"send mode={OUTPUT_MODE} id={message.get('id')!r} keys={list(message.keys())!r}")
    if OUTPUT_MODE == "json-line":
        sys.stdout.buffer.write(body + b"\n")
    else:
        sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
    sys.stdout.buffer.flush()


def process_message(message: dict) -> None:
    if "id" not in message:
        try:
            handle(message)
        except Exception:
            pass
        return
    try:
        send({"jsonrpc": "2.0", "id": message["id"], "result": handle(message)})
    except Exception as exc:
        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(exc)}})


def main() -> None:
    global OUTPUT_MODE
    buffer = b""
    decoder = json.JSONDecoder()
    while True:
        chunk = sys.stdin.buffer.read1(4096)
        if not chunk:
            time.sleep(0.05)
            continue
        debug(f"chunk len={len(chunk)} preview={chunk[:120]!r}")
        buffer += chunk
        while buffer:
            header_end = buffer.find(b"\r\n\r\n")
            sep_len = 4
            if header_end == -1:
                header_end = buffer.find(b"\n\n")
                sep_len = 2
            if header_end != -1:
                header = buffer[:header_end].decode("ascii", errors="replace")
                length = None
                for line in header.splitlines():
                    if line.lower().startswith("content-length:"):
                        length = int(line.split(":", 1)[1].strip())
                        break
                if length is None:
                    send({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Missing Content-Length"}})
                    buffer = b""
                    break
                body_start = header_end + sep_len
                if len(buffer) < body_start + length:
                    break
                body = buffer[body_start:body_start + length]
                buffer = buffer[body_start + length:]
                OUTPUT_MODE = "content-length"
                process_message(json.loads(body.decode("utf-8")))
                continue

            newline = buffer.find(b"\n")
            stripped = buffer.lstrip()
            leading_ws = len(buffer) - len(stripped)
            if stripped.startswith(b"{"):
                try:
                    text = stripped.decode("utf-8")
                    message, end = decoder.raw_decode(text)
                except json.JSONDecodeError:
                    if newline == -1:
                        break
                else:
                    consumed = leading_ws + len(text[:end].encode("utf-8"))
                    buffer = buffer[consumed:]
                    OUTPUT_MODE = "json-line"
                    process_message(message)
                    continue

            if newline == -1:
                break
            line = buffer[:newline].strip()
            buffer = buffer[newline + 1:]
            if line:
                OUTPUT_MODE = "json-line"
                process_message(json.loads(line.decode("utf-8")))


if __name__ == "__main__":
    main()
