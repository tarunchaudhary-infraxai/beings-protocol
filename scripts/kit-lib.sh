# kit-lib.sh: shared helpers for skills/*/kit-install.sh (sourced, not run).
# Additive installs: missing files are added, identical ones kept, changed upstream files staged in .kit-upgrade/.

KIT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_ADDED=0 KIT_KEPT=0 KIT_STAGED=0

kit_say() { printf '  %s\n' "$*"; }

# kit_args "$@": sets HOME_DIR and BEING (from --name, being.toml, or the Teams kit .env).
kit_args() {
  HOME_DIR="" BEING=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) BEING="${2:?--name needs a value}"; shift 2 ;;
      -h|--help) return 2 ;;
      *) [[ -z "$HOME_DIR" ]] || { echo "unexpected argument: $1" >&2; return 2; }; HOME_DIR="$1"; shift ;;
    esac
  done
  [[ -n "$HOME_DIR" && -d "$HOME_DIR" ]] || { echo "usage: kit-install.sh <being-home> [--name <being>]" >&2; return 2; }
  HOME_DIR="$(cd "$HOME_DIR" && pwd -P)"
  if [[ -z "$BEING" && -f "$HOME_DIR/being.toml" ]]; then
    BEING="$("$KIT_REPO/scripts/being-config" --file "$HOME_DIR/being.toml" get being.name 2>/dev/null || true)"
  fi
  if [[ -z "$BEING" && -f "$HOME_DIR/ops/teams-kit/.env" ]]; then
    # shellcheck source=/dev/null
    BEING="$(set -a; . "$HOME_DIR/ops/teams-kit/.env" >/dev/null 2>&1; printf '%s' "${BEING_NAME:-}")"
  fi
  [[ "$BEING" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "Being name unknown or invalid; pass --name <being>" >&2; return 2; }
}

# kit_place <tmp file> <dest>: add, keep, or stage; consumes the tmp file.
kit_place() {
  local tmp="$1" dest="$2" stage
  if [[ ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"; mv "$tmp" "$dest"; KIT_ADDED=$((KIT_ADDED + 1))
  elif cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"; KIT_KEPT=$((KIT_KEPT + 1))
  else
    stage="$(dirname "$dest")/.kit-upgrade/$(basename "$dest")"
    mkdir -p "$(dirname "$stage")"; mv "$tmp" "$stage"; KIT_STAGED=$((KIT_STAGED + 1))
  fi
}

# kit_copy <src dir> <dest dir> <file>...: executables keep their mode.
kit_copy() {
  local src="$1" dst="$2" f tmp
  shift 2
  for f in "$@"; do
    tmp="$(mktemp)"; cp "$src/$f" "$tmp"
    [[ -x "$src/$f" ]] && chmod 755 "$tmp" || chmod 644 "$tmp"
    kit_place "$tmp" "$dst/$f"
  done
}

# kit_render <template> <dest> KEY=VALUE...: fills @KEY@ placeholders.
kit_render() {
  local src="$1" dest="$2" tmp kv
  shift 2
  tmp="$(mktemp)"; cp "$src" "$tmp"
  for kv in "$@"; do
    KR_V="${kv#*=}" KR_K="@${kv%%=*}@" python3 -c 'import os,sys
p=sys.argv[1]; s=open(p).read().replace(os.environ["KR_K"], os.environ["KR_V"]); open(p,"w").write(s)' "$tmp"
  done
  chmod 644 "$tmp"
  kit_place "$tmp" "$dest"
}

kit_unit_dir() { printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; }

kit_summary() {
  kit_say "$1: added $KIT_ADDED, kept $KIT_KEPT, staged $KIT_STAGED"
  [[ "$KIT_STAGED" -gt 0 ]] && kit_say "review the .kit-upgrade/ copies and swap them in when ready" || true
}
