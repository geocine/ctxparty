import { randomUUID } from "node:crypto";
import { appendEvent, readEvents, visibleHistoryFromEvents } from "./transcript.js";

const MAX_AGENT_CONTEXT_MESSAGES = 24;

function now() {
  return new Date().toISOString();
}

function createMessage({ author, text, participantId, color, targetParticipantIds, directOnly }) {
  return {
    type: "message",
    id: randomUUID(),
    author,
    participantId,
    color,
    text,
    ...(targetParticipantIds?.length ? { targetParticipantIds } : {}),
    ...(directOnly ? { directOnly: true } : {}),
    timestamp: now(),
  };
}

function unique(values) {
  return Array.from(new Set(values));
}

function historyItemFromMessage(message) {
  return {
    author: message.author,
    text: message.text,
    color: message.color,
    ...(message.participantId ? { participantId: message.participantId } : {}),
  };
}

export class PartyRouter {
  constructor({ participants, workspace, maxTurns, onEvent }) {
    this.participants = participants;
    this.workspace = workspace;
    this.maxTurns = maxTurns;
    this.onEvent = onEvent;
    this.muted = new Set();
    this.closed = false;
    this.routing = false;
    this.abortController = new AbortController();
    this.history = visibleHistoryFromEvents(readEvents(this.workspace.sessionLogPath));

    appendEvent(this.workspace, {
      type: this.workspace.resumed ? "session_resumed" : "session_started",
      timestamp: now(),
      ...(this.workspace.resumedSessionLogPath ? { resumedSessionLogPath: this.workspace.resumedSessionLogPath } : {}),
      participants: this.participants.map((participant) => ({
        id: participant.id,
        label: participant.label,
      })),
    });
  }

  listParticipants() {
    return this.participants.map((participant) => ({
      id: participant.id,
      label: participant.label,
      muted: this.muted.has(participant.id),
    }));
  }

  resolveMentions(text) {
    const aliases = new Map();
    for (const participant of this.participants) {
      aliases.set(participant.id.toLowerCase(), participant.id);
      aliases.set(participant.label.toLowerCase(), participant.id);
    }

    const mentioned = [];
    const unknown = [];
    const mentionPattern = /(^|\s)@([a-zA-Z][\w-]*)\b/g;
    for (const match of text.matchAll(mentionPattern)) {
      const rawName = match[2].toLowerCase();
      if (rawName === "all") {
        return {
          targetParticipantIds: this.participants.map((participant) => participant.id),
          unknownMentions: [],
        };
      }
      const participantId = aliases.get(rawName);
      if (participantId) {
        mentioned.push(participantId);
      } else {
        unknown.push(rawName);
      }
    }

    return {
      targetParticipantIds: unique(mentioned),
      unknownMentions: unique(unknown),
    };
  }

  setMuted(participantName, muted) {
    const participant = this.participants.find(
      (item) => item.id === participantName || item.label.toLowerCase() === participantName,
    );
    if (!participant) {
      this.emit({
        type: "error",
        text: `No participant named ${participantName}`,
      });
      return false;
    }
    if (muted) {
      this.muted.add(participant.id);
    } else {
      this.muted.delete(participant.id);
    }
    appendEvent(this.workspace, {
      type: muted ? "participant_muted" : "participant_unmuted",
      participantId: participant.id,
      timestamp: now(),
    });
    return true;
  }

  markSessionResumed(sessionLogPath) {
    this.history = visibleHistoryFromEvents(readEvents(sessionLogPath));
    appendEvent(this.workspace, {
      type: "session_resumed",
      timestamp: now(),
      resumedSessionLogPath: sessionLogPath,
      participants: this.participants.map((participant) => ({
        id: participant.id,
        label: participant.label,
      })),
    });
  }

  async submitUserMessage(text) {
    if (this.closed) return;
    if (this.routing) {
      this.emit({
        type: "status",
        text: "A message is already being routed. Press Esc to interrupt it first.",
      });
      return;
    }
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    const { targetParticipantIds, unknownMentions } = this.resolveMentions(text);
    for (const mention of unknownMentions) {
      this.emit({
        type: "error",
        text: `Unknown mention @${mention}. Use @codex, @claude, or @all.`,
      });
    }
    if (unknownMentions.length > 0 && targetParticipantIds.length === 0) {
      appendEvent(this.workspace, {
        type: "message_rejected",
        reason: "unknown_mentions",
        text,
        unknownMentions,
        timestamp: now(),
      });
      return;
    }

    const message = createMessage({
      author: "User",
      text,
      color: "green",
      targetParticipantIds,
      directOnly: targetParticipantIds.length > 0,
    });
    this.emit(message);
    appendEvent(this.workspace, message);
    this.history.push(historyItemFromMessage(message));
    this.routing = true;
    try {
      await this.route([message]);
    } finally {
      this.routing = false;
      if (!this.closed && this.abortController.signal.aborted) {
        this.abortController = new AbortController();
      }
    }
  }

  async route(initialQueue) {
    const queue = [...initialQueue];
    let turns = 0;

    while (queue.length > 0) {
      if (this.closed || this.abortController.signal.aborted) return;

      if (turns >= this.maxTurns) {
        this.emit({
          type: "status",
          text: `Max turn limit (${this.maxTurns}) reached; routing stopped.`,
        });
        appendEvent(this.workspace, {
          type: "router_stopped",
          reason: "max_turns",
          maxTurns: this.maxTurns,
          timestamp: now(),
        });
        return;
      }

      const message = queue.shift();
      turns += 1;
      appendEvent(this.workspace, {
        type: "router_turn_started",
        messageId: message.id,
        author: message.author,
        timestamp: now(),
      });

      let producedReply = false;
      for (const participant of this.participants) {
        if (this.closed || this.abortController.signal.aborted) return;
        if (this.muted.has(participant.id)) continue;
        if (message.participantId === participant.id) continue;
        if (
          message.author === "User" &&
          Array.isArray(message.targetParticipantIds) &&
          message.targetParticipantIds.length > 0 &&
          !message.targetParticipantIds.includes(participant.id)
        ) {
          continue;
        }

        appendEvent(this.workspace, {
          type: "agent_started",
          participantId: participant.id,
          messageId: message.id,
          timestamp: now(),
        });

        for await (const event of participant.send(message, {
          workspace: this.workspace,
          signal: this.abortController.signal,
          history: this.recentHistory(),
        })) {
          if (this.closed || this.abortController.signal.aborted) return;

          if (event.type === "message") {
            const reply = createMessage({
              author: event.author,
              participantId: event.participantId,
              color: event.color,
              text: event.text,
            });
            this.emit(reply);
            appendEvent(this.workspace, reply);
            this.history.push(historyItemFromMessage(reply));
            if (!message.directOnly) {
              queue.push(reply);
            }
            producedReply = true;
          } else if (event.type === "silent") {
            this.emit({ type: "status", text: event.text });
            appendEvent(this.workspace, {
              type: "agent_silent",
              participantId: event.participantId,
              timestamp: now(),
            });
          } else {
            this.emit(event);
            appendEvent(this.workspace, {
              ...event,
              timestamp: now(),
            });
          }
        }
      }

      appendEvent(this.workspace, {
        type: "router_turn_finished",
        messageId: message.id,
        producedReply,
        timestamp: now(),
      });
    }
  }

  emit(event) {
    this.onEvent?.(event);
  }

  recentHistory() {
    return this.history.slice(-MAX_AGENT_CONTEXT_MESSAGES);
  }

  interrupt(reason = "user") {
    if (this.closed || !this.routing || this.abortController.signal.aborted) return false;
    this.abortController.abort();
    this.emit({
      type: "status",
      text: "Interrupted. Agent thinking stopped.",
    });
    appendEvent(this.workspace, {
      type: "router_interrupted",
      reason,
      timestamp: now(),
    });
    return true;
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    for (const participant of this.participants) {
      await participant.dispose?.();
    }
    appendEvent(this.workspace, {
      type: "session_finished",
      timestamp: now(),
    });
  }
}
