"""inbox/outbox 文件队列协议 —— 从旧 computercraft-mcp.py 逐字移植。

协议不变量（与游戏内 agent.lua 对齐，勿改）：
- 命令文件：cc_agent/inbox/<id>.cmd，首行 `id=<id> kind=<kind>`，其后为 body
- 结果文件：cc_agent/outbox/<id>.txt，header 行 `k=v`，空行后 `VALUE\n...\nOUTPUT\n...` 段式
"""
import os
import random
import string
import time
from pathlib import Path


ROOT = Path(os.environ.get("CC_ROOT", Path(__file__).resolve().parents[1])).resolve()
COMPUTER_ID = os.environ.get("CC_COMPUTER_ID", "0")
COMPUTER_ROOT = ROOT / "computer" / COMPUTER_ID
AGENT_ROOT = COMPUTER_ROOT / "cc_agent"
INBOX = AGENT_ROOT / "inbox"
OUTBOX = AGENT_ROOT / "outbox"


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
    raise RuntimeError(f"Timed out waiting for CC agent result {command_id}. Is computer/{COMPUTER_ID}/agent.lua running?")


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
    return wait_result(write_command("lua", code), timeout_ms)


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
