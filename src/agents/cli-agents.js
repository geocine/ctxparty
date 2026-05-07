import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 150000;

function defaultWindowsCodexJs() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;
  return path.join(userProfile, "nodejs", "node_modules", "@openai", "codex", "bin", "codex.js");
}

function partyPrompt(label, message) {
  return `You are ${label} inside ctxparty, a short terminal group chat with User, Codex, and Claude.

Rules:
- Reply in 1-2 short sentences.
- If responding to another assistant, address their point directly.
- Do not use tools.
- If you have nothing useful to add, reply exactly: .....

Incoming message:
${message.author}: ${message.text}`;
}

function stripNoise(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function runProcess({ command, args, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };

    const killChildTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
      }
      child.kill();
    };

    const timer = setTimeout(() => {
      killChildTree();
      finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      killChildTree();
      finish(reject, new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        finish(reject, new Error(`${command} exited with ${code}: ${stripNoise(stderr || stdout)}`));
      }
    });
  });
}

function parseCodexText(stdout) {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed") {
        const item = event.item ?? {};
        if (item.type === "agent_message" || item.type === "message") {
          finalText = item.text ?? finalText;
        }
      }
    } catch {
      // Ignore non-JSON status lines emitted by the CLI.
    }
  }
  return stripNoise(finalText);
}

function parseClaudeText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const result = [...events].reverse().find((event) => event.type === "result" && typeof event.result === "string");
    if (result?.result) return stripNoise(result.result);

    for (const event of [...events].reverse()) {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      if (text.trim()) return stripNoise(text);
    }
  } catch {
    return stripNoise(trimmed);
  }

  return "";
}

class BaseCliAgent {
  constructor({ id, label, color, timeoutMs }) {
    this.id = id;
    this.label = label;
    this.color = color;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async *send(message, context) {
    if (context.signal?.aborted) return;

    yield { type: "status", text: `${this.label} thinking...` };
    yield {
      type: "agent_command",
      participantId: this.id,
      command: this.commandSummary(),
    };

    try {
      const text = await this.complete(partyPrompt(this.label, message), context);
      if (context.signal?.aborted) return;
      if (!text || text === ".....") {
        yield {
          type: "silent",
          participantId: this.id,
          text: `${this.label} stayed silent`,
        };
        return;
      }
      yield {
        type: "message",
        author: this.label,
        participantId: this.id,
        color: this.color,
        text,
      };
    } catch (error) {
      if (context.signal?.aborted || error?.message === "cancelled") return;
      yield {
        type: "error",
        participantId: this.id,
        text: `${this.label} error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async dispose() {}
}

export class CodexCliAgent extends BaseCliAgent {
  constructor(options = {}) {
    super({ id: "codex", label: "Codex", color: "blue", ...options });
  }

  commandSummary() {
    return "codex exec --json --skip-git-repo-check";
  }

  codexProcess() {
    if (process.env.CTXPARTY_CODEX_JS) {
      return { command: process.execPath, argsPrefix: [process.env.CTXPARTY_CODEX_JS] };
    }
    const windowsCodexJs = defaultWindowsCodexJs();
    if (process.platform === "win32" && windowsCodexJs && fs.existsSync(windowsCodexJs)) {
      return { command: process.execPath, argsPrefix: [windowsCodexJs] };
    }
    return { command: "codex", argsPrefix: [] };
  }

  async complete(prompt, context) {
    const codex = this.codexProcess();
    const { stdout } = await runProcess({
      command: codex.command,
      args: [...codex.argsPrefix, "exec", "--json", "--skip-git-repo-check", prompt],
      cwd: context.workspace.projectRoot,
      timeoutMs: this.timeoutMs,
      signal: context.signal,
    });
    return parseCodexText(stdout);
  }
}

export class ClaudeCliAgent extends BaseCliAgent {
  constructor(options = {}) {
    super({ id: "claude", label: "Claude", color: "orange", ...options });
  }

  commandSummary() {
    return "claude -p --bare --tools \"\" --no-session-persistence --model qwen36-27b --output-format=json";
  }

  claudeEnv() {
    const requiredToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!requiredToken) {
      throw new Error("ANTHROPIC_AUTH_TOKEN is required for the Claude CLI adapter");
    }
    return {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "http://136.61.33.107:42950",
      ANTHROPIC_AUTH_TOKEN: requiredToken,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "qwen36-27b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "qwen36-27b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "qwen36-27b",
    };
  }

  async complete(prompt, context) {
    const { stdout } = await runProcess({
      command: "claude",
      args: [
        "-p",
        "--bare",
        "--tools",
        "",
        "--no-session-persistence",
        "--model",
        "qwen36-27b",
        "--output-format=json",
        prompt,
      ],
      cwd: context.workspace.projectRoot,
      env: this.claudeEnv(),
      timeoutMs: this.timeoutMs,
      signal: context.signal,
    });
    return parseClaudeText(stdout);
  }
}
