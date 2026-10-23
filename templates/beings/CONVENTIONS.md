# CONVENTIONS.md — Project Conventions

<!-- I'll document the project's code style and patterns
     as I discover them. -->

## Personas

Reusable expert personas live in `.beings/personas/`. Each is a markdown file defining:
- Name, role, and domain
- 5–10 review or decision lenses
- When to invoke

Example: `.beings/personas/cbo-varuna.md` — Chief Business Officer persona for
proposal review. Invoke by saying: "Wear your Varuna hat and review this proposal."

The Being loads the persona file on demand — not every session.

## App stacks

Every app the Being builds or runs locally gets its own runner and is registered, so starting and stopping is always a
deliberate step and one command can stop them all:

- One command per app (`~/.local/bin/<app>`): `up`, `down`, `status`, `restart`, `logs`, `open`; `destroy` removes
  containers, `reset` wipes data after a typed confirmation. `down` keeps data and works even when config is broken.
- Never at boot: after every `up` the runner sets Docker's restart policy to `no`. Only the Being's own services
  (its chat watcher, memory backup) start at boot, on purpose.
- `<APP>_HOME` picks the checkout or worktree; nothing points at one fixed folder.
- One runner per Docker compose project, registered in `~/.config/<being>/stacks.tsv`.
- Generate with `bin/<being> stack new <app>`; check with `bin/<being> stacks audit`.
