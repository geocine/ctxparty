#!/usr/bin/env node
const VERSION = "0.1.0";

function printHelp() {
  console.log(`Context Party ${VERSION}

Usage:
  ctxparty [options]

Options:
  --once <message>       Run one party turn and exit.
  --demo-real            Run a short real Codex/Claude exchange and exit.
  --participants <mode>  Participant adapters: "mock" or "real". Default: mock.
  --cwd <path>           Project directory where __ctxparty__/ is created.
  --max-turns <number>   Maximum routed messages per user submission. Default: 8.
  --agent-timeout-ms <n> Timeout per participant call. Default: 150000.
  --no-color             Disable ANSI colors.
  --help                 Show this help.
  --version              Show version.

Interactive commands:
  /help                  Show commands.
  /agents                List participants.
  @codex / @claude       Mention a participant for a direct reply only.
  @all                   Ask all participants once without follow-up routing.
  /mute <participant>    Mute a participant.
  /unmute <participant>  Unmute a participant.
  /workspace             Show workspace paths.
  /history               Replay visible message history.
  /clear                 Clear the screen.
  /quit                  Exit.
`);
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    maxTurns: 8,
    color: true,
    once: undefined,
    participants: "mock",
    agentTimeoutMs: 150000,
  };

  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--no-color") {
      parsed.color = false;
    } else if (arg === "--once") {
      parsed.once = readValue(index, arg);
      index += 1;
    } else if (arg === "--demo-real") {
      parsed.participants = "real";
      parsed.maxTurns = 2;
      parsed.once =
        "Quick kickoff: Codex, suggest the smallest next implementation step. Claude, respond with one short risk or refinement. Keep it brief.";
    } else if (arg === "--participants") {
      const value = readValue(index, arg);
      index += 1;
      if (value !== "mock" && value !== "real") {
        throw new Error('--participants must be "mock" or "real"');
      }
      parsed.participants = value;
    } else if (arg === "--cwd") {
      parsed.cwd = readValue(index, arg);
      index += 1;
    } else if (arg === "--agent-timeout-ms") {
      const value = Number.parseInt(readValue(index, arg), 10);
      index += 1;
      if (!Number.isFinite(value) || value < 1000) {
        throw new Error("--agent-timeout-ms must be an integer >= 1000");
      }
      parsed.agentTimeoutMs = value;
    } else if (arg === "--max-turns") {
      const value = Number.parseInt(readValue(index, arg), 10);
      index += 1;
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--max-turns must be a positive integer");
      }
      parsed.maxTurns = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (options.version) {
      console.log(VERSION);
      return;
    }
    const { runCtxparty } = await import("./app.js");
    await runCtxparty(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ctxparty: ${message}`);
    process.exitCode = 1;
  }
}

main();
