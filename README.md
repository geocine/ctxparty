# ctxparty

Context Party is a terminal workspace for coordinating multiple coding agents in one shared project session.

It uses a vendored copy of Pi's `@mariozechner/pi-tui` package for the interactive terminal UI, while keeping the runtime small and dependency-light. The current app:

- creates a `__ctxparty__/` party workspace;
- writes `context.md`, `files/`, `logs/`, and structured JSONL sessions;
- starts an interactive terminal session;
- routes user messages through mock `Codex` and `Claude` participants;
- supports bounded participant-to-participant routing;
- supports core slash commands.

Chat colors are intentionally simple: User and the title are green, Codex is blue, Claude is orange, and status/editor chrome is gray.

## Run

Run ctxparty:

```bash
npm start
```

One-shot smoke run:

```bash
npm run smoke
```

Run against another project directory:

```bash
node src/cli.js --cwd /path/to/project
```

Run a single prompt and exit:

```bash
node src/cli.js --once "review this project shape"
```

Run one real adapter-backed prompt:

```bash
node src/cli.js --participants real --max-turns 2 --once "Keep this short and discuss one next step."
```

## Commands

- `/help`
- `/agents`
- `@codex`, `@claude`, or `@all` in a message to request direct replies without follow-up routing
- `/mute <participant>`
- `/unmute <participant>`
- `/workspace`
- `/history`
- `/clear`
- `/quit`

## Current Boundary

The visible assistant is a **Participant**. The implementation behind it is an **Agent Adapter**. The first adapters are mocks so the router, workspace, commands, and session log can run without external subscriptions or unsafe CLI bypass flags.

The Pi TUI bridge lives in `src/pi-tui.js`; the rest of the app imports from that bridge rather than from the external checkout directly. The vendored TUI files live under `vendor/pi-tui/`.

Real adapters live in `src/agents/cli-agents.js`. Codex runs through `codex exec --json`; Claude runs through lean print mode with `--bare`, no tools, no session persistence, and JSON output.
