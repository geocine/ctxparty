import fs from "node:fs";
import path from "node:path";

export function appendEvent(workspace, event) {
  fs.mkdirSync(path.dirname(workspace.sessionLogPath), { recursive: true });
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
    .flatMap((event) => {
      if (event.type === "message" && typeof event.author === "string" && typeof event.text === "string") {
        return [{
          author: event.author,
          text: event.text,
          color: event.color,
        }];
      }
      if (event.type === "error" && typeof event.text === "string") {
        return [{
          author: "ctxparty",
          text: event.text,
          color: "red",
        }];
      }
      return [];
    });
}
