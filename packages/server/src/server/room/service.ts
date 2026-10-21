import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import type pino from "pino";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  DEFAULT_ROOM_LIMITS,
  type RoomLimits,
  type RoomMember,
  type RoomRecord,
  type RoomSummary,
} from "@getpaseo/protocol/room/types";
import { ROOM_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import {
  buildCheckpointPrompt,
  buildMemberSystemPrompt,
  buildMemberTurnPrompt,
  buildModeratorSystemPrompt,
  buildOpeningPrompt,
  buildSummaryPrompt,
  fallbackOpening,
  parseModeratorDecision,
  parseModeratorOpening,
} from "./prompt.js";
import { RoomStore } from "./store.js";
import { stepRoomScheduler, type RoomCommand, type RoomEvent } from "./scheduler.js";

/** The slice of AgentManager the room service is allowed to touch. */
export type RoomAgentManager = Pick<
  AgentManager,
  "createAgent" | "runAgent" | "cancelAgentRun" | "archiveAgent" | "unarchiveSnapshot" | "getAgent"
>;

export interface CreateRoomInput {
  workspaceId: string;
  name: string;
  topic: string;
  moderator: { provider: string; model?: string | null; modeId?: string | null };
  members: Array<{
    provider: string;
    model?: string | null;
    modeId?: string | null;
    persona: string;
  }>;
  artifactPath: string;
  limits?: Partial<RoomLimits>;
}

/** On reopen a member goes back to ready when its agent survived the archive. */
function readyMembers(members: RoomMember[]): RoomMember[] {
  const restored = structuredClone(members);
  for (const member of restored) {
    member.status = member.agentId ? "ready" : "pending";
  }
  return restored;
}

export interface RoomServiceOptions {
  roomsDir: string;
  logger: pino.Logger;
  agentManager: RoomAgentManager;
  /** Fan a room_update out to every connected client. */
  broadcast: (message: SessionOutboundMessage) => void;
  resolveWorkspaceDirectory: (workspaceId: string) => Promise<string | null>;
  now?: () => Date;
}

export class RoomService {
  private readonly store: RoomStore;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();
  private readonly latest = new Map<string, RoomRecord>();
  private readonly now: () => Date;

  constructor(private readonly options: RoomServiceOptions) {
    this.store = new RoomStore(options.roomsDir, options.logger);
    this.now = options.now ?? (() => new Date());
  }

  /** Daemon restart: rooms mid-flight become interrupted and never auto-resume (§8.3). */
  async interruptStaleRooms(): Promise<void> {
    for (const room of await this.store.list()) {
      if (room.status !== "opening" && room.status !== "discussing") continue;
      const updated: RoomRecord = { ...room, status: "interrupted", updatedAt: this.stamp() };
      await this.store.update(room.id, () => updated);
      this.broadcast(updated);
      this.options.logger.warn({ roomId: room.id }, "Room marked interrupted after daemon restart");
    }
  }

  async create(input: CreateRoomInput): Promise<RoomRecord> {
    const workspaceDirectory = await this.options.resolveWorkspaceDirectory(input.workspaceId);
    if (!workspaceDirectory) {
      throw new Error(`Workspace ${input.workspaceId} not found`);
    }
    this.assertArtifactPath(input.artifactPath, workspaceDirectory);
    const at = this.stamp();
    const limits: RoomLimits = { ...DEFAULT_ROOM_LIMITS, ...input.limits };
    const room = await this.store.create({
      workspaceId: input.workspaceId,
      name: input.name,
      topic: input.topic,
      status: "forming",
      promptVersion: 1,
      moderator: {
        agentId: null,
        provider: input.moderator.provider,
        model: input.moderator.model ?? null,
        modeId: input.moderator.modeId ?? null,
      },
      members: input.members.map((member, index) => ({
        id: `member_${index + 1}`,
        agentId: null,
        provider: member.provider,
        model: member.model ?? null,
        modeId: member.modeId ?? null,
        persona: member.persona,
        status: "pending",
        joinedAt: at,
        lastDeliveredSeq: 0,
        turnCount: 0,
      })),
      turn: {
        index: 0,
        memberId: null,
        agentId: null,
        turnId: null,
        status: "idle",
        startedAt: null,
        deadlineAt: null,
        attempt: 0,
      },
      round: { index: 1, remainingMemberIds: [] },
      transcript: [],
      interjections: [],
      lastSeq: 0,
      limits,
      artifactPath: input.artifactPath,
      summary: null,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      closedReason: null,
    });
    this.broadcast(room);
    return room;
  }

  async list(): Promise<RoomSummary[]> {
    const rooms = await this.store.list();
    return rooms.map(
      ({ transcript: _transcript, interjections: _interjections, ...summary }) => summary,
    );
  }

  async get(roomId: string): Promise<RoomRecord | null> {
    return this.store.get(roomId);
  }

  async start(roomId: string, resume = false): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status === "closed") {
        throw new Error("Room is closed; reopen it before starting");
      }
      if (record.status === "interrupted") {
        if (!resume) throw new Error("Room is interrupted; pass resume to continue");
        return this.applyStep(record, { type: "user_resume", at: this.stamp() });
      }
      if (record.status !== "forming") {
        return record; // Already running: idempotent no-op (§8.4).
      }
      const withAgents = await this.ensureAgents(record);
      return this.applyStep(withAgents, { type: "room_started", at: this.stamp() });
    });
  }

  async pause(roomId: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status !== "discussing" && record.status !== "opening") return record;
      return this.applyStep(record, { type: "user_pause", at: this.stamp() });
    });
  }

  async resume(roomId: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status !== "interrupted") return record;
      return this.applyStep(record, { type: "user_resume", at: this.stamp() });
    });
  }

  async interject(roomId: string, text: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      const event: RoomEvent = {
        type: "interjection_queued",
        at: this.stamp(),
        interjectionId: `int_${randomUUID().slice(0, 8)}`,
        text,
      };
      return this.applyStep(record, event);
    });
  }

  async close(roomId: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status === "closed") return record; // Idempotent (§8.4).
      const next = await this.applyStep(record, { type: "user_close", at: this.stamp() });
      if (!next.moderator.agentId) {
        // Nothing can produce a summary; close immediately.
        return this.finalizeClose(next, "closed before start");
      }
      return next; // Summary + finalize run through the moderator task.
    });
  }

  async reopen(roomId: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status !== "closed") return record; // Idempotent (§8.4).
      for (const agentId of this.collectAgentIds(record)) {
        await this.options.agentManager.unarchiveSnapshot(agentId).catch(() => undefined);
      }
      const at = this.stamp();
      const reopened: RoomRecord = {
        ...record,
        status: "interrupted",
        closedAt: null,
        closedReason: null,
        updatedAt: at,
        members: readyMembers(record.members),
      };
      return this.applyDirect(reopened);
    });
  }

  /**
   * Design §5.5: workspace-relative, no `..` segments, and the resolved path
   * must stay inside the workspace directory.
   */
  private assertArtifactPath(artifactPath: string, workspaceDirectory: string): void {
    const trimmed = artifactPath.trim();
    if (trimmed.length === 0) throw new Error("artifactPath is required");
    if (isAbsolute(trimmed)) throw new Error("artifactPath must be workspace-relative");
    const segments = trimmed.split(/[/\\]/u);
    if (segments.some((segment) => segment === "..")) {
      throw new Error("artifactPath must not contain '..' segments");
    }
    const resolved = resolve(workspaceDirectory, trimmed);
    const prefix = workspaceDirectory.endsWith(sep) ? workspaceDirectory : workspaceDirectory + sep;
    if (!resolved.startsWith(prefix)) {
      throw new Error("artifactPath must stay inside the workspace directory");
    }
  }

  // ===========================================================================
  // Scheduler application
  // ===========================================================================

  private async applyStep(record: RoomRecord, event: RoomEvent): Promise<RoomRecord> {
    const next = stepRoomScheduler(record, event);
    return this.applyDirect(next.record, next.commands);
  }

  private async applyDirect(record: RoomRecord, commands: RoomCommand[] = []): Promise<RoomRecord> {
    this.latest.set(record.id, record);
    await this.store.update(record.id, () => record);
    this.broadcast(record);
    for (const command of commands) {
      this.executeCommand(record.id, command);
    }
    return record;
  }

  private executeCommand(roomId: string, command: RoomCommand): void {
    void this.serialize(roomId, async () => {
      const record = this.latest.get(roomId) ?? (await this.store.get(roomId));
      if (!record) return;
      switch (command.type) {
        case "create_members": {
          const withAgents = await this.ensureAgents(record);
          if (withAgents !== record) await this.applyDirect(withAgents);
          return;
        }
        case "ask_moderator":
          // Long-running: runs outside the queue and feeds its result back as an event.
          void this.runModerator(roomId, command.checkpoint).catch((error) => {
            this.options.logger.error({ err: error, roomId }, "Moderator task failed");
          });
          return;
        case "prompt_member":
          void this.runMemberTurn(roomId, command.memberId).catch((error) => {
            this.options.logger.error({ err: error, roomId }, "Member turn failed");
          });
          return;
        case "cancel_agent": {
          const member = record.members.find((entry) => entry.id === command.memberId);
          if (member?.agentId) {
            await this.options.agentManager.cancelAgentRun(member.agentId).catch(() => undefined);
          }
          return;
        }
      }
    }).catch((error) => {
      this.options.logger.error({ err: error, roomId }, "Room command failed");
    });
  }

  // ===========================================================================
  // Agents
  // ===========================================================================

  private async ensureAgents(record: RoomRecord): Promise<RoomRecord> {
    const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
    if (!workspaceDirectory) {
      throw new Error(`Workspace ${record.workspaceId} not found`);
    }
    let next = record;
    if (!next.moderator.agentId) {
      const agent = await this.options.agentManager.createAgent(
        this.memberConfig(
          {
            provider: next.moderator.provider,
            model: next.moderator.model,
            modeId: next.moderator.modeId,
          },
          workspaceDirectory,
          buildModeratorSystemPrompt({
            workspaceDirectory,
            roomName: next.name,
            members: next.members,
          }),
        ),
        undefined,
        {
          workspaceId: next.workspaceId,
          labels: { [ROOM_ID_LABEL]: next.id },
          initialTitle: `Room moderator · ${next.name}`,
        },
      );
      next = { ...next, moderator: { ...next.moderator, agentId: agent.id } };
    }
    const members = [...next.members];
    for (let index = 0; index < members.length; index++) {
      const member = members[index]!;
      if (member.agentId) continue;
      const agent = await this.options.agentManager.createAgent(
        this.memberConfig(
          member,
          workspaceDirectory,
          buildMemberSystemPrompt({ roomName: next.name, member }),
        ),
        undefined,
        {
          workspaceId: next.workspaceId,
          labels: { [ROOM_ID_LABEL]: next.id },
          initialTitle: `Room member ${member.id} · ${next.name}`,
        },
      );
      members[index] = { ...member, agentId: agent.id, status: "ready" };
    }
    return { ...next, members };
  }

  private memberConfig(
    member: { provider: string; model: string | null; modeId: string | null },
    cwd: string,
    systemPrompt: string,
  ): AgentSessionConfig {
    return {
      provider: member.provider,
      cwd,
      model: member.model ?? undefined,
      modeId: member.modeId ?? undefined,
      systemPrompt,
    };
  }

  private collectAgentIds(record: RoomRecord): string[] {
    return [record.moderator.agentId, ...record.members.map((member) => member.agentId)].filter(
      (agentId): agentId is string => typeof agentId === "string",
    );
  }

  // ===========================================================================
  // Moderator + member turns
  // ===========================================================================

  private async runModerator(
    roomId: string,
    checkpoint: "opening" | "round_end" | "interjection" | "summary",
  ): Promise<void> {
    const record = await this.store.get(roomId);
    if (!record?.moderator.agentId) {
      return;
    }
    let prompt = buildCheckpointPrompt({
      round: record.round.index,
      turnCount: record.turn.index,
      recentTranscript: this.recentTranscript(record),
      pendingInterjections: this.pendingInterjectionText(record),
    });
    if (checkpoint === "opening") {
      prompt = buildOpeningPrompt(record.topic);
    } else if (checkpoint === "summary") {
      prompt = buildSummaryPrompt();
    }
    let text = "";
    try {
      const result = await this.options.agentManager.runAgent(record.moderator.agentId, prompt);
      text = result.finalText;
    } catch (error) {
      this.options.logger.warn(
        { err: error, roomId, checkpoint },
        "Moderator run failed; using deterministic fallback",
      );
    }

    if (checkpoint === "summary") {
      const summary = text.trim().length > 0 ? text.trim() : "（主持人总结不可用。）";
      await this.serialize(roomId, async () => {
        const current = await this.requireRoom(roomId);
        const next = await this.applyStep(current, {
          type: "moderator_summary_ready",
          at: this.stamp(),
          summary,
        });
        await this.finalizeClose(next, "closed by user");
      });
      return;
    }

    if (checkpoint === "opening") {
      const opening = parseModeratorOpening(text) ?? fallbackOpening(text);
      await this.serializeFeed(roomId, {
        type: "moderator_opening_ready",
        at: this.stamp(),
        opening: opening.opening,
        nextMemberId: opening.nextMemberId,
      });
      return;
    }

    const decision = parseModeratorDecision(text) ?? {
      action: "continue" as const,
      nextMemberId: null,
      reason: "moderator reply unusable",
      userReply: null,
    };
    await this.serializeFeed(roomId, {
      type: "moderator_checkpoint_ready",
      at: this.stamp(),
      action: decision.action,
      nextMemberId: decision.nextMemberId,
      reason: decision.reason,
      userReply: decision.userReply,
    });
  }

  private async runMemberTurn(roomId: string, memberId: string): Promise<void> {
    const record = await this.store.get(roomId);
    if (!record || record.status !== "discussing") return;
    const member = record.members.find((entry) => entry.id === memberId);
    if (!member?.agentId) return;
    const prompt = buildMemberTurnPrompt({
      record,
      member,
      moderatorNote: null,
      retryReason: record.turn.attempt > 0 ? "previous attempt failed" : null,
    });

    const timer = setTimeout(() => {
      void this.serializeFeed(roomId, { type: "turn_timeout", at: this.stamp() }).catch(
        () => undefined,
      );
    }, record.limits.turnTimeoutMs);
    this.turnTimers.set(roomId, timer);

    let event: RoomEvent;
    try {
      const result = await this.options.agentManager.runAgent(member.agentId, prompt);
      event = result.canceled
        ? { type: "turn_timeout", at: this.stamp() }
        : { type: "member_turn_completed", at: this.stamp(), memberId, text: result.finalText };
    } catch (error) {
      event = {
        type: "member_turn_failed",
        at: this.stamp(),
        memberId,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      this.turnTimers.delete(roomId);
    }
    await this.serializeFeed(roomId, event);
  }

  private recentTranscript(record: RoomRecord): string {
    return record.transcript
      .slice(-20)
      .map((entry) => {
        let speaker: string = entry.kind;
        if (entry.kind === "member") speaker = entry.memberId ?? "member";
        else if (entry.kind === "interjection") speaker = "user";
        return `- ${speaker}: ${entry.text}`;
      })
      .join("\n");
  }

  private pendingInterjectionText(record: RoomRecord): string {
    const pending = record.interjections.filter((entry) => entry.status === "queued");
    return pending.length > 0 ? pending.map((entry) => `- ${entry.text}`).join("\n") : "（none）";
  }

  // ===========================================================================
  // Close finalization
  // ===========================================================================

  private async finalizeClose(record: RoomRecord, reason: string): Promise<RoomRecord> {
    for (const agentId of this.collectAgentIds(record)) {
      await this.options.agentManager.archiveAgent(agentId).catch(() => undefined);
    }
    const at = this.stamp();
    const closed: RoomRecord = {
      ...record,
      status: "closed",
      closedAt: at,
      closedReason: reason,
      updatedAt: at,
      members: record.members.map((member) => ({ ...member, status: "archived" })),
    };
    return this.applyDirect(closed);
  }

  // ===========================================================================
  // Plumbing
  // ===========================================================================

  private async requireRoom(roomId: string): Promise<RoomRecord> {
    const record = await this.store.get(roomId);
    if (!record) throw new Error(`Room ${roomId} not found`);
    return record;
  }

  private serializeFeed(roomId: string, event: RoomEvent): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      return this.applyStep(record, event);
    });
  }

  private serialize<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(roomId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.chains.set(roomId, tail);
    void tail.finally(() => {
      if (this.chains.get(roomId) === tail) this.chains.delete(roomId);
    });
    return next;
  }

  private broadcast(record: RoomRecord): void {
    this.options.broadcast({ type: "room_update", payload: { room: record } });
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
