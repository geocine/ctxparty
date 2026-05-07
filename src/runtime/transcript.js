import fs from "node:fs";

export function appendEvent(workspace, event) {
  fs.appendFileSync(workspace.sessionLogPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(sessionLogPath) {
  if (!sessionLogPath || !fs.existsSync(sessionLogPath)) return [];

  return fs
    .readFileSync(sessionLogPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function visibleHistoryFromEvents(events) {
  return events
    .filter((event) => event.type === "message" && typeof event.author === "string" && typeof event.text === "string")
    .map((event) => ({
      author: event.author,
      text: event.text,
      color: event.color,
    }));
}
