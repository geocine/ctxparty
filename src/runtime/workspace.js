import fs from "node:fs";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toDisplayPath(target, base) {
  const relative = path.relative(base, target) || ".";
  const safeRelative = path.isAbsolute(relative) ? path.basename(target) : relative;
  return safeRelative.split(path.sep).join("/");
}

export function createWorkspace(cwd) {
  const projectRoot = path.resolve(cwd);
  const launchRoot = process.cwd();
  ensureDir(projectRoot);

  const root = path.join(projectRoot, "__ctxparty__");
  const filesDir = path.join(root, "files");
  const sessionsDir = path.join(root, "sessions");
  const logsDir = path.join(root, "logs");
  ensureDir(filesDir);
  ensureDir(sessionsDir);
  ensureDir(logsDir);

  const contextPath = path.join(root, "context.md");
  if (!fs.existsSync(contextPath)) {
    fs.writeFileSync(
      contextPath,
      `# ctxparty Shared Context

This workspace is shared by ctxparty participants.

Use this file for durable notes, decisions, and handoff context.
Save larger artifacts in ./files/.
`,
      "utf8",
    );
  }

  const stamp = timestamp();
  const sessionLogPath = path.join(sessionsDir, `${stamp}.jsonl`);
  const debugLogPath = path.join(logsDir, `${stamp}.log`);
  fs.writeFileSync(debugLogPath, `ctxparty session started ${new Date().toISOString()}\n`, "utf8");

  const display = {
    projectRoot: toDisplayPath(projectRoot, launchRoot),
    root: toDisplayPath(root, projectRoot),
    filesDir: toDisplayPath(filesDir, projectRoot),
    sessionsDir: toDisplayPath(sessionsDir, projectRoot),
    logsDir: toDisplayPath(logsDir, projectRoot),
    contextPath: toDisplayPath(contextPath, projectRoot),
    sessionLogPath: toDisplayPath(sessionLogPath, projectRoot),
    debugLogPath: toDisplayPath(debugLogPath, projectRoot),
  };

  return {
    projectRoot,
    root,
    filesDir,
    sessionsDir,
    logsDir,
    contextPath,
    sessionLogPath,
    debugLogPath,
    display,
  };
}
