import fs from "node:fs";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function listSessionFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(sessionsDir, name))
    .filter(isFile)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function latestSessionPath(sessionsDir) {
  return listSessionFiles(sessionsDir)[0];
}

function sessionPathCandidates(value, { launchRoot, projectRoot, sessionsDir }) {
  const names = value.endsWith(".jsonl") ? [value] : [value, `${value}.jsonl`];
  const candidates = [];
  for (const name of names) {
    if (path.isAbsolute(name)) {
      candidates.push(name);
    } else {
      candidates.push(path.resolve(launchRoot, name), path.resolve(projectRoot, name), path.join(sessionsDir, name));
    }
  }
  return candidates;
}

function resolveResumeSession(resume, { launchRoot, projectRoot, sessionsDir }) {
  if (!resume) return undefined;
  if (resume === true || resume === "latest") {
    const latest = latestSessionPath(sessionsDir);
    if (!latest) {
      throw new Error(`No ctxparty sessions found in ${toDisplayPath(sessionsDir, projectRoot)}`);
    }
    return latest;
  }

  for (const candidate of sessionPathCandidates(String(resume), { launchRoot, projectRoot, sessionsDir })) {
    if (isFile(candidate)) return candidate;
  }

  throw new Error(`Session not found: ${resume}`);
}

function toDisplayPath(target, base) {
  const relative = path.relative(base, target) || ".";
  const safeRelative = path.isAbsolute(relative) ? path.basename(target) : relative;
  return safeRelative.split(path.sep).join("/");
}

export function listWorkspaceSessions(workspace) {
  return listSessionFiles(workspace.sessionsDir).map((sessionPath, index) => {
    const stat = fs.statSync(sessionPath);
    return {
      index: index + 1,
      name: path.basename(sessionPath),
      path: sessionPath,
      displayPath: toDisplayPath(sessionPath, workspace.projectRoot),
      modified: new Date(stat.mtimeMs),
      active: path.resolve(sessionPath) === path.resolve(workspace.sessionLogPath),
    };
  });
}

export function resolveWorkspaceSession(workspace, value) {
  const sessions = listWorkspaceSessions(workspace);
  const trimmed = String(value || "latest").trim();

  if (trimmed === "latest") {
    const latest = sessions[0];
    if (!latest) {
      throw new Error(`No ctxparty sessions found in ${workspace.display.sessionsDir}`);
    }
    return latest.path;
  }

  const index = Number.parseInt(trimmed, 10);
  if (String(index) === trimmed && index >= 1 && index <= sessions.length) {
    return sessions[index - 1].path;
  }

  for (const session of sessions) {
    if (session.name === trimmed || session.name.replace(/\.jsonl$/, "") === trimmed || session.displayPath === trimmed) {
      return session.path;
    }
  }

  const resolved = resolveResumeSession(trimmed, {
    launchRoot: process.cwd(),
    projectRoot: workspace.projectRoot,
    sessionsDir: workspace.sessionsDir,
  });
  if (!resolved) {
    throw new Error(`Session not found: ${trimmed}`);
  }
  return resolved;
}

export function setWorkspaceSession(workspace, sessionLogPath) {
  workspace.sessionLogPath = sessionLogPath;
  workspace.resumedSessionLogPath = sessionLogPath;
  workspace.resumed = true;
  workspace.display.sessionLogPath = toDisplayPath(sessionLogPath, workspace.projectRoot);
  workspace.display.resumedSessionLogPath = workspace.display.sessionLogPath;
}

export function readWorkspaceSettings(workspace) {
  return readJsonObject(workspace.settingsPath);
}

export function writeWorkspaceSettings(workspace, settings) {
  const nextSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  fs.writeFileSync(workspace.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  workspace.settings = nextSettings;
}

export function setWorkspacePermissionPolicy(workspace, permissionPolicy) {
  writeWorkspaceSettings(workspace, {
    ...readWorkspaceSettings(workspace),
    permissionPolicy,
  });
}

export function createWorkspace(cwd, options = {}) {
  const projectRoot = path.resolve(cwd);
  const launchRoot = process.cwd();
  ensureDir(projectRoot);

  const root = path.join(projectRoot, "__ctxparty__");
  const filesDir = path.join(root, "files");
  const sessionsDir = path.join(root, "sessions");
  const logsDir = path.join(root, "logs");
  const settingsPath = path.join(root, "settings.json");
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

  const resumedSessionLogPath = resolveResumeSession(options.resume, { launchRoot, projectRoot, sessionsDir });
  const stamp = timestamp();
  const sessionLogPath = resumedSessionLogPath ?? path.join(sessionsDir, `${stamp}.jsonl`);
  const debugLogPath = path.join(logsDir, `${stamp}.log`);
  const settings = readJsonObject(settingsPath);
  fs.writeFileSync(
    debugLogPath,
    resumedSessionLogPath
      ? `ctxparty session resumed ${new Date().toISOString()} from ${resumedSessionLogPath}\n`
      : `ctxparty session started ${new Date().toISOString()}\n`,
    "utf8",
  );

  const display = {
    projectRoot: toDisplayPath(projectRoot, launchRoot),
    root: toDisplayPath(root, projectRoot),
    filesDir: toDisplayPath(filesDir, projectRoot),
    sessionsDir: toDisplayPath(sessionsDir, projectRoot),
    logsDir: toDisplayPath(logsDir, projectRoot),
    contextPath: toDisplayPath(contextPath, projectRoot),
    settingsPath: toDisplayPath(settingsPath, projectRoot),
    sessionLogPath: toDisplayPath(sessionLogPath, projectRoot),
    debugLogPath: toDisplayPath(debugLogPath, projectRoot),
    resumedSessionLogPath: resumedSessionLogPath ? toDisplayPath(resumedSessionLogPath, projectRoot) : undefined,
  };

  return {
    projectRoot,
    root,
    filesDir,
    sessionsDir,
    logsDir,
    contextPath,
    settingsPath,
    sessionLogPath,
    resumedSessionLogPath,
    debugLogPath,
    resumed: Boolean(resumedSessionLogPath),
    settings,
    display,
  };
}
