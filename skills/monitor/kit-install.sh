#!/usr/bin/env bash
# Install the monitor into a Being's home: <home>/ops/monitor/monitor.py, run by `being monitor`.
#   kit-install.sh <being-home>
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
HOME_DIR=${1:?usage: kit-install.sh <being-home>}
[[ -d "$HOME_DIR/.beings" ]] || { echo "kit-install: $HOME_DIR is not a Being home (no .beings/)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "kit-install: python3 is required" >&2; exit 2; }
DEST="$HOME_DIR/ops/monitor"
mkdir -p "$DEST"
install -m 0755 "$SRC/monitor.py" "$DEST/monitor.py"
install -m 0644 "$SRC/README.md" "$DEST/README.md"
echo "monitor installed: $DEST/monitor.py (run: being monitor, or python3 $DEST/monitor.py --list)"
