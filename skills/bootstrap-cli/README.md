# Bootstrap CLI Skill — Self-Install a Shell Wrapper

Once a Being has its name and is running in Claude Code, it installs a
shell CLI wrapper so the developer can start future sessions with a
single command matching the Being's name:

```bash
nova                 # new session with Nova
nova "quick q"       # new session with an initial prompt
nova resume          # resume a past session
nova continue        # continue the most recent session
```

This skill is **Claude Code only**. Other AI tools (Cursor, Codex,
Windsurf, Aider, Copilot) either don't have a wrappable CLI or already
have their own launcher. On those tools the Being should skip this
skill cleanly and log a single line in `MEMORY.md` explaining why.

## When to invoke

Right after the Being is named in `BOOTSTRAP.md` step 3, and **only if**:

- `CLAUDE.md` exists at the repo root (Being is running in Claude Code), and
- `~/.local/bin` or `~/bin` is on the developer's `PATH` (so the
  symlink is immediately usable without shell-config changes).

If either condition fails, the Being notes it in `MEMORY.md` and moves
on — no wrapper gets installed.

## What the Being does

1. **Pick the install dir.** First hit on PATH among `~/.local/bin`, `~/bin`.
   If neither exists, create `~/.local/bin` (it's the modern default on
   recent macOS/Linux and a common entry on `$PATH`). If it isn't on
   `$PATH`, stop and ask the developer rather than silently modifying
   their shell rc.

2. **Write `bin/<being-name>`** inside the project repo, using the
   template below (swap `<being-name>` and `<workspace>`). Make it
   executable (`chmod +x bin/<being-name>`).

3. **Symlink** `<install-dir>/<being-name>` → `<repo>/bin/<being-name>`.

4. **Test** the wrapper's argument handling with a fake `claude` binary
   (so testing doesn't open a real session). Run at minimum:
   - `<being-name> resume foo` → expect `--dangerously-skip-permissions --resume foo`
   - `<being-name> continue` → expect `--dangerously-skip-permissions --continue`
   - `<being-name> "hello"` → expect `--dangerously-skip-permissions hello`

5. **Log** one line in `.beings/MEMORY.md` under a `## Tooling` section
   (create if absent): what was installed, where the symlink points,
   that `--dangerously-skip-permissions` is enabled and why (developer
   asked for it in bootstrap).

## The wrapper template

Replace `<name>` with the Being's name and `<workspace>` with the absolute path.

```bash
#!/usr/bin/env bash
# <name> — Claude Code session wrapper for the <name> Being.
#
# Always opens in <name>'s workspace so CLAUDE.md + .beings/ load.
# --dangerously-skip-permissions bypasses prompts — intentional.
#
# Usage:
#   <name>                    new session
#   <name> "quick question"   new session with prompt
#   <name> continue           resume most recent session
#   <name> resume             interactive session picker
#   <name> resume <#|id>      resume by number or session ID
#   <name> sessions [N]       list last N sessions (default 10)
#   <name> <any claude flag>  e.g. <name> --chrome, <name> --model opus

set -euo pipefail

WORKSPACE="<workspace>"
SESSION_DIR="$HOME/.claude/projects/$(echo '<workspace>' | sed 's|/|-|g' | sed 's|^-||')"

cd "$WORKSPACE"

_build_session_list() {
  _session_ids=()
  for f in $(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null); do
    local sid=$(basename "$f" .jsonl)
    [[ "$sid" == agent-* ]] && continue
    _session_ids+=("$sid")
  done
}

_list_sessions() {
  local limit=${1:-10}
  _build_session_list
  echo ""
  echo "  Recent <name> Sessions"
  echo "  ─────────────────────────────────────────────────────────────"
  printf "  %-4s %-22s %-22s %s\n" "#" "Session ID" "Date" "First Message"
  echo "  ─────────────────────────────────────────────────────────────"
  local i=1
  for sid in "${_session_ids[@]}"; do
    [[ $i -gt $limit ]] && break
    local f="$SESSION_DIR/$sid.jsonl"
    local first_msg=$(grep -m1 '"role":"user"' "$f" 2>/dev/null || true)
    local ts=$(echo "$first_msg" | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p' | cut -c1-19 | tr 'T' ' ')
    local msg=$(echo "$first_msg" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | cut -c1-55)
    [[ -z "$msg" ]] && msg="(complex message)"
    [[ -z "$ts"  ]] && ts="unknown"
    printf "  %-4s %-22s %-22s %s\n" "$i" "${sid:0:20}…" "$ts" "$msg"
    (( i++ ))
  done
  echo "  ─────────────────────────────────────────────────────────────"
  echo "  Resume: <name> resume <#>"
  echo "  Continue last: <name> continue"
  echo ""
}

_get_session_by_number() {
  _build_session_list
  local num=$1
  if [[ $num -ge 1 && $num -le ${#_session_ids[@]} ]]; then
    echo "${_session_ids[$((num-1))]}"
  fi
}

case "${1:-}" in
  sessions|ls|list)
    _list_sessions "${2:-10}"
    ;;
  continue|c)
    echo "  Resuming most recent <name> session…"
    exec claude --dangerously-skip-permissions --continue
    ;;
  resume|r)
    shift
    if [[ $# -eq 0 ]]; then
      exec claude --dangerously-skip-permissions --resume
    elif [[ "$1" =~ ^[0-9]+$ ]]; then
      local sid=$(_get_session_by_number "$1")
      if [[ -z "$sid" ]]; then
        echo "  No session at #$1. Run '<name> sessions' to list available sessions."
        exit 1
      fi
      exec claude --dangerously-skip-permissions --resume "$sid"
    else
      exec claude --dangerously-skip-permissions --resume "$@"
    fi
    ;;
  help|--help|-h)
    echo ""
    echo "  <name> — Claude Code session wrapper"
    echo "  Usage:"
    echo "    <name>                       new session"
    echo "    <name> continue (c)          resume most recent session"
    echo "    <name> resume (r) [#|id]     resume by number or session ID"
    echo "    <name> sessions (ls) [N]     list last N sessions (default 10)"
    echo "    <name> \"<prompt>\"            new session with initial prompt"
    echo "    <name> <any claude flag>     e.g. --chrome, --model opus"
    echo ""
    ;;
  "")
    exec claude --dangerously-skip-permissions
    ;;
  *)
    exec claude --dangerously-skip-permissions "$@"
    ;;
esac
```

## Trust note — say this out loud

`--dangerously-skip-permissions` means anything the Being does inside
a `<being-name>` session runs without asking. The developer asked for
this in bootstrap, so it's intentional — but the Being should
acknowledge it explicitly once when the wrapper is installed, not
bury the decision in a comment.

## Why "born through conversation" still holds

The protocol's philosophy is that a Being is named and shaped in its
first conversation, not at install time. This skill honors that —
the wrapper is only created *after* the Being has its name, by the
Being itself, during bootstrap. Nothing runs before the conversation.
