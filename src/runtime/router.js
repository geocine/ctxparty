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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function historyItemFromMessage(message) {
  return {
    author: message.author,
    text: message.text,
    color: message.color,
    ...(message.participantId ? { participantId: message.participantId } : {}),
  };
}

function withoutSelf(participantIds, participantId) {
  return participantIds.filter((id) => id !== participantId);
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
      permissionPolicy: participant.getPermissionPolicy?.(),
    }));
  }

  setPermissionPolicy(policy) {
    let changed = false;
    for (const participant of this.participants) {
      if (typeof participant.setPermissionPolicy === "function") {
        participant.setPermissionPolicy(policy);
        changed = true;
      }
    }
    if (changed) {
      appendEvent(this.workspace, {
        type: "permission_policy_changed",
        policy,
        timestamp: now(),
      });
    }
    return changed;
  }

  participantAliases() {
    const aliases = new Map();
    for (const participant of this.participants) {
      aliases.set(participant.id.toLowerCase(), participant.id);
      aliases.set(participant.label.toLowerCase(), participant.id);
    }
    return aliases;
  }

  resolveMentions(text, options = {}) {
    const aliases = this.participantAliases();

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

    if (options.includeParticipantCalls) {
      for (const [alias, participantId] of aliases) {
        const callPattern = new RegExp(
          `(?:^|[\\n.!?]\\s*)(?:hey\\s+|hi\\s+|ok(?:ay)?[:,]?\\s+|sure[:,]?\\s+)?${escapeRegExp(alias)}\\b(?:\\s*[:,;]|\\s+[\\u2014-]\\s+)`,
          "i",
        );
        if (callPattern.test(text)) {
          mentioned.push(participantId);
        }
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

    const participantTargets =
      targetParticipantIds.length > 0 ? targetParticipantIds : this.participants.map((participant) => participant.id);

    const message = createMessage({
      author: "User",
      text,
      color: "green",
      targetParticipantIds: participantTargets,
      directOnly: true,
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

      const targets = this.targetParticipantsForMessage(message);
      const producedReply =
        message.author === "User" && message.directOnly
          ? (await Promise.all(targets.map((participant) => this.routeToParticipant(participant, message, queue)))).some(Boolean)
          : (await this.routeToParticipantsSequentially(targets, message, queue));

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

  targetParticipantsForMessage(message) {
    return this.participants.filter((participant) => {
      if (this.muted.has(participant.id)) return false;
      if (message.participantId === participant.id) return false;
      if (
        Array.isArray(message.targetParticipantIds) &&
        message.targetParticipantIds.length > 0 &&
        !message.targetParticipantIds.includes(participant.id)
      ) {
        return false;
      }
      return true;
    });
  }

  async routeToParticipantsSequentially(participants, message, queue) {
    let producedReply = false;
    for (const participant of participants) {
      if (this.closed || this.abortController.signal.aborted) return producedReply;
      producedReply = (await this.routeToParticipant(participant, message, queue)) || producedReply;
    }
    return producedReply;
  }

  async routeToParticipant(participant, message, queue) {
    if (this.closed || this.abortController.signal.aborted) return false;

    const started = {
      type: "agent_started",
      participantId: participant.id,
      label: participant.label,
      messageId: message.id,
      timestamp: now(),
    };
    this.emit(started);
    appendEvent(this.workspace, started);

    let producedReply = false;
    try {
      for await (const event of participant.send(message, {
        workspace: this.workspace,
        signal: this.abortController.signal,
        history: this.recentHistory(),
      })) {
        if (this.closed || this.abortController.signal.aborted) return producedReply;

        if (event.type === "message") {
          const { targetParticipantIds } = this.resolveMentions(event.text, { includeParticipantCalls: true });
          const followUpTargets = withoutSelf(targetParticipantIds, participant.id);
          const reply = createMessage({
            author: event.author,
            participantId: event.participantId,
            color: event.color,
            text: event.text,
            targetParticipantIds: followUpTargets,
            directOnly: followUpTargets.length > 0,
          });
          this.emit(reply);
          appendEvent(this.workspace, reply);
          this.history.push(historyItemFromMessage(reply));
          if (followUpTargets.length > 0 || !message.directOnly) {
            queue.push(reply);
          }
          producedReply = true;
        } else if (event.type === "message_delta" || event.type === "thought_delta") {
          this.emit(event);
        } else if (event.type === "silent") {
          this.emit(event);
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
    } finally {
      const finished = {
        type: "agent_finished",
        participantId: participant.id,
        label: participant.label,
        messageId: message.id,
        timestamp: now(),
      };
      this.emit(finished);
      appendEvent(this.workspace, finished);
    }
    return producedReply;
  }

  recentHistory() {
    return this.history.slice(-MAX_AGENT_CONTEXT_MESSAGES);
  }

  interrupt(reason = "user") {
    if (this.closed || !this.routing || this.abortController.signal.aborted) return false;
    this.abortController.abort();
    this.emit({
      type: "status",
      text: "Interrupted. Agent stopped.",
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
