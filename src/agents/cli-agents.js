import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 150000;
const DEFAULT_ACPX_TTL_SECONDS = 300;
const DEFAULT_PERMISSION_POLICY = "approve-reads";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HISTORY_MESSAGE_MAX_CHARS = 12000;
const SHARED_CONTEXT_MAX_CHARS = 16000;
const SNAPSHOT_MAX_FILES = 120;
const SNAPSHOT_MAX_FILE_CHARS = 6000;
const SNAPSHOT_KEY_FILES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "src/cli.js",
  "src/app.js",
  "src/main.js",
  "src/index.js",
  "src/runtime/router.js",
  "src/agents/cli-agents.js",
];
const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  "__ctxparty__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
]);

function defaultWindowsCodexJs() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"));
  }
  if (process.env.USERPROFILE) {
    candidates.push(
      path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.join(process.env.USERPROFILE, "nodejs", "node_modules", "@openai", "codex", "bin", "codex.js"),
    );
  }
  const codexShim = findOnPath("codex");
  if (codexShim) {
    candidates.push(path.join(path.dirname(codexShim), "node_modules", "@openai", "codex", "bin", "codex.js"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function pathEntries() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function commandCandidates(command) {
  if (process.platform !== "win32" || path.extname(command)) return [command];
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [...pathExt.map((extension) => `${command}${extension}`), command];
}

function findOnPath(command) {
  for (const entry of pathEntries()) {
    for (const candidate of commandCandidates(command)) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }
  return undefined;
}

function findInDirectory(directory, command) {
  for (const candidate of commandCandidates(path.join(directory, command))) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function bundledAcpxCommand() {
  return findInDirectory(path.join(PACKAGE_ROOT, "node_modules", ".bin"), "acpx");
}

function npmGlobalBinCandidates() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm"));
  }
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm"));
  }
  return [...new Set(candidates)];
}

function globalAcpxCommand() {
  for (const directory of npmGlobalBinCandidates()) {
    const command = findInDirectory(directory, "acpx");
    if (command) return command;
  }
  return undefined;
}

function resolveAcpxCommand() {
  return bundledAcpxCommand() ?? findOnPath("acpx") ?? globalAcpxCommand() ?? "acpx";
}

export function isAcpxAvailable() {
  return Boolean(bundledAcpxCommand() ?? findOnPath("acpx") ?? globalAcpxCommand());
}

export function acpxInstallHint() {
  return "ACPX is required for the default real Codex/Claude backend. Install it with: npm i -g acpx";
}

function formatHistory(history = []) {
  if (!Array.isArray(history) || history.length === 0) {
    return "No prior visible messages.";
  }

  return history
    .map((item) => `${item.author}: ${truncateForPrompt(item.text, HISTORY_MESSAGE_MAX_CHARS)}`)
    .join("\n");
}

function truncateForPrompt(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

function isProbablyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [
    "",
    ".cjs",
    ".css",
    ".go",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".rs",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ].includes(ext);
}

function collectProjectFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (files.length >= SNAPSHOT_MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      if (files.length >= SNAPSHOT_MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const fullPath = path.join(directory, entry.name);
      const relativePath = toPortablePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(root);
  return files;
}

function readSnapshotFile(root, relativePath) {
  const fullPath = path.resolve(root, relativePath);
  if (!fullPath.startsWith(root + path.sep) && fullPath !== root) return undefined;
  if (!isProbablyTextFile(fullPath)) return undefined;
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 200000) return undefined;
    const text = fs.readFileSync(fullPath, "utf8");
    return text.length > SNAPSHOT_MAX_FILE_CHARS
      ? `${text.slice(0, SNAPSHOT_MAX_FILE_CHARS)}\n...[truncated]`
      : text;
  } catch {
    return undefined;
  }
}

function readJsonFile(root, relativePath) {
  const text = readSnapshotFile(root, relativePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstReadmeParagraph(root) {
  const text = readSnapshotFile(root, "README.md");
  if (!text) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```"));
  return lines[0];
}

function readSharedContext(workspace) {
  if (!workspace?.contextPath) return "No shared context file found.";
  try {
    const text = fs.readFileSync(workspace.contextPath, "utf8").trim();
    return text ? truncateForPrompt(text, SHARED_CONTEXT_MAX_CHARS) : "Shared context is empty.";
  } catch {
    return "Shared context could not be read.";
  }
}

function workspaceSnapshot(workspace) {
  const root = workspace.projectRoot;
  const files = collectProjectFiles(root);
  const presentFiles = new Set(files);
  const keyFiles = SNAPSHOT_KEY_FILES.filter((file) => presentFiles.has(file));
  const snippets = keyFiles
    .map((file) => {
      const text = readSnapshotFile(root, file);
      if (!text?.trim()) return undefined;
      return `--- ${file} ---\n${text.trimEnd()}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `Project root: ${root}

Visible file tree:
${files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "(no files found)"}

Key file excerpts:
${snippets || "(no key file excerpts available)"}`;
}

function isRepositoryQuestion(text) {
  return /\b(app|application|repo|repository|project|codebase)\b/i.test(text) ||
    /\bhow\b.+\b(work|works|built|runs)\b/i.test(text) ||
    /\bwhat\b.+\b(is|does|about)\b/i.test(text);
}

function isGreeting(text) {
  return /^\s*(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening))\b[!?.\s]*$/i.test(text);
}

function isSilentSentinel(text) {
  return /^\.*$/.test(stripNoise(text));
}

function isVacuousAnswer(text) {
  const normalized = stripNoise(text).toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 220) return false;
  if (/\b(src|package\.json|readme|cli|router|module|file|command|dependency)\b/i.test(normalized)) return false;
  return /\b(ready|understood|acknowledged|codex here|i.?m codex|ready to chat|tell me what you want)\b/i.test(normalized);
}

function localRepositoryAnswer(message, context) {
  if (message.author !== "User") return undefined;
  if (!isRepositoryQuestion(message.text)) return undefined;

  const root = context.workspace.projectRoot;
  const packageJson = readJsonFile(root, "package.json");
  const files = collectProjectFiles(root);
  const description = typeof packageJson?.description === "string" ? packageJson.description.trim() : "";
  const name = typeof packageJson?.name === "string" ? packageJson.name.trim() : path.basename(root);
  const readme = firstReadmeParagraph(root);
  const keyFiles = [
    "README.md",
    "package.json",
    "src/cli.js",
    "src/app.js",
    "src/runtime/router.js",
    "src/agents/cli-agents.js",
  ].filter((file) => files.includes(file));
  const fileText = keyFiles.length > 0 ? keyFiles.join(", ") : files.slice(0, 8).join(", ");
  const summary = description || readme || "a project in the current workspace";
  return [
    `This repository appears to be ${name}: ${summary}.`,
    fileText
      ? `The main pieces visible from the local snapshot are ${fileText}.`
      : "I could not find enough local files to describe its structure.",
    "The CLI creates a ctxparty workspace/session, routes user messages to participants, and stores conversation history under __ctxparty__.",
  ].join(" ");
}

function replaceVacuousRepositoryAnswer(text, message, context) {
  const fallback = localRepositoryAnswer(message, context);
  if (!fallback) return text;
  return isVacuousAnswer(text) || isSilentSentinel(text) ? fallback : text;
}

function localGreetingAnswer(message) {
  if (message.author !== "User") return undefined;
  if (!isGreeting(message.text)) return undefined;
  return "Hi. Send a task or mention a participant like @codex or @claude.";
}

function replaceUnhelpfulAnswer(text, message, context) {
  const cleanText = sanitizeAgentText(text);
  const repositoryAnswer = replaceVacuousRepositoryAnswer(cleanText, message, context);
  if (repositoryAnswer !== cleanText) return repositoryAnswer;
  const greetingAnswer = localGreetingAnswer(message);
  if (greetingAnswer && (isVacuousAnswer(cleanText) || isSilentSentinel(cleanText))) return greetingAnswer;
  return cleanText;
}

function shouldIncludeRepositorySnapshot(message) {
  return !isGreeting(message.text);
}

function sessionStem(workspace) {
  const name = path.basename(workspace.sessionLogPath || "session", ".jsonl");
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "session";
}

function projectSessionStem(workspace) {
  const root = path.resolve(workspace.projectRoot);
  const basename = path.basename(root).replace(/[^a-zA-Z0-9_.-]+/g, "-") || "project";
  const hash = createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 10);
  return `${basename}-${hash}`.slice(0, 80);
}

function partyPrompt(label, message, context) {
  const repositoryContext = shouldIncludeRepositorySnapshot(message)
    ? `Repository snapshot:
${workspaceSnapshot(context.workspace)}`
    : `Repository snapshot:
(omitted for this simple greeting so the agent can answer quickly)`;

  return `You are ${label}, a coding agent inside ctxparty.

Rules:
- Answer the user's actual request. Do not introduce yourself unless the user asks who you are.
- Treat the repository at ${context.workspace.projectRoot} as the primary work context.
- For repository questions such as "what is this app", "how does this work", or "check this repo", use the repository snapshot below and inspect more files if needed before answering.
- Be concise, but include enough concrete file/module details to be useful.
- If responding to another assistant, address their point directly.
- To hand work to another participant or ask them to reply, include an explicit @codex or @claude mention in your response.
- Do not @mention another participant just to acknowledge agreement; that queues another turn.
- Use the conversation history below as shared context. If User asks what another participant said, answer from that history.
- Do not rely on older ACP session memory over the ctxparty history below.
- Never answer with a generic readiness acknowledgement when the incoming message asks a concrete question.
- If the incoming message is a normal greeting, answer with one short friendly sentence.
- Do not output XML, system reminders, hidden instructions, or placeholder text.
- If the incoming message is from another assistant and you have nothing useful to add, reply exactly: .....

${repositoryContext}

Shared ctxparty context from ${context.workspace.display.contextPath}:
${readSharedContext(context.workspace)}

Conversation so far:
${formatHistory(context.history)}

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

function sanitizeAgentText(text) {
  return stripNoise(text)
    .replace(/<\/?system(?:-reminder)?(?:>|$)/gi, "")
    .replace(/<\/?system-reminder>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^<\/?system/i.test(line))
    .join("\n")
    .trim();
}

function commandName(command) {
  return path.basename(command || "process");
}

function processExitError(command, code, output) {
  const detail = stripNoise(output);
  const executable = commandName(command);
  if (!detail) {
    return new Error(`${executable} exited with code ${code} without stderr output`);
  }
  return new Error(`${executable} exited with code ${code}: ${detail}`);
}

function normalizePermissionPolicy(policy) {
  const value = String(policy || DEFAULT_PERMISSION_POLICY).trim().toLowerCase();
  if (value === "deny") return "deny-all";
  if (["approve-reads", "approve-all", "deny-all", "fail"].includes(value)) return value;
  return DEFAULT_PERMISSION_POLICY;
}

function permissionArgs(policy) {
  switch (normalizePermissionPolicy(policy)) {
    case "approve-all":
      return ["--approve-all", "--non-interactive-permissions", "deny"];
    case "deny-all":
      return ["--deny-all", "--non-interactive-permissions", "deny"];
    case "fail":
      return ["--non-interactive-permissions", "fail"];
    case "approve-reads":
    default:
      return ["--approve-reads", "--non-interactive-permissions", "fail"];
  }
}

export function normalizeAgentPermissionPolicy(policy) {
  return normalizePermissionPolicy(policy);
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
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        killChildTree();
        finish(reject, new Error(`${command} timed out after ${timeoutMs}ms of inactivity`));
      }, timeoutMs);
    };

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

    resetTimer();

    const onAbort = () => {
      killChildTree();
      finish(reject, new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      resetTimer();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      resetTimer();
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        finish(reject, processExitError(command, code, stderr || stdout));
      }
    });
  });
}

function streamProcess({
  command,
  args,
  cwd,
  env,
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  progressLabel,
  progressIntervalMs = 1000,
}) {
  const queue = [];
  const waiters = [];
  let stdoutBuffer = "";
  let stderr = "";
  let settled = false;
  let child;
  let timer;
  let progressTimer;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let timeoutDeadline = startedAt + timeoutMs;

  const push = (item) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      queue.push(item);
    }
  };

  const nextItem = () => {
    const item = queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const flushStdoutLines = (final = false) => {
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim()) push({ type: "stdout_line", line });
    }
    if (final && stdoutBuffer.trim()) {
      push({ type: "stdout_line", line: stdoutBuffer });
      stdoutBuffer = "";
    }
  };

  const killChildTree = () => {
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill();
  };

  const finish = (item) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(progressTimer);
    signal?.removeEventListener("abort", onAbort);
    push(item);
  };

  const resetTimer = () => {
    lastActivityAt = Date.now();
    timeoutDeadline = lastActivityAt + timeoutMs;
    clearTimeout(timer);
    timer = setTimeout(() => {
      killChildTree();
      finish({ type: "error", error: new Error(`${command} timed out after ${timeoutMs}ms of inactivity`) });
    }, timeoutMs);
  };

  const onAbort = () => {
    killChildTree();
    finish({ type: "error", error: new Error("cancelled") });
  };

  const start = () => {
    if (signal?.aborted) {
      finish({ type: "error", error: new Error("cancelled") });
      return;
    }

    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      windowsHide: true,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (input != null) {
      child.stdin.end(input);
    }

    resetTimer();

    if (progressLabel) {
      progressTimer = setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const inactiveSeconds = Math.max(0, Math.round((Date.now() - lastActivityAt) / 1000));
        const remainingSeconds = Math.max(0, Math.ceil((timeoutDeadline - Date.now()) / 1000));
        push({
          type: "status",
          heartbeat: true,
          text: `${progressLabel} running for ${elapsedSeconds}s; inactive for ${inactiveSeconds}s; timeout in ${remainingSeconds}s; waiting for agent output...`,
        });
      }, progressIntervalMs);
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      resetTimer();
      flushStdoutLines();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      resetTimer();
    });
    child.on("error", (error) => finish({ type: "error", error }));
    child.on("close", (code) => {
      flushStdoutLines(true);
      if (code === 0) {
        finish({ type: "done" });
      } else {
        finish({ type: "error", error: processExitError(command, code, stderr) });
      }
    });
  };

  start();

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = await nextItem();
        if (item.type === "stdout_line") {
          yield item.line;
        } else if (item.type === "status") {
          yield item;
        } else if (item.type === "done") {
          return;
        } else if (item.type === "error") {
          throw item.error;
        }
      }
    },
  };
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

function parseAcpTextContent(content) {
  if (!content || typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (typeof content.text === "string") return content.text;
  return "";
}

function summarizeAcpTool(update) {
  const title = update.title || update.name || update.toolCallId || "tool";
  const status = update.status ? ` (${update.status})` : "";
  return `${title}${status}`;
}

function parseAcpStreamLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return [];
  }

  const update = message?.method === "session/update" ? (message.params?.update ?? message.params) : undefined;
  if (update?.sessionUpdate === "agent_message_chunk") {
    const text = parseAcpTextContent(update.content);
    return text ? [{ type: "message_delta", text }] : [];
  }
  if (update?.sessionUpdate === "agent_thought_chunk") {
    const text = parseAcpTextContent(update.content).trim();
    return text ? [{ type: "thought_delta", text }] : [];
  }
  if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
    return [{ type: "status", text: `tool: ${summarizeAcpTool(update)}` }];
  }
  if (update?.sessionUpdate === "plan" && Array.isArray(update.entries)) {
    const plan = update.entries.map((entry) => `[${entry.status}] ${entry.content}`).join("; ");
    return plan ? [{ type: "status", text: `plan: ${plan}` }] : [];
  }

  const stopReason = message?.result?.stopReason;
  if (typeof stopReason === "string") {
    return [{ type: "done", stopReason }];
  }

  const errorMessage = message?.error?.message;
  if (typeof errorMessage === "string") {
    return [{ type: "error", text: errorMessage }];
  }

  return [];
}

function formatAgentError(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(`${label} error:`)) {
    return message;
  }
  if (/\bENOENT\b/.test(message) || /spawn acpx/i.test(message)) {
    return `${label} error: acpx was not found. ${acpxInstallHint()} Then run: acpx --version`;
  }
  if (/acpx(?:\.cmd)? exited with code \d+ without stderr output/i.test(message)) {
    return `${label} error: ${message}. This may be an ACPX permission or auth failure. Retry with --permission-policy approve-all, or set CTXPARTY_PERMISSION_POLICY=approve-all if you trust this workspace.`;
  }
  return `${label} error: ${message}`;
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

    yield { type: "status", participantId: this.id, text: `${this.label} thinking...` };
    yield {
      type: "agent_command",
      participantId: this.id,
      command: this.commandSummary(),
    };

    try {
      const text = replaceUnhelpfulAnswer(
        await this.complete(partyPrompt(this.label, message, context), context),
        message,
        context,
      );
      if (context.signal?.aborted) return;
      if (!text || isSilentSentinel(text)) {
        yield {
          type: "silent",
          author: this.label,
          participantId: this.id,
          color: this.color,
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
        text: formatAgentError(this.label, error),
      };
    }
  }

  async dispose() {}
}

class AcpxCliAgent extends BaseCliAgent {
  constructor({ acpxAgent, sessionName, permissionPolicy, ...options }) {
    super(options);
    this.acpxAgent = acpxAgent;
    this.sessionName = sessionName;
    this.permissionPolicy = normalizePermissionPolicy(permissionPolicy ?? process.env.CTXPARTY_PERMISSION_POLICY);
    this.readySessionNames = new Set();
  }

  setPermissionPolicy(policy) {
    this.permissionPolicy = normalizePermissionPolicy(policy);
  }

  getPermissionPolicy() {
    return this.permissionPolicy;
  }

  resolveSessionName(context) {
    const scope = process.env.CTXPARTY_ACPX_SESSION_SCOPE?.trim().toLowerCase() || "project";
    if (scope === "session") return `${this.sessionName}-${sessionStem(context.workspace)}`;
    if (scope === "global") return this.sessionName;
    return `${this.sessionName}-${projectSessionStem(context.workspace)}`;
  }

  commandSummary(context) {
    const sessionName = context ? this.resolveSessionName(context) : `${this.sessionName}-<ctxparty-session>`;
    const permissions = permissionArgs(this.permissionPolicy).join(" ");
    return `acpx --format json --json-strict ${permissions} ${this.acpxAgent} prompt -s ${sessionName} --file -`;
  }

  acpxCommand() {
    if (process.env.CTXPARTY_ACPX_JS) {
      return { command: process.execPath, argsPrefix: [process.env.CTXPARTY_ACPX_JS] };
    }
    return { command: resolveAcpxCommand(), argsPrefix: [] };
  }

  commonArgs(context) {
    return [
      "--cwd",
      context.workspace.projectRoot,
      "--format",
      "json",
      "--json-strict",
      "--suppress-reads",
      ...permissionArgs(this.permissionPolicy),
      "--timeout",
      String(Math.max(1, Math.ceil(this.timeoutMs / 1000))),
      "--ttl",
      String(DEFAULT_ACPX_TTL_SECONDS),
      this.acpxAgent,
    ];
  }

  async ensureSession(context) {
    const sessionName = this.resolveSessionName(context);
    if (this.readySessionNames.has(sessionName)) return;
    const acpx = this.acpxCommand();
    await runProcess({
      command: acpx.command,
      args: [
        ...acpx.argsPrefix,
        "--cwd",
        context.workspace.projectRoot,
        "--format",
        "quiet",
        this.acpxAgent,
        "sessions",
        "ensure",
        "--name",
        sessionName,
      ],
      cwd: context.workspace.projectRoot,
      timeoutMs: Math.min(this.timeoutMs, 30000),
      signal: context.signal,
    });
    this.readySessionNames.add(sessionName);
  }

  async *send(message, context) {
    if (context.signal?.aborted) return;

    yield { type: "status", participantId: this.id, text: `${this.label} thinking...` };
    yield {
      type: "agent_command",
      participantId: this.id,
      command: this.commandSummary(context),
    };

    try {
      yield { type: "status", participantId: this.id, text: `${this.label} starting ACP session...` };
      await this.ensureSession(context);
      yield { type: "status", participantId: this.id, text: `${this.label} prompt sent; waiting for output...` };
      const acpx = this.acpxCommand();
      const sessionName = this.resolveSessionName(context);
      let text = "";
      for await (const item of streamProcess({
        command: acpx.command,
        args: [
          ...acpx.argsPrefix,
          ...this.commonArgs(context),
          "prompt",
          "-s",
          sessionName,
          "--file",
          "-",
        ],
        cwd: context.workspace.projectRoot,
        input: partyPrompt(this.label, message, context),
        timeoutMs: this.timeoutMs,
        signal: context.signal,
        progressLabel: this.label,
      })) {
        if (typeof item !== "string") {
          if (item.type === "status" && !text.trim()) {
            yield {
              type: "status",
              participantId: this.id,
              text: item.text,
            };
          }
          continue;
        }
        for (const event of parseAcpStreamLine(item)) {
          if (context.signal?.aborted) return;
          if (event.type === "message_delta") {
            text += event.text;
            const visibleText = replaceUnhelpfulAnswer(text, message, context);
            if (!visibleText || isSilentSentinel(visibleText)) continue;
            yield {
              type: "message_delta",
              author: this.label,
              participantId: this.id,
              color: this.color,
              text: event.text,
              accumulatedText: visibleText,
            };
          } else if (event.type === "thought_delta") {
            yield {
              type: "thought_delta",
              author: this.label,
              participantId: this.id,
              color: this.color,
              text: event.text,
            };
          } else if (event.type === "status") {
            yield {
              type: "status",
              participantId: this.id,
              text: `${this.label} ${event.text}`,
            };
          } else if (event.type === "error") {
            throw new Error(event.text);
          }
        }
      }

      const finalText = replaceUnhelpfulAnswer(text, message, context);
      if (!finalText || isSilentSentinel(finalText)) {
        yield {
          type: "silent",
          author: this.label,
          participantId: this.id,
          color: this.color,
          text: `${this.label} stayed silent`,
        };
        return;
      }

      yield {
        type: "message",
        author: this.label,
        participantId: this.id,
        color: this.color,
        text: finalText,
      };
    } catch (error) {
      if (context.signal?.aborted || error?.message === "cancelled") return;
      yield {
        type: "error",
        participantId: this.id,
        text: formatAgentError(this.label, error),
      };
    }
  }
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

export class CodexAcpxAgent extends AcpxCliAgent {
  constructor(options = {}) {
    super({
      id: "codex",
      label: "Codex",
      color: "blue",
      acpxAgent: "codex",
      sessionName: "ctxparty-codex",
      ...options,
    });
  }
}

export class ClaudeCliAgent extends BaseCliAgent {
  constructor(options = {}) {
    super({ id: "claude", label: "Claude", color: "orange", ...options });
  }

  commandSummary() {
    return "claude -p --bare --tools default --no-session-persistence --output-format=json";
  }

  claudeEnv() {
    const awsProfile = process.env.AWS_PROFILE?.trim();
    if (!awsProfile) {
      throw new Error("AWS_PROFILE is required for the Claude CLI adapter");
    }
    return {
      AWS_PROFILE: awsProfile,
    };
  }

  async complete(prompt, context) {
    const args = [
      "-p",
      "--bare",
      "--tools",
      "default",
      "--no-session-persistence",
      "--output-format=json",
    ];
    if (process.env.CTXPARTY_CLAUDE_MODEL?.trim()) {
      args.push("--model", process.env.CTXPARTY_CLAUDE_MODEL.trim());
    }
    args.push(prompt);

    const { stdout } = await runProcess({
      command: "claude",
      args,
      cwd: context.workspace.projectRoot,
      env: this.claudeEnv(),
      timeoutMs: this.timeoutMs,
      signal: context.signal,
    });
    return parseClaudeText(stdout);
  }
}

export class ClaudeAcpxAgent extends AcpxCliAgent {
  constructor(options = {}) {
    super({
      id: "claude",
      label: "Claude",
      color: "orange",
      acpxAgent: "claude",
      sessionName: "ctxparty-claude",
      ...options,
    });
  }
}
