#!/usr/bin/env node
const VERSION = "0.1.1";
const MIN_NODE_VERSION = [18, 18, 1];

function isSupportedNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const actual = [major, minor, patch];
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (actual[index] > MIN_NODE_VERSION[index]) return true;
    if (actual[index] < MIN_NODE_VERSION[index]) return false;
  }
  return true;
}

function printHelp() {
  console.log(`Context Party ${VERSION}

Usage:
  ctxparty [options]

Options:
  --once <message>       Run one party turn and exit.
  --demo-real            Run a short real Codex/Claude exchange and exit.
  --participants <mode>  Participant adapters: "real" or "mock". Default: real.
  --cwd <path>           Project directory where __ctxparty__/ is created.
  --resume [session]     Resume latest session, or the named/path JSONL session.
  --max-turns <number>   Maximum routed messages per user submission. Default: 8.
  --agent-timeout-ms <n> Timeout per participant call. Default: 150000.
  --permission-policy <p> ACPX permissions: approve-reads, approve-all, deny, or fail.
                         Default: CTXPARTY_PERMISSION_POLICY or approve-reads.
  --no-color             Disable ANSI colors.
  --help                 Show this help.
  --version              Show version.

Interactive commands:
  /help                  Show commands.
  /agents                List participants.
  @codex / @claude       Mention a participant for a direct reply only.
  message without @      Ask all participants once.
  @all                   Ask all participants explicitly.
  /mute <participant>    Mute a participant.
  /unmute <participant>  Unmute a participant.
  /permissions [policy]  Show or set ACPX permission policy.
  /workspace             Show workspace paths.
  /history               Replay visible message history.
  /resume [session]      Show resumable sessions, or resume one by number/name/path.
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
    participants: "real",
    resume: false,
    agentTimeoutMs: 150000,
    permissionPolicy: process.env.CTXPARTY_PERMISSION_POLICY || "approve-reads",
    permissionPolicySource: process.env.CTXPARTY_PERMISSION_POLICY ? "env" : "default",
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
    } else if (arg === "--resume") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        parsed.resume = true;
      } else {
        parsed.resume = value;
        index += 1;
      }
    } else if (arg === "--agent-timeout-ms") {
      const value = Number.parseInt(readValue(index, arg), 10);
      index += 1;
      if (!Number.isFinite(value) || value < 1000) {
        throw new Error("--agent-timeout-ms must be an integer >= 1000");
      }
      parsed.agentTimeoutMs = value;
    } else if (arg === "--permission-policy") {
      const value = readValue(index, arg);
      index += 1;
      if (!["approve-reads", "approve-all", "deny", "deny-all", "fail"].includes(value)) {
        throw new Error('--permission-policy must be "approve-reads", "approve-all", "deny", or "fail"');
      }
      parsed.permissionPolicy = value;
      parsed.permissionPolicySource = "cli";
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
    if (!isSupportedNodeVersion(process.versions.node)) {
      throw new Error(`Node.js >=${MIN_NODE_VERSION.join(".")} is required; current Node.js is ${process.versions.node}`);
    }
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
