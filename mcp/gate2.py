"""Lua 侧回归门禁驱动（源自 Phase 2 每步门禁，保留作回归工具）：
cc_compile 全部模块 + targets.db 落盘往返 + me_controller 冒烟五连。
用法：python gate2.py [compile|roundtrip|smoke|stop|all]（默认 all）
前提：游戏在跑且 agent 在线；目前只支持 Windows（直接拉起 cc-mcp-wrapper.cmd）。
任何一步失败时退出码为 1。
"""
import json
import os
import subprocess
import sys
import time

MCP_DIR = os.path.dirname(os.path.abspath(__file__))

COMPILE_PATHS = [
    "agent.lua",
    "apps/me_controller/config.lua",
    "apps/me_controller/util.lua",
    "apps/me_controller/items.lua",
    "apps/me_controller/targets_store.lua",
    "apps/me_controller/recipes_store.lua",
    "apps/me_controller/state_store.lua",
    "apps/me_controller/tracking.lua",
    "apps/me_controller/network.lua",
    "apps/me_controller/planner.lua",
    "apps/me_controller/decide.lua",
    "apps/me_controller/commands.lua",
    "apps/me_controller/core.lua",
    "apps/me_controller/bridge.lua",
    "apps/me_controller/ui.lua",
    "apps/me_controller/main.lua",
]

SMOKE = [
    ("mc_once",     "me_controller once",          ["targets=", "errors="]),
    ("mc_targets",  "me_controller targets",       ["products="]),
    ("mc_recipes",  "me_controller recipes",       ["recipes="]),
    ("mc_events",   "me_controller events 5",      ["t="]),
    ("mc_commands", "me_controller commands 5",    [". t="]),
    ("mc_bridge",   "me_controller bridge status", ["bridge enabled="]),
]

# targets.db 往返门禁：fixture → normalizeTargets → saveTargets → 重读，
# 两级 deep-equal（norm vs fixture 语义一致；落盘重读 vs 内存一致）
ROUNDTRIP_LUA = """
local mk = dofile("rom/modules/main/cc/require.lua")
local env = setmetatable({}, { __index = _G })
local req, pkg = mk.make(env, "apps/me_controller")
env.require, env.package = req, pkg
local Config = req("config")
local Util = req("util")
local TS = req("targets_store")
Config.CONFIG.targetsFile = "gate_rt_out.db"
local raw = Util.readSerialized("gate_rt_in.db")
local norm = TS.normalizeTargets(raw.targets)
TS.saveTargets(norm)
local reread = Util.readSerialized("gate_rt_out.db")
local function eq(a, b, path)
  if type(a) ~= type(b) then return false, path .. " type " .. type(a) .. "~=" .. type(b) end
  if type(a) ~= "table" then
    if a ~= b then return false, path .. " " .. tostring(a) .. " ~= " .. tostring(b) end
    return true
  end
  for k, v in pairs(a) do
    local ok, why = eq(v, b[k], path .. "." .. tostring(k))
    if not ok then return false, why end
  end
  for k in pairs(b) do
    if a[k] == nil then return false, path .. "." .. tostring(k) .. " only in right" end
  end
  return true
end
local ok1, why1 = eq(norm, raw.targets, "norm_vs_fixture")
local ok2, why2 = eq(reread, { version = 1, targets = norm }, "reread_vs_saved")
fs.delete("gate_rt_in.db")
fs.delete("gate_rt_out.db")
return { ok1 = ok1, why1 = why1, ok2 = ok2, why2 = why2 }
"""


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    proc = subprocess.Popen(
        ["cmd", "/c", os.path.join(MCP_DIR, "cc-mcp-wrapper.cmd")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    )
    next_id = [0]

    def send(msg):
        proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def request(method, params, timeout_s=90):
        next_id[0] += 1
        rid = next_id[0]
        send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("id") == rid:
                return msg
        raise RuntimeError("client timeout")

    def call(name, arguments):
        msg = request("tools/call", {"name": name, "arguments": arguments})
        if "error" in msg:
            return False, msg["error"]["message"]
        texts = [c.get("text", "") for c in msg["result"].get("content", [])]
        return not msg["result"].get("isError", False), "\n".join(texts)

    request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                           "clientInfo": {"name": "gate2", "version": "0"}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    failed = False
    if mode == "stop":
        ok, blob = call("cc_stop_agent", {"timeoutMs": 10000})
        print(f"[stop_agent] {'ok' if ok else 'FAIL'}")
        print("  " + blob[:200].replace("\n", "\n  "))

    if mode in ("compile", "all"):
        ok, blob = call("cc_compile", {"paths": COMPILE_PATHS, "timeoutMs": 20000})
        good = ok and '"ok": true' in blob.replace("ok = true", '"ok": true')
        print(f"[compile] {'ok' if good else 'FAIL'}")
        print("  " + blob[:600].replace("\n", "\n  "))
        failed = failed or not good

    if mode in ("roundtrip", "all"):
        fixture = open(os.path.join(MCP_DIR, "..", "fixtures", "targets.db"), encoding="utf-8").read()
        ok, blob = call("cc_write_file", {"path": "gate_rt_in.db", "content": fixture})
        if not ok:
            print("[roundtrip] FAIL 上传 fixture 失败")
            failed = True
        else:
            ok, blob = call("cc_run_lua", {"code": ROUNDTRIP_LUA, "timeoutMs": 20000})
            good = ok and "ok1 = true" in blob and "ok2 = true" in blob
            print(f"[roundtrip] {'ok' if good else 'FAIL'}")
            print("  " + blob[:500].replace("\n", "\n  "))
            failed = failed or not good

    if mode in ("smoke", "all"):
        for step, command, expect in SMOKE:
            ok, blob = call("cc_run_shell", {"command": command, "timeoutMs": 60000})
            data = {}
            try:
                data = json.loads(blob)
            except Exception:
                pass
            output = data.get("output") or blob
            good = ok and data.get("ok") is True and all(marker in output for marker in expect)
            print(f"[{step}] {'ok' if good else 'FAIL'}")
            print("  " + output[:400].replace("\n", "\n  "))
            print()
            failed = failed or not good

    proc.stdin.close()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.terminate()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
