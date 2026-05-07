# ctxparty

Context Party is a terminal workspace for coordinating multiple coding agents in one shared project session.

It uses Pi's `@mariozechner/pi-tui` package for the interactive terminal UI, while keeping the runtime small and dependency-light. The current app:

- creates a `__ctxparty__/` party workspace;
- writes `context.md`, `files/`, `logs/`, and structured JSONL sessions;
- starts an interactive terminal session;
- routes user messages through real CLI-backed `Codex` and `Claude` participants by default;
- sends unmentioned user messages to all participants once, and sends `@` mentions only to the requested participant(s);
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
- message without `@` to ask all participants once
- `@codex`, `@claude`, or `@all` in a message to request direct replies only
- `/mute <participant>`
- `/unmute <participant>`
- `/permissions` to select the ACPX permission policy; `/permissions approve-all` to let agents proceed without prompts
- `/workspace`
- `/history`
- `/resume` to show resumable sessions; `/resume <number|name|path>` to switch sessions
- `/clear`
- `/quit`

## Current Boundary

The visible assistant is a **Participant**. The implementation behind it is an **Agent Adapter**. By default, ctxparty uses `acpx` as the real agent backend for Codex and Claude, so agent traffic uses ACP sessions, structured streaming updates, queue-aware prompts, and cooperative cancellation instead of raw terminal scraping. ctxparty installs `acpx` as an optional dependency on Node versions that support it, and also falls back to an existing global `acpx` binary when present. Set `CTXPARTY_AGENT_BACKEND=raw` to use the legacy direct Codex/Claude CLI adapters. Mock adapters remain available with `--participants mock` for local smoke testing without external subscriptions.

The Pi TUI bridge lives in `src/pi-tui.js`; the rest of the app imports from that bridge rather than importing `@mariozechner/pi-tui` directly.

Real adapters live in `src/agents/cli-agents.js`. The acpx backend runs `acpx --format json --json-strict <agent> prompt -s <ctxparty-session> --file -` and streams ACP `agent_thought_chunk`, `tool_call`, and `agent_message_chunk` updates into the ctxparty UI. Some ACP adapters do not emit visible thought chunks for every model; ctxparty displays them when ACPX sends them and otherwise shows live elapsed progress while waiting for first output. ACPX sessions are scoped per project by default so agent backends can stay warm across ctxparty restarts. Set `CTXPARTY_ACPX_SESSION_SCOPE=session` to isolate ACPX sessions per ctxparty transcript, or `CTXPARTY_ACPX_SESSION_SCOPE=global` to use one global session name per agent. Set `CTXPARTY_PERMISSION_POLICY=approve-all` or start with `--permission-policy approve-all` when you trust the workspace and want ACPX permission requests approved automatically; the default is `approve-reads`. The raw fallback runs Codex through `codex exec --json` and Claude through lean print mode with `--bare`, default tools, no session persistence, and JSON output.
