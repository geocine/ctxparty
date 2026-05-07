export class MockAgent {
  constructor({ id, label, color, stance }) {
    this.id = id;
    this.label = label;
    this.color = color;
    this.stance = stance;
  }

  async *send(message, context) {
    yield {
      type: "status",
      text: `${this.label} thinking...`,
    };

    if (message.author !== "User") {
      yield {
        type: "silent",
        participantId: this.id,
        text: `${this.label} stayed silent`,
      };
      return;
    }

    const workspaceHint = context.workspace.root;
    yield {
      type: "message",
      author: this.label,
      participantId: this.id,
      color: this.color,
      text:
        `${this.label} mock ${this.stance} pass: I received "${message.text}". ` +
        `Shared workspace is ${workspaceHint}.`,
    };
  }

  async dispose() {}
}
