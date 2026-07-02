#!/usr/bin/env bash
set -euo pipefail

LOG=/tmp/cc-mcp-wrapper.log
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=${CC_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
PYTHON=/usr/bin/python3
SCRIPT="$ROOT/mcp/computercraft-mcp.py"

{
  printf '[%s] wrapper start\n' "$(date -Is)"
  printf 'pwd=%s\n' "$(pwd)"
  printf 'python=%s exists=%s\n' "$PYTHON" "$([ -x "$PYTHON" ] && echo yes || echo no)"
  printf 'script=%s exists=%s\n' "$SCRIPT" "$([ -f "$SCRIPT" ] && echo yes || echo no)"
} >> "$LOG" 2>&1

"$PYTHON" "$SCRIPT" 2>> "$LOG"
STATUS=$?
printf '[%s] python exited status=%s\n' "$(date -Is)" "$STATUS" >> "$LOG"
exit "$STATUS"
