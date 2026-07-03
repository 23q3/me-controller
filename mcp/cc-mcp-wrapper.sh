#!/usr/bin/env bash
set -euo pipefail

LOG=/tmp/cc-mcp-wrapper.log
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export CC_ROOT=${CC_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
# venv 必须放在存档目录外：Linux venv 自带 lib64->lib 符号链接，
# 而 Minecraft 1.20+ 拒绝加载含符号链接的存档
export UV_PROJECT_ENVIRONMENT=${UV_PROJECT_ENVIRONMENT:-"$HOME/.venvs/cc-mcp"}

if command -v uv >/dev/null 2>&1; then
  RUNNER=(uv run --project "$SCRIPT_DIR" python "$SCRIPT_DIR/server.py")
elif [ -x "$UV_PROJECT_ENVIRONMENT/bin/python" ]; then
  RUNNER=("$UV_PROJECT_ENVIRONMENT/bin/python" "$SCRIPT_DIR/server.py")
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
