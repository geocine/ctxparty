import fs from "node:fs";

export function appendEvent(workspace, event) {
  fs.appendFileSync(workspace.sessionLogPath, `${JSON.stringify(event)}\n`, "utf8");
}
