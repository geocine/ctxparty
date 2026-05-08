const slashCommands = [
  { value: "help", label: "help", description: "Show commands" },
  { value: "agents", label: "agents", description: "List participants" },
  { value: "mute", label: "mute", description: "Mute a participant", suffix: " " },
  { value: "unmute", label: "unmute", description: "Unmute a participant", suffix: " " },
  { value: "permissions", label: "permissions", description: "Set ACPX permission policy", suffix: " " },
  { value: "workspace", label: "workspace", description: "Show workspace paths" },
  { value: "history", label: "history", description: "Replay visible message history" },
  { value: "resume", label: "resume", description: "Show resumable sessions", suffix: " " },
  { value: "clear", label: "clear", description: "Clear the screen" },
  { value: "quit", label: "quit", description: "Exit" },
];

const mentions = [
  { value: "codex", label: "@codex", description: "Ask Codex for a direct reply" },
  { value: "claude", label: "@claude", description: "Ask Claude for a direct reply" },
  { value: "all", label: "@all", description: "Ask all participants once" },
];

function fuzzyIncludes(value, prefix) {
  return value.toLowerCase().includes(prefix.toLowerCase());
}

function filterItems(items, prefix) {
  return items.filter((item) => fuzzyIncludes(item.value, prefix));
}

export class CtxpartyAutocompleteProvider {
  async getSuggestions(lines, cursorLine, cursorCol) {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
      const prefix = textBeforeCursor.slice(1);
      const items = filterItems(slashCommands, prefix);
      if (items.length === 0) return null;
      return {
        items,
        prefix: textBeforeCursor,
      };
    }

    const mentionMatch = textBeforeCursor.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
    if (mentionMatch) {
      const prefix = mentionMatch[2] ?? "";
      const items = filterItems(mentions, prefix);
      if (items.length === 0) return null;
      return {
        items,
        prefix: `@${prefix}`,
      };
    }

    return null;
  }

  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const currentLine = lines[cursorLine] || "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const newLines = [...lines];

    if (prefix.startsWith("/")) {
      const suffix = item.suffix ?? " ";
      newLines[cursorLine] = `${beforePrefix}/${item.value}${suffix}${afterCursor}`;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1 + suffix.length,
      };
    }

    if (prefix.startsWith("@")) {
      newLines[cursorLine] = `${beforePrefix}@${item.value} ${afterCursor}`;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }

    return { lines, cursorLine, cursorCol };
  }
}
