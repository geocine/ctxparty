# ctxparty

Context Party is a terminal workspace for coordinating multiple coding agents in one shared project session.

It uses Pi's `@mariozechner/pi-tui` package for the interactive terminal UI, while keeping the runtime small and dependency-light. The current app:

- creates a `__ctxparty__/` party workspace;
- writes `context.md`, `files/`, `logs/`, and structured JSONL sessions;
- starts an interactive terminal session;
- routes user messages through real CLI-backed `Codex` and `Claude` participants by default;
- supports bounded participant-to-participant routing;
- supports core slash commands.

Chat colors are intentionally simple: User and the title are green, Codex is blue, Claude is orange, and status/editor chrome is gray.

## Install

ctxparty supports Node.js 18.18.1 or newer.
On Node 18, npm may warn that `@mariozechner/pi-tui` declares Node 20; ctxparty patches the installed TUI bundle during `postinstall` for Node 18 compatibility.

Install ctxparty globally:

```bash
npm i -g ctxparty
```

From a local checkout, install the current package globally:

```bash
npm i -g
```

After installation, run it from any project directory:

```bash
ctxparty
```

Run against another project directory:

```bash
ctxparty --cwd /path/to/project
```

Run a single prompt and exit:

```bash
ctxparty --once "review this project shape"
```

Resume the latest session in a project:

```bash
ctxparty --resume
```

Resume a specific session file:

```bash
ctxparty --resume __ctxparty__/sessions/2026-05-07T050444-392Z.jsonl
```

Run one real adapter-backed prompt:

```bash
ctxparty --max-turns 2 --once "Keep this short and discuss one next step."
```

Run with mock participants for local smoke testing:

```bash
ctxparty --participants mock --once "review this project shape"
```

## Development

Run from the checkout:

```bash
npm start
```

One-shot smoke run:

```bash
npm run smoke
```

## Commands

- `/help`
- `/agents`
- `@codex`, `@claude`, or `@all` in a message to request direct replies without follow-up routing
- `/mute <participant>`
- `/unmute <participant>`
- `/workspace`
- `/history`
- `/resume` to show resumable sessions; `/resume <number|name|path>` to switch sessions
- `/clear`
- `/quit`

## Current Boundary

The visible assistant is a **Participant**. The implementation behind it is an **Agent Adapter**. By default, ctxparty uses real CLI adapters for Codex and Claude with repository inspection tools enabled. Those CLIs must be installed, on `PATH`, and authenticated. The Claude adapter expects Bedrock-backed auth through `AWS_PROFILE` and uses the Claude CLI's configured default model unless `CTXPARTY_CLAUDE_MODEL` is set. Mock adapters remain available with `--participants mock` for local smoke testing without external subscriptions.

The Pi TUI bridge lives in `src/pi-tui.js`; the rest of the app imports from that bridge rather than importing `@mariozechner/pi-tui` directly.

Real adapters live in `src/agents/cli-agents.js`. Codex runs through `codex exec --json`; Claude runs through lean print mode with `--bare`, default tools, no session persistence, and JSON output.
