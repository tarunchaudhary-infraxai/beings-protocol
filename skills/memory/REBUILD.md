# Rebuild Memory — Re-index from Markdown Source

With basic-memory, "rebuild" is dramatically simpler than it was with MegaMemory. The markdown files in `memory-graph/` ARE the source of truth. Rebuilding just means reindexing them.

## One-command rebuild

```bash
basic-memory sync
```

That's it. basic-memory walks `memory-graph/`, parses every markdown file, and rebuilds the SQLite index at `~/.basic-memory/memory.db`.

For live reindexing (recommended for long-running Beings):

```bash
basic-memory sync --watch
```

This starts a daemon that watches `memory-graph/` via fsevents/inotify and reindexes any file change in milliseconds.

## When to rebuild

### New machine
First install on a fresh machine. No `~/.basic-memory/memory.db` yet. Install basic-memory, register the project, and run `basic-memory sync`. Your committed `memory-graph/` markdown files populate the index.

### After `git pull`
If the watch daemon is running, external file changes (from `git pull`, from Obsidian, from manual edits) are picked up automatically within milliseconds. If the daemon isn't running, run `basic-memory sync` once to catch up.

### Cache corruption
If `~/.basic-memory/memory.db` is corrupted or lost, delete it and re-run `basic-memory sync`. The markdown files in `memory-graph/` are untouched — the index rebuilds from them.

### Bulk external changes
If you ran a script that wrote many markdown files, or you did a big manual edit session outside the running daemon, `basic-memory sync` forces a full reconciliation.

## User-triggered rebuild

If you ask your Being to "rebuild your memory," it should:

1. Check the watch daemon is running (`cat ~/.basic-memory/watch-status.json`)
2. If not running, start it: `basic-memory sync --watch &`
3. Force a one-shot sync: `basic-memory sync`
4. Verify via `basic-memory tool recent-activity` or `search_notes`

## Seeding memory from identity files

When starting on a fresh machine with no `memory-graph/` content yet, the Being can seed its memory by walking existing identity/memory files and writing them as notes:

```
User: "Seed your memory from my identity files"
Being: 
  1. Reads .beings/MEMORY.md, TOOLS.md, CONVENTIONS.md, GOALS.md, AUTONOMY.md, IDENTITY.md, HUB.md
  2. For each, calls write_note with a clean title and appropriate folder:
     - identity/nova.md
     - org/example-org.md
     - products/docforge-skill.md
     - team/roster.md
     - patterns/communication-conventions.md
     - decisions/memory-backend-choice.md
  3. Uses [[wikilinks]] to create relations between concepts
  4. Reports what was seeded
```

This is a one-time bootstrap. After it, ongoing sessions use hooks (PreCompact/Stop) to grow the graph organically.

## Safety

- **Never delete `memory-graph/`** without a git commit first — that's the source of truth
- **Never hand-edit `~/.basic-memory/memory.db`** — it's a derived index, edit the markdown instead
- **Identity files stay in `.beings/`** — don't move them into `memory-graph/`. They're loaded every session; `memory-graph/` is queried on demand
