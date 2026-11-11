import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type pino from "pino";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  DEFAULT_ROOM_LIMITS,
  type RoomLimits,
  type RoomMember,
  type RoomRecord,
  type RoomSummary,
} from "@getpaseo/protocol/room/types";
import { roomMemberAgentTitle, roomModeratorAgentTitle } from "@getpaseo/protocol/room/labels";
import { ROOM_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  buildCatchupSummaryPrompt,
  buildCatchupTurnPrompt,
  buildCheckpointPrompt,
  buildHumanizedTranscript,
  buildMemberSystemPrompt,
  buildMemberTurnPrompt,
  buildModeratorSystemPrompt,
  buildOpeningPrompt,
  buildRosterText,
  buildSummaryPrompt,
  fallbackOpening,
  parseModeratorDecision,
  parseModeratorOpening,
} from "./prompt.js";
import {
  assertInsideWorkspaceDirectory,
  formatRoomFilesManifest,
  listRoomFiles,
  type RoomFileEntry,
} from "./files.js";
import { RoomStore } from "./store.js";
import { stepRoomScheduler, type RoomCommand, type RoomEvent } from "./scheduler.js";
import { writeRoomArtifact } from "./artifact.js";

/** Transcript cap for wire snapshots; the on-disk record stays complete (§8.3). */
const WIRE_TRANSCRIPT_LIMIT = 2000;
const WIRE_TRANSCRIPT_TAIL = 500;

/** Partial push throttle (design §6.4). */
const PARTIAL_FLUSH_INTERVAL_MS = 300;
const PARTIAL_TEXT_MAX_CHARS = 8000;
/** room_update latency probe threshold (design §12 risk 1). */
const ROOM_UPDATE_DELAY_WARN_MS = 500;

/**
 * Workspace-relative parent of the summary artifact: the room files root every
 * member writes its own subdirectory into (design §8.1).
 */
function roomFilesDirOf(artifactPath: string): string {
  const segments = artifactPath.split(/[/\\]/u);
  segments.pop();
  return segments.length > 0 ? segments.join("/") : ".";
}

/** The slice of AgentManager the room service is allowed to touch. */
export type RoomAgentManager = Pick<
  AgentManager,
  | "createAgent"
  | "runAgent"
  | "streamAgent"
  | "cancelAgentRun"
  | "archiveAgent"
  | "unarchiveSnapshot"
  | "getAgent"
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
    displayName?: string;
    roleId?: string;
  }>;
  artifactPath: string;
  limits?: Partial<RoomLimits>;
}

export interface AddRoomMemberInput {
  provider: string;
  model?: string | null;
  modeId?: string | null;
  persona: string;
  displayName?: string;
  roleId?: string;
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
  /** In-flight moderator run per room; checkpoints run one at a time (§4 fix). */
  private readonly moderatorRuns = new Map<string, Promise<void>>();
  /**
   * Identity of the latest ask_moderator dispatch per room (design §7.7).
   * Each dispatch overwrites; the reply must match the current entry or it is
   * a stale run whose checkpoint slot a newer dispatch already took. Cleared
   * in runModerator's finally; in-memory only, so a daemon restart starts
   * from an empty (consistent) table.
   */
  private readonly checkpointRunIds = new Map<string, string>();
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();
  private readonly latest = new Map<string, RoomRecord>();
  /** Last room files fingerprint per room for the turn-prompt diff (design §8.2). */
  private readonly roomFilesSnapshots = new Map<string, string>();
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
    // Mirror the wire schema's member cap (room.create min(2).max(6)); RPC
    // requests are validated there, but direct service callers skip that layer.
    if (input.members.length < 2 || input.members.length > 6) {
      throw new Error(`Room requires 2 to 6 members, got ${input.members.length}`);
    }
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
      // New rooms speak the v2 prompt contract; rooms on disk keep v1 and the
      // legacy templates (design §5.3, 功能2 §7.1).
      promptVersion: 2,
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
        ...(member.displayName ? { displayName: member.displayName } : {}),
        ...(member.roleId ? { roleId: member.roleId } : {}),
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

  async get(roomId: string): Promise<{ room: RoomRecord | null; truncated: boolean }> {
    const record = await this.store.get(roomId);
    if (!record) return { room: null, truncated: false };
    return this.snapshotForWire(record);
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
      if (
        record.status === "forming" ||
        record.status === "opening" ||
        record.status === "closed"
      ) {
        throw new Error(`Room is ${record.status}; interject is not allowed`);
      }
      const event: RoomEvent = {
        type: "interjection_queued",
        at: this.stamp(),
        interjectionId: `int_${randomUUID().slice(0, 8)}`,
        text,
      };
      return this.applyStep(record, event);
    });
  }

  /**
   * Mid-room member join (design §7.2). Runs in the per-room queue; the
   * persistence-capability probe happens BEFORE any roster change so a
   * provider that cannot persist never leaves a failed seat behind.
   */
  async addMember(roomId: string, input: AddRoomMemberInput): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      // v1 rooms never upgrade (reopen keeps promptVersion, §5.3) and the whole
      // join mechanism is bound to the v2 contract; refuse instead of injecting
      // v2 behavior into a legacy room (§7.2.1 third patch).
      if (record.promptVersion < 2) {
        throw new Error(
          `Room ${roomId}: 该房间由旧版本创建（promptVersion ${record.promptVersion}），请新建房间以使用中途加人`,
        );
      }
      if (record.status !== "discussing" && record.status !== "interrupted") {
        throw new Error(
          `Room is ${record.status}; members can only join while discussing or interrupted`,
        );
      }
      if (record.members.length >= 6) {
        throw new Error(`Room already has ${record.members.length} members; the maximum is 6`);
      }
      const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
      if (!workspaceDirectory) {
        throw new Error(`Workspace ${record.workspaceId} not found`);
      }
      // Member ids are monotonic and members are never removed, so the id is
      // deterministic before the probe; the system prompt bakes it in.
      const memberId = `member_${record.members.length + 1}`;
      const draft: RoomMember = {
        id: memberId,
        agentId: null,
        provider: input.provider,
        model: input.model ?? null,
        modeId: input.modeId ?? null,
        persona: input.persona,
        status: "pending",
        joinedAt: this.stamp(),
        lastDeliveredSeq: record.lastSeq,
        turnCount: 0,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.roleId ? { roleId: input.roleId } : {}),
        catchUpPending: true,
      };
      const agent = await this.options.agentManager.createAgent(
        this.memberConfig(
          draft,
          workspaceDirectory,
          buildMemberSystemPrompt({
            promptVersion: record.promptVersion,
            roomName: record.name,
            member: draft,
            filesDir: roomFilesDirOf(record.artifactPath),
          }),
        ),
        undefined,
        {
          workspaceId: record.workspaceId,
          labels: { [ROOM_ID_LABEL]: roomId },
          initialTitle: roomMemberAgentTitle(draft, record.name),
        },
      );
      if (!agent.capabilities.supportsSessionPersistence) {
        // Roll the probe agent back; the roster was never touched.
        await this.archiveRollback(agent.id);
        throw new Error(`Provider ${draft.provider} does not support session persistence`);
      }
      const member: RoomMember = { ...draft, agentId: agent.id, status: "ready" };
      try {
        return await this.applyStep(
          { ...record, members: [...record.members, member] },
          { type: "member_added", at: this.stamp(), memberId },
        );
      } catch (error) {
        // Persisting the roster failed: roll the agent back so nothing leaks.
        await this.archiveRollback(agent.id);
        throw error;
      }
    });
  }

  /** Files of the room's files directory for `room.files.list` (design §8.4). */
  async listFiles(roomId: string): Promise<RoomFileEntry[]> {
    const record = await this.store.get(roomId);
    if (!record) throw new Error(`Room ${roomId} not found`);
    const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
    if (!workspaceDirectory) {
      throw new Error(`Workspace ${record.workspaceId} not found`);
    }
    return listRoomFiles({
      workspaceDirectory,
      roomFilesDir: roomFilesDirOf(record.artifactPath),
      memberIds: record.members.map((member) => member.id),
    });
  }

  async close(roomId: string): Promise<RoomRecord> {
    return this.serialize(roomId, async () => {
      const record = await this.requireRoom(roomId);
      if (record.status === "closed") return record; // Idempotent (§8.4).
      if (!record.moderator.agentId) {
        // Nothing can produce a summary; close immediately.
        return this.finalizeClose(record, "closed before start");
      }
      if (record.status === "closing" && record.summary) {
        // The user confirmed the summary: persist the artifact, then archive.
        return this.finalizeClose(record, "closed by user");
      }
      // opening/discussing/interrupted: begin closing and ask for a summary.
      // closing without a summary (in flight or lost): re-ask so the room heals.
      return this.applyStep(record, { type: "user_close", at: this.stamp() });
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
    assertInsideWorkspaceDirectory(resolve(workspaceDirectory, trimmed), workspaceDirectory);
  }

  // ===========================================================================
  // Scheduler application
  // ===========================================================================

  private async applyStep(record: RoomRecord, event: RoomEvent): Promise<RoomRecord> {
    const next = stepRoomScheduler(record, event);
    return this.applyDirect(next.record, next.commands);
  }

  private async applyDirect(record: RoomRecord, commands: RoomCommand[] = []): Promise<RoomRecord> {
    const persistStartedAt = Date.now();
    this.latest.set(record.id, record);
    await this.store.update(record.id, () => record);
    // room_update latency probe (design §12 risk 1): the whole checkpoint
    // cadence rides on this write finishing before the broadcast, so log
    // outliers to locate the reported sporadic lag.
    const persistedMs = Date.now() - persistStartedAt;
    if (persistedMs >= ROOM_UPDATE_DELAY_WARN_MS) {
      this.options.logger.warn(
        { roomId: record.id, persistedMs },
        "room_update delayed by a slow room store write",
      );
    }
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
        case "create_member": {
          // Self-heal / backfill path; the normal addMember flow pre-creates
          // the agent, so ensureMember is a no-op there (design §7.3).
          const withAgent = await this.ensureMember(record, command.memberId);
          if (withAgent !== record) await this.applyDirect(withAgent);
          return;
        }
        case "ask_moderator":
          // Long-running: runs outside the queue and feeds its result back as an
          // event. Serialized per room: a second checkpoint racing an in-flight
          // run would fail AgentManager's active-run guard and feed a fallback
          // decision while the first run's late reply also lands, breaking the
          // one-turn-at-a-time invariant (2026-10-25 acceptance §4).
          // The dispatch id is the root fix for the racing-reply class (§7.7):
          // a late reply whose dispatch was superseded is dropped at the
          // backfill boundary instead of being guessed at by the reducer.
          const checkpointRunId = `cpt_${randomUUID().slice(0, 8)}`;
          this.checkpointRunIds.set(roomId, checkpointRunId);
          this.queueModeratorRun(roomId, command.checkpoint, checkpointRunId);
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
    // Every agent this pass creates; a persistence-check failure archives all
    // of them so a bad provider choice never leaks agent records (§7.2.1).
    // The moderator is not probed (its runs degrade deterministically, §7.2.1)
    // but is rolled back with the rest when a member fails the probe.
    const createdAgentIds: string[] = [];
    try {
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
            initialTitle: roomModeratorAgentTitle(next.name),
          },
        );
        createdAgentIds.push(agent.id);
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
            buildMemberSystemPrompt({
              promptVersion: next.promptVersion,
              roomName: next.name,
              member,
              filesDir: roomFilesDirOf(next.artifactPath),
            }),
          ),
          undefined,
          {
            workspaceId: next.workspaceId,
            labels: { [ROOM_ID_LABEL]: next.id },
            initialTitle: roomMemberAgentTitle(member, next.name),
          },
        );
        createdAgentIds.push(agent.id);
        if (!agent.capabilities.supportsSessionPersistence) {
          // Same probe and verdict as addMember (§7.2 step 2); the room record
          // was never written, so archiving the created agents is the whole
          // rollback. Members stay pending; retry start with another provider.
          throw new Error(
            `Provider ${member.provider} does not support session persistence (member ${member.id})`,
          );
        }
        members[index] = { ...member, agentId: agent.id, status: "ready" };
      }
      return { ...next, members };
    } catch (error) {
      for (const agentId of createdAgentIds) {
        await this.archiveRollback(agentId);
      }
      throw error;
    }
  }

  /**
   * Create the agent for one member that joined mid-room (design §7.3).
   * Idempotent: members added through addMember already carry an agentId, so
   * the create_member command skips straight past them.
   */
  private async ensureMember(record: RoomRecord, memberId: string): Promise<RoomRecord> {
    const index = record.members.findIndex((entry) => entry.id === memberId);
    if (index === -1) return record;
    const member = record.members[index]!;
    if (member.agentId) return record;
    const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
    if (!workspaceDirectory) {
      throw new Error(`Workspace ${record.workspaceId} not found`);
    }
    const agent = await this.options.agentManager.createAgent(
      this.memberConfig(
        member,
        workspaceDirectory,
        buildMemberSystemPrompt({
          promptVersion: record.promptVersion,
          roomName: record.name,
          member,
          filesDir: roomFilesDirOf(record.artifactPath),
        }),
      ),
      undefined,
      {
        workspaceId: record.workspaceId,
        labels: { [ROOM_ID_LABEL]: record.id },
        initialTitle: roomMemberAgentTitle(member, record.name),
      },
    );
    if (!agent.capabilities.supportsSessionPersistence) {
      // Same probe and verdict as addMember / ensureAgents (§7.2.1): the
      // self-heal path fails loudly here instead of at the member's first
      // turn; the roster entry was already applied, so only the probe agent
      // needs rolling back. The command error keeps the member pending.
      await this.archiveRollback(agent.id);
      throw new Error(
        `Provider ${member.provider} does not support session persistence (member ${member.id})`,
      );
    }
    const members = [...record.members];
    members[index] = { ...member, agentId: agent.id, status: "ready" };
    return { ...record, members };
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

  /**
   * Roll a rollback-path agent back; a failed archive logs instead of
   * swallowing silently so leaked agent records stay visible (§7.2.1 P1-5).
   */
  private async archiveRollback(agentId: string): Promise<void> {
    await this.options.agentManager.archiveAgent(agentId).catch((err: unknown) => {
      this.options.logger.warn(
        { err, agentId },
        "archiveAgent rollback failed; agent record leaked",
      );
    });
  }

  private collectAgentIds(record: RoomRecord): string[] {
    return [record.moderator.agentId, ...record.members.map((member) => member.agentId)].filter(
      (agentId): agentId is string => typeof agentId === "string",
    );
  }

  // ===========================================================================
  // Moderator + member turns
  // ===========================================================================

  /**
   * Run moderator checkpoints one at a time per room. ask_moderator commands
   * are fire-and-forget, so without this chain an interjection checkpoint
   * (queued while no speaker is active) could start while the previous
   * round_end run is still streaming: the new run fails AgentManager's
   * active-run guard and applies the deterministic fallback, and the first
   * run's late reply then also lands — two moderator_checkpoint_ready events
   * for one checkpoint, each free to start a member turn (2026-10-25
   * acceptance §4). Serializing lets the second checkpoint read fresh state
   * and get a real moderator decision instead of the fallback.
   */
  private queueModeratorRun(
    roomId: string,
    checkpoint: "opening" | "round_end" | "interjection" | "summary",
    checkpointRunId: string,
  ): void {
    const previous = this.moderatorRuns.get(roomId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.runModerator(roomId, checkpoint, checkpointRunId));
    const tail = run.catch(() => undefined);
    this.moderatorRuns.set(roomId, tail);
    void tail.finally(() => {
      if (this.moderatorRuns.get(roomId) === tail) this.moderatorRuns.delete(roomId);
    });
    run.catch((error) => {
      this.options.logger.error({ err: error, roomId }, "Moderator task failed");
    });
  }

  /**
   * Races a moderator run against the turn timeout (R8: an unresponsive
   * provider used to block the room's pendingCheckpoint forever). A hung run
   * is cancelled so the agent's active-run slot frees for the next checkpoint;
   * the timeout rejection flows into the caller's deterministic fallback.
   */
  private async runModeratorAgent(
    agentId: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ finalText: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.options.agentManager.runAgent(agentId, prompt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.options.agentManager.cancelAgentRun(agentId).catch(() => undefined);
            reject(new Error(`moderator run timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runModerator(
    roomId: string,
    checkpoint: "opening" | "round_end" | "interjection" | "summary",
    checkpointRunId: string,
  ): Promise<void> {
    try {
      const record = await this.store.get(roomId);
      if (!record?.moderator.agentId) {
        return;
      }
      // Snapshot of the interjections this prompt actually lists (§4.6.1):
      // the reply may only settle these entries, never interjections that
      // queue while the run is in flight.
      const interjectionIds = record.interjections
        .filter((entry) => entry.status === "queued")
        .map((entry) => entry.id);
      let prompt = buildCheckpointPrompt({
        round: record.round.index,
        turnCount: record.turn.index,
        roster: buildRosterText(record),
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
        const result = await this.runModeratorAgent(
          record.moderator.agentId,
          prompt,
          record.limits.turnTimeoutMs,
        );
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
          await this.applyStep(current, {
            type: "moderator_summary_ready",
            at: this.stamp(),
            summary,
          });
        });
        // The room now sits in closing with the summary visible; the user
        // confirms by calling close() again (design §3.6).
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

      // Backfill boundary match (§7.7): the only place holding both the
      // dispatch id and the reply. A mismatch means a newer dispatch already
      // took the checkpoint slot — warn and drop before the reducer ever sees
      // the event. Covers the fallback reply of a failed run too (it flows
      // through the same decision path below).
      const expectedRunId = this.checkpointRunIds.get(roomId);
      if (checkpointRunId !== expectedRunId) {
        this.options.logger.warn(
          { roomId, checkpoint, checkpointRunId, expectedRunId },
          "Dropping stale moderator checkpoint reply (checkpointRunId mismatch)",
        );
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
        checkpointRunId,
        interjectionIds,
      });
    } finally {
      // Bindings live exactly as long as their run: cleanup stays in the
      // finally scope so early returns, thrown errors and the mismatch drop
      // all release the entry. A superseding dispatch has already overwritten
      // the slot, so the identity check keeps its binding intact.
      if (this.checkpointRunIds.get(roomId) === checkpointRunId) {
        this.checkpointRunIds.delete(roomId);
      }
    }
  }

  private async runMemberTurn(roomId: string, memberId: string): Promise<void> {
    const record = await this.store.get(roomId);
    if (!record || record.status !== "discussing") return;
    const member = record.members.find((entry) => entry.id === memberId);
    if (!member?.agentId) return;
    const prompt = await this.buildMemberPrompt(record, member);

    const timer = setTimeout(() => {
      void this.serializeFeed(roomId, { type: "turn_timeout", at: this.stamp() }).catch(
        () => undefined,
      );
    }, record.limits.turnTimeoutMs);
    this.turnTimers.set(roomId, timer);

    // Partial streaming state (design §6.2/§6.4). Pure memory: the buffer
    // always equals the trailing assistant segment, so the settled text
    // matches getLastAssistantMessageSegmentFromTimeline. Both timers die
    // with this consumption loop.
    let partialText = "";
    let toolCalls = 0;
    let dirty = false;
    let firstFlushSent = false;
    const flushInterval = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      this.sendPartial(roomId, memberId, partialText, toolCalls, false);
    }, PARTIAL_FLUSH_INTERVAL_MS);
    const requestPartial = (text: string): void => {
      partialText = text;
      dirty = true;
      if (!firstFlushSent && text.length > 0) {
        // The first visible character flushes immediately (design §6.4).
        firstFlushSent = true;
        dirty = false;
        this.sendPartial(roomId, memberId, text, toolCalls, false);
      }
    };

    let event: RoomEvent;
    try {
      let canceled = false;
      const ingestTimelineItem = (item: AgentTimelineItem): void => {
        if (item.type === "assistant_message") {
          // Each item text is an incremental chunk of the statement.
          requestPartial(partialText + item.text);
          return;
        }
        // Reset on any non-assistant item with a non-empty buffer so the
        // buffer stays the trailing assistant segment; tool calls feed
        // the researching transient line (design §6.5).
        if (partialText.length > 0) {
          requestPartial("");
        }
        if (item.type === "tool_call") toolCalls += 1;
      };
      try {
        for await (const streamEvent of this.options.agentManager.streamAgent(
          member.agentId,
          prompt,
        )) {
          if (streamEvent.type === "timeline") {
            ingestTimelineItem(streamEvent.item);
          } else if (streamEvent.type === "turn_failed") {
            const message = streamEvent.error.trim();
            throw new Error(message.length > 0 ? message : "Provider run failed");
          } else if (streamEvent.type === "turn_canceled") {
            canceled = true;
          }
        }
      } finally {
        clearTimeout(timer);
        this.turnTimers.delete(roomId);
        clearInterval(flushInterval);
      }
      // Terminal flush closes the client's streaming row exactly once.
      this.sendPartial(roomId, memberId, partialText, toolCalls, true);
      if (canceled) {
        // Whoever cancelled (timeout, pause, close) already settled the scheduler.
        return;
      }
      event = {
        type: "member_turn_completed",
        at: this.stamp(),
        memberId,
        text: partialText,
      };
    } catch (error) {
      this.sendPartial(roomId, memberId, partialText, toolCalls, true);
      event = {
        type: "member_turn_failed",
        at: this.stamp(),
        memberId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await this.serializeFeed(roomId, event);
  }

  /**
   * Turn prompt for a member: catch-up first turn for late joiners, otherwise
   * the regular turn prompt with the new-files section (design §7.5, §8.2).
   */
  private async buildMemberPrompt(record: RoomRecord, member: RoomMember): Promise<string> {
    if (member.catchUpPending) {
      return this.buildCatchupPrompt(record);
    }
    const newFiles = await this.collectNewFilesSection(record);
    return buildMemberTurnPrompt({
      record,
      member,
      moderatorNote: null,
      retryReason: record.turn.attempt > 0 ? "previous attempt failed" : null,
      newFiles,
    });
  }

  /** Catch-up first-turn prompt: full transcript plus the file manifest (§7.5). */
  private async buildCatchupPrompt(record: RoomRecord): Promise<string> {
    const transcriptText = buildHumanizedTranscript(record);
    let history = transcriptText;
    if (transcriptText.length > record.limits.deltaCharBudget) {
      history = await this.summarizeTranscriptForCatchup(record, transcriptText);
    }
    return buildCatchupTurnPrompt({
      roomName: record.name,
      topic: record.topic,
      transcriptText: history,
      fileManifest: await this.roomFilesManifest(record),
    });
  }

  /**
   * Over-budget catch-up: a one-shot moderator digest followed by the newest
   * half-budget slice of the transcript. The digest never enters the room
   * transcript or the wire (design §7.5).
   */
  private async summarizeTranscriptForCatchup(
    record: RoomRecord,
    transcriptText: string,
  ): Promise<string> {
    const tailChars = Math.floor(record.limits.deltaCharBudget / 2);
    const tail = transcriptText.slice(Math.max(0, transcriptText.length - tailChars));
    const moderatorAgentId = record.moderator.agentId;
    if (!moderatorAgentId) return tail;
    try {
      const result = await this.runModeratorAgent(
        moderatorAgentId,
        buildCatchupSummaryPrompt(transcriptText),
        record.limits.turnTimeoutMs,
      );
      const summary = result.finalText.trim();
      return summary.length > 0 ? `${summary}\n\n${tail}` : tail;
    } catch (error) {
      this.options.logger.warn(
        { err: error, roomId: record.id },
        "Catch-up summary run failed; injecting the transcript tail only",
      );
      return tail;
    }
  }

  /** Current file manifest for catch-up prompts; listing failures degrade to empty. */
  private async roomFilesManifest(record: RoomRecord): Promise<string> {
    const entries = await this.readRoomFiles(record);
    return formatRoomFilesManifest(entries ?? []);
  }

  /**
   * List the room's files and diff against the per-room snapshot; returns the
   * manifest text only when something changed since the last turn (§8.2).
   */
  private async collectNewFilesSection(record: RoomRecord): Promise<string | null> {
    const entries = await this.readRoomFiles(record);
    if (!entries) return null;
    const fingerprint = JSON.stringify(entries);
    const previous = this.roomFilesSnapshots.get(record.id);
    this.roomFilesSnapshots.set(record.id, fingerprint);
    if (previous === fingerprint || entries.length === 0) return null;
    return formatRoomFilesManifest(entries);
  }

  private async readRoomFiles(record: RoomRecord): Promise<RoomFileEntry[] | null> {
    const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
    if (!workspaceDirectory) return null;
    try {
      return await listRoomFiles({
        workspaceDirectory,
        roomFilesDir: roomFilesDirOf(record.artifactPath),
        memberIds: record.members.map((entry) => entry.id),
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, roomId: record.id },
        "Room files listing failed; continuing without the manifest",
      );
      return null;
    }
  }

  /** Push a `room_partial_update` straight through the broadcast channel (§6.3). */
  private sendPartial(
    roomId: string,
    memberId: string,
    text: string,
    toolCalls: number,
    done: boolean,
  ): void {
    const clipped =
      text.length > PARTIAL_TEXT_MAX_CHARS ? `${text.slice(0, PARTIAL_TEXT_MAX_CHARS)}…` : text;
    this.options.broadcast({
      type: "room_partial_update",
      payload: { roomId, memberId, text: clipped, toolCalls, done },
    });
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
    if (record.summary !== null) {
      // Persist the artifact before archiving. On failure the room stays in
      // closing and the error propagates to the caller — never render a room
      // closed whose summary file was never written (design §3.6, §5.5).
      const workspaceDirectory = await this.options.resolveWorkspaceDirectory(record.workspaceId);
      if (!workspaceDirectory) {
        throw new Error(`Workspace ${record.workspaceId} not found`);
      }
      await writeRoomArtifact({
        workspaceDirectory,
        artifactPath: record.artifactPath,
        summary: record.summary,
      });
    }
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

  /**
   * Wire snapshot of a record: attaches each member's live lastUsage from
   * AgentManager and caps the transcript for the wire (§8.1, §8.3). The
   * on-disk record keeps the full transcript and no usage.
   */
  private snapshotForWire(record: RoomRecord): { room: RoomRecord; truncated: boolean } {
    const members = record.members.map((member) =>
      member.agentId
        ? { ...member, lastUsage: this.options.agentManager.getAgent(member.agentId)?.lastUsage }
        : member,
    );
    if (record.transcript.length <= WIRE_TRANSCRIPT_LIMIT) {
      return { room: { ...record, members }, truncated: false };
    }
    return {
      room: { ...record, members, transcript: record.transcript.slice(-WIRE_TRANSCRIPT_TAIL) },
      truncated: true,
    };
  }

  private broadcast(record: RoomRecord): void {
    const { room, truncated } = this.snapshotForWire(record);
    this.options.broadcast({ type: "room_update", payload: { room, truncated } });
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
