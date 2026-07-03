#!/usr/bin/env bash
set -euo pipefail

LOG=/tmp/cc-mcp-wrapper.log
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export CC_ROOT=${CC_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
# uv 缓存（~/.cache）与本 venv（/mnt/d）跨文件系统，硬链接本就不可用
export UV_LINK_MODE=copy

if command -v uv >/dev/null 2>&1; then
  RUNNER=(uv run --project "$SCRIPT_DIR" python "$SCRIPT_DIR/server.py")
elif [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
  RUNNER=("$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/server.py")
else
  printf '[%s] neither uv nor %s/.venv/bin/python available\n' "$(date -Is)" "$SCRIPT_DIR" >> "$LOG"
  exit 1
fi

{
  printf '[%s] wrapper start\n' "$(date -Is)"
  printf 'pwd=%s\n' "$(pwd)"
  printf 'cc_root=%s\n' "$CC_ROOT"
  printf 'runner=%s\n' "${RUNNER[*]}"
} >> "$LOG" 2>&1

exec "${RUNNER[@]}" 2>> "$LOG"
