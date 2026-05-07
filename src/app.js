import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Container, Editor, Loader, ProcessTerminal, SelectList, Spacer, Text, TUI, matchesKey } from "./pi-tui.js";
import { ClaudeCliAgent, CodexCliAgent } from "./agents/cli-agents.js";
import { MockAgent } from "./agents/mock-agent.js";
import { PartyRouter } from "./runtime/router.js";
import { readEvents, visibleHistoryFromEvents } from "./runtime/transcript.js";
import { createWorkspace, listWorkspaceSessions, resolveWorkspaceSession, setWorkspaceSession } from "./runtime/workspace.js";
import { CtxpartyAutocompleteProvider } from "./tui/autocomplete.js";

const palette = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  white: "\x1b[37m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  orange: "\x1b[38;5;208m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};

const APP_TITLE = "Context Party";

const tuiTheme = {
  borderColor: (text) => `${palette.gray}${text}${palette.reset}`,
  selectList: {
    selectedPrefix: (text) => `${palette.gray}${text}${palette.reset}`,
    selectedText: (text) => `${palette.bold}${text}${palette.reset}`,
    description: (text) => `${palette.dim}${text}${palette.reset}`,
    scrollInfo: (text) => `${palette.dim}${text}${palette.reset}`,
    noMatch: (text) => `${palette.red}${text}${palette.reset}`,
  },
};

function colorize(enabled, color, text) {
  if (!enabled) return text;
  return `${palette[color] ?? ""}${text}${palette.reset}`;
}

function formatMessageLabel(author, color, enabled = true) {
  return colorize(enabled, color, `[${author}]`);
}

function createParticipants(options = {}) {
  if (options.participants === "real") {
    return [
      new CodexCliAgent({ color: "blue", timeoutMs: options.agentTimeoutMs }),
      new ClaudeCliAgent({ color: "orange", timeoutMs: options.agentTimeoutMs }),
    ];
  }

  return [
    new MockAgent({
      id: "codex",
      label: "Codex",
      color: "blue",
      stance: "implementation",
    }),
    new MockAgent({
      id: "claude",
      label: "Claude",
      color: "orange",
      stance: "design review",
    }),
  ];
}

function formatSessionModified(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function getSessionSummaries(workspace) {
  return listWorkspaceSessions(workspace)
    .map((session) => {
      const events = readEvents(session.path);
      const history = visibleHistoryFromEvents(events);
      const lastMessage = history.at(-1);
      return {
        ...session,
        messageCount: history.length,
        description: `${formatSessionModified(session.modified)} | ${history.length} messages${
          lastMessage ? ` | ${lastMessage.author}: ${lastMessage.text.replace(/\s+/g, " ").slice(0, 80)}` : ""
        }${session.active ? " | active" : ""}`,
      };
    })
    .filter((session) => session.messageCount > 0)
    .map((session, index) => ({ ...session, index: index + 1 }));
}

function historyForSession(sessionPath) {
  return visibleHistoryFromEvents(readEvents(sessionPath));
}

function sessionListText(sessions) {
  if (sessions.length === 0) return "No ctxparty sessions found.";
  return sessions
    .map((session) => {
      const active = session.active ? " *" : "";
      return `${session.index}. ${session.name}${active}\n   ${session.description}`;
    })
    .join("\n");
}

async function resumeSession(router, screen, sessionPath) {
  setWorkspaceSession(router.workspace, sessionPath);
  const history = historyForSession(sessionPath);
  router.markSessionResumed(sessionPath);
  screen.replaceHistory(history);
  screen.status(`Resumed ${history.length} visible messages from ${router.workspace.display.sessionLogPath}`);
}

function resolveResumeCommandSession(workspace, sessions, arg) {
  const trimmed = arg.trim();
  if (trimmed === "latest") {
    const latest = sessions[0];
    if (!latest) throw new Error("No ctxparty sessions found.");
    return latest.path;
  }

  const index = Number.parseInt(trimmed, 10);
  if (String(index) === trimmed && index >= 1 && index <= sessions.length) {
    return sessions[index - 1].path;
  }

  return resolveWorkspaceSession(workspace, trimmed);
}

class ConsoleScreen {
  constructor({ color, workspace, initialHistory = [] }) {
    this.color = color;
    this.workspace = workspace;
    this.history = [...initialHistory];
  }

  header() {
    const title = this.color ? `${palette.bold}${palette.green}${APP_TITLE}${palette.reset}` : APP_TITLE;
    const cwd = colorize(this.color, "dim", this.workspace.display.projectRoot);
    console.log(`${title}  ${cwd}`);
    console.log(colorize(this.color, "dim", "Type /help for commands. Ctrl+C or /quit exits."));
    console.log("");
  }

  clear() {
    console.clear();
    this.header();
  }

  event(event) {
    if (event.type === "message") {
      this.message(event.author, event.text, event.color);
    } else if (event.type === "status") {
      this.status(event.text);
    } else if (event.type === "error") {
      this.error(event.text);
    }
  }

  message(author, text, color = "green") {
    const label = formatMessageLabel(author, color, this.color);
    console.log(label);
    console.log(text);
    console.log("");
    this.history.push({ author, text, color });
  }

  info(text) {
    console.log(text);
  }

  status(text) {
    console.log(colorize(this.color, "gray", `  ${text}`));
  }

  error(text) {
    console.log(colorize(this.color, "red", `  ${text}`));
  }

  replayHistory() {
    for (const item of this.history) {
      const label = formatMessageLabel(item.author, item.color, this.color);
      console.log(label);
      console.log(item.text);
      console.log("");
    }
  }

  showResumedHistory() {
    if (this.history.length === 0) return;
    this.status(`Resumed ${this.history.length} visible messages from ${this.workspace.display.resumedSessionLogPath}`);
    this.replayHistory();
  }

  replaceHistory(history) {
    this.history = [...history];
    this.clear();
    this.replayHistory();
  }

  showSessionList(sessions) {
    this.info(sessionListText(sessions));
    if (sessions.length > 0) {
      this.status("Use /resume <number>, /resume latest, or /resume <session file>.");
    }
  }

  workspaceInfo() {
    console.log(`project:   ${this.workspace.display.projectRoot}`);
    console.log(`workspace: ${this.workspace.display.root}`);
    console.log(`session:   ${this.workspace.display.sessionLogPath}`);
    console.log(`log:       ${this.workspace.display.debugLogPath}`);
  }
}

class PiTuiScreen {
  constructor({ workspace, initialHistory = [] }) {
    this.workspace = workspace;
    this.history = [...initialHistory];
    this.resolveClose = undefined;
    this.closed = false;
    this.closePromise = undefined;
    this.sigintHandler = undefined;

    this.tui = new TUI(new ProcessTerminal(), false);
    this.header = new Text(this.headerText(), 1, 0);
    this.chat = new Container();
    this.statusContainer = new Container();
    this.activeLoader = undefined;
    this.activeResumeList = undefined;
    this.isSubmitting = false;
    this.onInterrupt = undefined;
    this.editor = new Editor(this.tui, tuiTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(new CtxpartyAutocompleteProvider());
    this.footer = new Text(this.footerText(), 1, 0);

    this.tui.addChild(this.header);
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.chat);
    this.tui.addChild(this.statusContainer);
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.editor);
    this.tui.addChild(this.footer);
    this.tui.setFocus(this.editor);

    this.tui.addInputListener((data) => {
      if (this.activeResumeList) {
        this.activeResumeList.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        this.handleCtrlC();
        return { consume: true };
      }
      if (this.isInterruptKey(data) && this.isSubmitting) {
        this.handleInterrupt();
        return { consume: true };
      }
      return undefined;
    });

    this.showResumedHistory();
  }

  headerText() {
    return `${palette.bold}${palette.green}${APP_TITLE}${palette.reset}  ${palette.dim}${this.workspace.display.projectRoot}${palette.reset}
${palette.gray}Enter sends. Ctrl+Enter adds lines. Esc interrupts agents. Ctrl+C clears draft; exits when empty.${palette.reset}`;
  }

  isInterruptKey(data) {
    return matchesKey(data, "escape") || matchesKey(data, "esc") || data?.toString?.("utf8") === "\x1b";
  }

  footerText() {
    return `${palette.white}workspace${palette.reset} ${palette.gray}${this.workspace.display.root}${palette.reset} ${palette.gray}|${palette.reset} ${palette.white}session${palette.reset} ${palette.gray}${this.workspace.display.sessionLogPath}${palette.reset}`;
  }

  start(onSubmit, onInterrupt) {
    this.onInterrupt = onInterrupt;
    this.editor.onSubmit = async (text) => {
      const trimmed = text.trim();
      if (!trimmed || this.closed) return;
      this.editor.disableSubmit = true;
      this.isSubmitting = true;
      try {
        await onSubmit(trimmed);
      } finally {
        this.isSubmitting = false;
        this.editor.disableSubmit = false;
        if (!this.closed) {
          this.tui.setFocus(this.editor);
          this.tui.requestRender();
        }
      }
    };
    this.tui.start();
    this.sigintHandler = () => this.requestClose();
    process.once("SIGINT", this.sigintHandler);
    return new Promise((resolve) => {
      this.resolveClose = resolve;
    });
  }

  requestClose() {
    void this.close();
  }

  handleCtrlC() {
    if (this.editor.getText().trim().length === 0) {
      this.status("Interrupted. Exiting.");
      this.requestClose();
      return;
    }

    this.clearEditor();
    this.status("Draft cleared. Press Ctrl+C again to exit.");
  }

  handleInterrupt() {
    if (this.onInterrupt?.()) {
      return;
    }
    this.status("Nothing to interrupt.");
  }

  clearEditor() {
    this.editor.setText("");
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.closed) return;
      this.closed = true;
      if (this.sigintHandler) {
        process.removeListener("SIGINT", this.sigintHandler);
        this.sigintHandler = undefined;
      }
      this.stopLoader();
      try {
        await this.tui.terminal.drainInput?.(1000);
      } finally {
        this.tui.stop();
        this.resolveClose?.();
      }
    })();
    return this.closePromise;
  }

  event(event) {
    if (event.type === "message") {
      this.message(event.author, event.text, event.color);
    } else if (event.type === "status") {
      this.status(event.text);
    } else if (event.type === "error") {
      this.error(event.text);
    }
  }

  addLine(text) {
    this.chat.addChild(new Text(text, 1, 0));
    this.tui.requestRender();
  }

  addHistoryLine(item) {
    const label = formatMessageLabel(item.author, item.color);
    this.addLine(`${label}\n${item.text}\n`);
  }

  replaceHistory(history) {
    this.history = [...history];
    this.chat.clear();
    for (const item of this.history) {
      this.addHistoryLine(item);
    }
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }

  showSessionList(sessions) {
    this.info(sessionListText(sessions));
  }

  showResumePicker(sessions, onSelect) {
    if (sessions.length === 0) {
      this.status("No ctxparty sessions found.");
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const items = sessions.map((session) => ({
        value: String(session.index),
        label: `${session.index}. ${session.name}${session.active ? " *" : ""}`,
        description: session.description,
      }));
      const list = new SelectList(items, 8, tuiTheme.selectList, {
        minPrimaryColumnWidth: 28,
        maxPrimaryColumnWidth: 42,
      });
      const container = new Container();
      container.addChild(new Text(`${palette.gray}Select a session to resume. Enter selects, Esc cancels.${palette.reset}`, 1, 0));
      container.addChild(list);

      const closePicker = () => {
        this.activeResumeList = undefined;
        this.setStatusComponent(undefined);
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
      };

      list.onSelect = async (item) => {
        const session = sessions[Number.parseInt(item.value, 10) - 1];
        closePicker();
        if (session) {
          await onSelect(session);
        }
        resolve();
      };
      list.onCancel = () => {
        closePicker();
        this.status("Resume cancelled.");
        resolve();
      };

      this.activeResumeList = list;
      this.setStatusComponent(container);
    });
  }

  message(author, text, color = "green") {
    this.setStatusComponent(undefined);
    const label = formatMessageLabel(author, color);
    this.addLine(`${label}\n${text}\n`);
    this.history.push({ author, text, color });
  }

  info(text) {
    this.addLine(text);
  }

  stopLoader() {
    if (this.activeLoader) {
      this.activeLoader.stop();
      this.activeLoader = undefined;
    }
  }

  setStatusComponent(component) {
    this.stopLoader();
    this.statusContainer.clear();
    if (component) {
      this.statusContainer.addChild(component);
    }
    this.tui.requestRender();
  }

  status(text) {
    if (/\b(thinking|working|loading|running)\b/i.test(text)) {
      const loader = new Loader(
        this.tui,
        (value) => `${palette.green}${value}${palette.reset}`,
        (value) => `${palette.gray}${value}${palette.reset}`,
        text,
      );
      this.activeLoader = loader;
      this.statusContainer.clear();
      this.statusContainer.addChild(loader);
      loader.start();
      this.tui.requestRender();
      return;
    }

    this.setStatusComponent(new Text(`${palette.gray}${text}${palette.reset}`, 1, 0));
  }

  error(text) {
    this.setStatusComponent(undefined);
    this.addLine(`${palette.red}${text}${palette.reset}`);
  }

  clear() {
    this.chat.clear();
    this.setStatusComponent(undefined);
    this.tui.requestRender(true);
  }

  replayHistory() {
    for (const item of this.history) {
      this.addHistoryLine(item);
    }
  }

  showResumedHistory() {
    if (this.history.length === 0) return;
    this.setStatusComponent(
      new Text(
        `${palette.gray}Resumed ${this.history.length} visible messages from ${this.workspace.display.resumedSessionLogPath}${palette.reset}`,
        1,
        0,
      ),
    );
    for (const item of this.history) {
      this.addHistoryLine(item);
    }
  }

  workspaceInfo() {
    this.info(
      [
        `${palette.bold}project${palette.reset}:   ${this.workspace.display.projectRoot}`,
        `${palette.bold}workspace${palette.reset}: ${this.workspace.display.root}`,
        `${palette.bold}session${palette.reset}:   ${this.workspace.display.sessionLogPath}`,
        `${palette.bold}log${palette.reset}:       ${this.workspace.display.debugLogPath}`,
      ].join("\n"),
    );
  }
}

function commandHelp() {
  return [
    "/help                  Show commands.",
    "/agents                List participants.",
    "@codex / @claude       Mention a participant for a direct reply only.",
    "@all                   Ask all participants once without follow-up routing.",
    "/mute <participant>    Mute a participant.",
    "/unmute <participant>  Unmute a participant.",
    "/workspace             Show workspace paths.",
    "/history               Replay visible message history.",
    "/resume [session]      Show resumable sessions, or resume one by number/name/path.",
    "/clear                 Clear the screen.",
    "/quit                  Exit.",
  ].join("\n");
}

function normalizeParticipantName(value) {
  return value.trim().toLowerCase();
}

async function handleCommand(inputText, router, screen) {
  const [command, ...rest] = inputText.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (command === "/help") {
    screen.info(commandHelp());
    return true;
  }
  if (command === "/agents") {
    const agents = router
      .listParticipants()
      .map((participant) => {
        const muted = participant.muted ? " muted" : "";
        return `${participant.label} (${participant.id})${muted}`;
      })
      .join("\n");
    screen.info(agents);
    return true;
  }
  if (command === "/mute") {
    if (!arg.trim()) {
      screen.error("Usage: /mute <participant>");
      return true;
    }
    if (router.setMuted(normalizeParticipantName(arg), true)) {
      screen.status(`Muted ${arg}`);
    }
    return true;
  }
  if (command === "/unmute") {
    if (!arg.trim()) {
      screen.error("Usage: /unmute <participant>");
      return true;
    }
    if (router.setMuted(normalizeParticipantName(arg), false)) {
      screen.status(`Unmuted ${arg}`);
    }
    return true;
  }
  if (command === "/workspace") {
    screen.workspaceInfo();
    return true;
  }
  if (command === "/history") {
    screen.replayHistory();
    return true;
  }
  if (command === "/resume") {
    const sessions = getSessionSummaries(router.workspace);
    if (!arg.trim()) {
      if (typeof screen.showResumePicker === "function") {
        await screen.showResumePicker(sessions, async (session) => {
          await resumeSession(router, screen, session.path);
        });
      } else {
        screen.showSessionList(sessions);
      }
      return true;
    }

    try {
      await resumeSession(router, screen, resolveResumeCommandSession(router.workspace, sessions, arg));
    } catch (error) {
      screen.error(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (command === "/clear") {
    screen.clear();
    return true;
  }
  if (command === "/quit" || command === "/exit") {
    return false;
  }

  screen.error(`Unknown command: ${command}`);
  return true;
}

export async function runCtxparty(options) {
  const workspace = createWorkspace(options.cwd, { resume: options.resume });
  const initialHistory = workspace.resumed ? visibleHistoryFromEvents(readEvents(workspace.sessionLogPath)) : [];
  if (options.once) {
    const screen = new ConsoleScreen({ color: options.color, workspace, initialHistory });
    const router = new PartyRouter({
      participants: createParticipants(options),
      workspace,
      maxTurns: options.maxTurns,
      onEvent: (event) => screen.event(event),
    });
    screen.header();
    screen.showResumedHistory();
    screen.status(`Session log: ${workspace.display.sessionLogPath}`);
    await router.submitUserMessage(options.once);
    await router.dispose();
    return;
  }

  if (input.isTTY) {
    const screen = new PiTuiScreen({ workspace, initialHistory });
    const router = new PartyRouter({
      participants: createParticipants(options),
      workspace,
      maxTurns: options.maxTurns,
      onEvent: (event) => screen.event(event),
    });
    screen.status(`Session log: ${workspace.display.sessionLogPath}`);
    await screen.start(
      async (text) => {
        if (text.startsWith("/")) {
          const keepGoing = await handleCommand(text, router, screen);
          if (!keepGoing) {
            await screen.close();
          }
          return;
        }
        await router.submitUserMessage(text);
      },
      () => router.interrupt("escape_key"),
    );
    await router.dispose();
    return;
  }

  const screen = new ConsoleScreen({ color: options.color, workspace, initialHistory });
  const router = new PartyRouter({
    participants: createParticipants(options),
    workspace,
    maxTurns: options.maxTurns,
    onEvent: (event) => screen.event(event),
  });
  screen.header();
  screen.showResumedHistory();
  screen.status(`Session log: ${workspace.display.sessionLogPath}`);

  const rl = readline.createInterface({ input, output });

  try {
    for await (const answer of rl) {
      output.write("> ");
      const trimmed = answer.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("/")) {
        const keepGoing = await handleCommand(trimmed, router, screen);
        if (!keepGoing) break;
        continue;
      }
      await router.submitUserMessage(trimmed);
    }
  } finally {
    rl.close();
    await router.dispose();
  }
}
