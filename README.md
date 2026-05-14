# ctxparty

Terminal workspace for coordinating Codex and Claude in one shared project session.

ctxparty creates a `__ctxparty__/` directory with:

- `context.md` for durable shared context passed to agents
- `settings.json` for project-local settings such as ACPX permissions
- `sessions/*.jsonl` for resumable transcripts
- `logs/` and `files/` for run output and shared artifacts

## Install

Requirements:

- Node.js 18.18.1 or newer
- ACPX for the default real-agent backend
- The agent CLIs you want to use, such as `codex` and/or `claude`, already authenticated

Install:

```bash
npm i -g ctxparty
npm i -g acpx
acpx --version
```

From a local checkout:

```bash
npm i -g
npm i -g acpx
```

On Node 18, npm may warn that `@mariozechner/pi-tui` declares Node 20; ctxparty patches the installed TUI bundle during `postinstall`.

## Use

Start in the current project:

```bash
ctxparty
```

Start in another project:

```bash
ctxparty --cwd /path/to/project
```

Run one prompt and exit:

```bash
ctxparty --once "review this project shape"
```

Resume the latest session:

```bash
ctxparty --resume
```

Resume a specific session:

```bash
ctxparty --resume __ctxparty__/sessions/2026-05-07T050444-392Z.jsonl
```

Run without real agents for smoke testing:

```bash
ctxparty --participants mock --once "review this project shape"
```

## Commands

- `/help` show commands
- `/agents` list participants
- `/permissions` choose ACPX permission policy
- `/permissions approve-all` persist approve-all for this project directory
- `/reset-agent codex` or `/reset-agent claude` close and recreate a stuck ACPX session
- `/workspace` show ctxparty paths
- `/history` replay visible history
- `/resume` choose a session
- `/resume <number|name|path>` resume a specific session
- `/mute <participant>` and `/unmute <participant>`
- `/clear`
- `/quit`

Mention `@codex`, `@claude`, or `@all` to target participants. A message without a mention asks all active participants once.

## ACPX

ctxparty uses ACPX by default for Codex and Claude so it can stream structured agent output, tool calls, permission requests, and cancellation.

If `acpx` is missing, install it:

```bash
npm i -g acpx
acpx --version
```

Permission policy defaults to `approve-reads`. Use `/permissions approve-all` when you trust the project directory and want ACPX permission requests approved automatically. The setting is saved in `__ctxparty__/settings.json`.

ACPX sessions are scoped per ctxparty transcript by default to avoid carrying oversized or polluted agent state into later sessions. Set `CTXPARTY_ACPX_SESSION_SCOPE=project` to reuse one warm session per project, or `CTXPARTY_ACPX_SESSION_SCOPE=global` to reuse one session per agent.

Agent calls default to a 30 minute timeout. Long builds or packaging jobs can exceed that; use `--agent-timeout-ms <milliseconds>` to raise the limit for those sessions.

As a fallback, set `CTXPARTY_AGENT_BACKEND=raw` to use the older direct Codex/Claude CLI adapters without ACPX.

## Development

```bash
npm start
npm run smoke
npm run check
```
