import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, afterEach, test, vi } from "vitest";
import {
  SessionOutboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { ROOM_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type pino from "pino";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { RoomService, type CreateRoomInput } from "./service.js";
import { RoomStore } from "./store.js";
import { MOCK_SLOW_PROVIDER_ID } from "../agent/providers/mock-slow-provider.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForRoom(
  service: RoomService,
  roomId: string,
  until: (room: { status: string }) => boolean,
  timeoutMs = 8000,
): Promise<NonNullable<Awaited<ReturnType<RoomService["get"]>>["room"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { room } = await service.get(roomId);
    if (room && until(room)) return room;
    if (Date.now() > deadline) throw new Error(`timed out waiting for room ${roomId}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

/** Poll until the probe returns a truthy value; returns that value. */
async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function hasMemberUsage(updates: SessionOutboundMessage[]): boolean {
  for (const update of updates) {
    if (update.type !== "room_update") continue;
    for (const member of update.payload.room.members) {
      if (member.lastUsage !== undefined) return true;
    }
  }
  return false;
}

/** Transcript predicates for waitForRoom, kept top-level to limit nesting. */
function hasMemberEntry(room: { transcript: Array<{ kind: string }> }): boolean {
  return room.transcript.some((entry) => entry.kind === "member");
}

function hasTwoMemberEntries(room: { transcript: Array<{ kind: string }> }): boolean {
  return room.transcript.filter((entry) => entry.kind === "member").length >= 2;
}

function hasJoinerStatement(room: {
  transcript: Array<{ kind: string; memberId?: string | null; text: string }>;
}): boolean {
  return room.transcript.some(
    (entry) => entry.kind === "member" && entry.memberId === "member_1" && entry.text === "补充B",
  );
}

/** Partial pushes for one member, in arrival order. */
function partialUpdatesFor(
  updates: SessionOutboundMessage[],
  memberId: string,
): Array<Extract<SessionOutboundMessage, { type: "room_partial_update" }>> {
  return updates.filter(
    (update): update is Extract<SessionOutboundMessage, { type: "room_partial_update" }> =>
      update.type === "room_partial_update" && update.payload.memberId === memberId,
  );
}

function hasSystemEntry(room: { transcript: Array<{ kind: string; text: string }> }): boolean {
  return room.transcript.some(
    (entry) => entry.kind === "system" && entry.text.includes("Member member_1 failed"),
  );
}

function hasMemberOneStatement(room: {
  transcript: Array<{ kind: string; memberId?: string | null }>;
}): boolean {
  return room.transcript.some((entry) => entry.kind === "member" && entry.memberId === "member_1");
}

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function memberIdFromPrompt(config: AgentSessionConfig): string | null {
  const systemPrompt = config.systemPrompt ?? "";
  // v2 system prompt (design §5.3) first, then the legacy v1 wording.
  return (
    /名字：(member_\d+)/.exec(systemPrompt)?.[1] ??
    /You are member (member_\d+)/.exec(systemPrompt)?.[1] ??
    null
  );
}

/** Round index from a member turn prompt marker (v2 then v1). */
function memberTurnRound(prompt: string): number | null {
  return (
    Number(/\[第 (\d+) 轮｜/.exec(prompt)?.[1]) ||
    Number(/\[round (\d+) \|/.exec(prompt)?.[1]) ||
    null
  );
}

function isCheckpointPrompt(prompt: string): boolean {
  return prompt.includes("Decide the next step");
}

/** All checkpoint prompts the moderator sessions received, in arrival order. */
function moderatorCheckpointPrompts(client: ScriptedRoomClient): string[] {
  return client.sessions
    .filter((session) => session.memberId === null)
    .flatMap((session) => session.prompts)
    .filter((prompt) => isCheckpointPrompt(prompt));
}

/** The Pending-interjections section of a checkpoint prompt (empty when absent). */
function pendingInterjectionsSection(prompt: string): string {
  return prompt.split("Pending user interjections:")[1] ?? "";
}

/** When to hold a member turn open inside ScriptedRoomSession. */
interface HoldTurnsSpec {
  /** First round whose member turns hold on the gate (default 1 = all). */
  fromRound: number;
  /** Restrict the hold to these member ids; undefined holds every member. */
  memberIds?: string[];
}

/** Scripted session: moderator answers JSON, members answer a fixed statement. */
class ScriptedRoomSession implements AgentSession {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  interruptCount = 0;
  private turnCounter = 0;
  turnStarted = false;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  readonly memberId: string | null;
  /** Turn interrupted by the harness; its late tail events are suppressed. */
  private cancelledTurnId: string | null = null;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly holdTurn: Deferred<void> | null,
    private readonly streaming: boolean,
    private readonly failMemberTurns: boolean,
    provider: string,
    capabilities: AgentCapabilityFlags,
    private readonly holdCheckpoint: Deferred<void> | null = null,
    private readonly holdTurns: HoldTurnsSpec = { fromRound: 1 },
    private readonly answerUserCheckpoints = false,
  ) {
    this.provider = provider as AgentSession["provider"];
    // The manager stamps the agent record from session capabilities, so the
    // client's flag set must flow through here.
    this.capabilities = capabilities;
    this.memberId = memberIdFromPrompt(config);
  }

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnStarted = true;
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    const turnId = `turn-${this.id}-${++this.turnCounter}`;
    const text = typeof prompt === "string" ? prompt : "";
    void (async () => {
      // Defer like real providers: events must arrive after the manager's waiter is set up.
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      if (this.holdCheckpoint && isCheckpointPrompt(text)) {
        await this.holdCheckpoint.promise;
      }
      const round = memberTurnRound(text);
      if (
        this.holdTurn &&
        round !== null &&
        round >= this.holdTurns.fromRound &&
        (!this.holdTurns.memberIds ||
          (this.memberId !== null && this.holdTurns.memberIds.includes(this.memberId)))
      ) {
        await this.holdTurn.promise;
      }
      if (this.cancelledTurnId === turnId) {
        // Interrupted while held: a real provider emits nothing further.
        return;
      }
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      if (this.streaming && this.memberId) {
        if (this.failMemberTurns) {
          // Member turns fail on every attempt (scheduler retries once).
          this.pushEvent({
            type: "turn_failed",
            provider: this.provider,
            error: "provider exploded",
            turnId,
          });
          return;
        }
        // Choreographed member turn: text, a tool call (resets the partial
        // buffer), then text again after one 300ms-cycle flush window.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "结论A" },
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "tool_call",
            status: "completed",
            callId: `call-${this.id}-${this.turnCounter}`,
            name: "read_file",
            detail: { type: "read", filePath: "notes/api.md" },
            error: null,
          },
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "补充B" },
        });
        this.pushEvent({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: { inputTokens: 100, outputTokens: 50 },
        });
        return;
      }
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: this.scriptReply(text) },
      });
      this.pushEvent({
        type: "turn_completed",
        provider: this.provider,
        turnId,
        // Member turns report usage so the wire snapshot can carry it (§8.1).
        ...(this.memberId ? { usage: { inputTokens: 100, outputTokens: 50 } } : {}),
      });
    })();
    return { turnId };
  }

  private scriptReply(prompt: string): string {
    if (prompt.includes('Reply with JSON: {"opening"')) {
      return '{"opening":"开场白","action":"continue","nextMemberId":null}';
    }
    if (prompt.includes("Decide the next step")) {
      const round = Number(/round (\d+)/.exec(prompt)?.[1] ?? 1);
      if (round < 2 && this.answerUserCheckpoints) {
        // Scripted interjection reply: settle the user directly (§4.6.1 tests).
        return '{"action":"answer_user","reason":"reply","userReply":"收到","nextMemberId":null}';
      }
      return round >= 2
        ? '{"action":"finish","reason":"done"}'
        : '{"action":"continue","nextMemberId":null}';
    }
    if (prompt.includes("Write the conclusion")) return "## 最终结论";
    return `statement from ${this.memberId ?? "member"}`;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    const turnId = `turn-${this.id}-${this.turnCounter}`;
    this.cancelledTurnId = turnId;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      reason: "Interrupted",
      turnId,
    });
  }

  async close(): Promise<void> {}
}

class ScriptedRoomClient implements AgentClient {
  readonly provider: string;
  readonly capabilities: typeof CAPABILITIES;
  readonly configs: AgentSessionConfig[] = [];
  readonly sessions: ScriptedRoomSession[] = [];

  constructor(
    private readonly logger: pino.Logger,
    private readonly holdTurn: Deferred<void> | null,
    options?: {
      provider?: string;
      capabilities?: Partial<typeof CAPABILITIES>;
      streaming?: boolean;
      failMemberTurns?: boolean;
      holdCheckpoint?: Deferred<void> | null;
      holdTurns?: HoldTurnsSpec;
      answerUser?: boolean;
    },
  ) {
    this.provider = options?.provider ?? "codex";
    this.capabilities = { ...CAPABILITIES, ...options?.capabilities };
    this.streaming = options?.streaming ?? false;
    this.failMemberTurns = options?.failMemberTurns ?? false;
    this.holdCheckpoint = options?.holdCheckpoint ?? null;
    this.holdTurns = options?.holdTurns ?? { fromRound: 1 };
    this.answerUserCheckpoints = options?.answerUser ?? false;
  }

  private readonly streaming: boolean;
  private readonly failMemberTurns: boolean;
  private readonly holdCheckpoint: Deferred<void> | null;
  private readonly holdTurns: HoldTurnsSpec;
  private readonly answerUserCheckpoints: boolean;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.configs.push(config);
    const session = new ScriptedRoomSession(
      config,
      this.holdTurn,
      this.streaming,
      this.failMemberTurns,
      this.provider,
      this.capabilities,
      this.holdCheckpoint,
      this.holdTurns,
      this.answerUserCheckpoints,
    );
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("not implemented");
  }
}

describe("RoomService with a scripted provider", () => {
  let workDir: string;
  let roomsDir: string;
  let agentsDir: string;
  let logger: pino.Logger;

  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of cleanup.toReversed()) await dispose();
    cleanup.length = 0;
  });

  async function buildService(
    holdTurn: Deferred<void> | null,
    options?: {
      streaming?: boolean;
      withNonPersistentProvider?: boolean;
      failMemberTurns?: boolean;
      holdCheckpoint?: Deferred<void> | null;
      holdTurns?: HoldTurnsSpec;
      answerUser?: boolean;
    },
  ) {
    workDir = await mkdtemp(join(tmpdir(), "room-service-ws-"));
    roomsDir = await mkdtemp(join(tmpdir(), "room-service-rooms-"));
    agentsDir = await mkdtemp(join(tmpdir(), "room-service-agents-"));
    logger = createTestLogger();
    const storage = new AgentStorage(agentsDir, logger);
    await storage.initialize();
    const client = new ScriptedRoomClient(logger, holdTurn, {
      streaming: options?.streaming,
      failMemberTurns: options?.failMemberTurns,
      holdCheckpoint: options?.holdCheckpoint,
      holdTurns: options?.holdTurns,
      answerUser: options?.answerUser,
    });
    const clients: Record<string, AgentClient> = { codex: client };
    if (options?.withNonPersistentProvider) {
      // Mirrors mock-slow-provider (supportsSessionPersistence: false) without
      // the PASEO_ENABLE_MOCK_SLOW env gate.
      clients[MOCK_SLOW_PROVIDER_ID] = new ScriptedRoomClient(logger, null, {
        provider: MOCK_SLOW_PROVIDER_ID,
        capabilities: { supportsSessionPersistence: false },
      });
    }
    const agentManager = new AgentManager({
      clients,
      logger,
      registry: storage,
    });
    const updates: SessionOutboundMessage[] = [];
    const invalidUpdates: unknown[] = [];
    const service = new RoomService({
      roomsDir,
      logger,
      agentManager,
      broadcast: (message) => {
        const parsed = SessionOutboundMessageSchema.safeParse(message);
        if (parsed.success) updates.push(parsed.data);
        else invalidUpdates.push(message);
      },
      resolveWorkspaceDirectory: () => Promise.resolve(workDir),
    });
    cleanup.push(async () => {
      await rm(workDir, { recursive: true, force: true });
      await rm(roomsDir, { recursive: true, force: true });
      await rm(agentsDir, { recursive: true, force: true });
    });
    return { service, client, agentManager, storage, updates, invalidUpdates };
  }

  function createInput(): CreateRoomInput {
    return {
      workspaceId: "ws_1",
      name: "架构评审",
      topic: "选一个消息队列",
      moderator: { provider: "codex" },
      members: [
        { provider: "codex", persona: "可靠性" },
        { provider: "codex", persona: "成本" },
        { provider: "codex", persona: "运维" },
      ],
      artifactPath: "notes/summary.md",
    };
  }

  test("runs 3 members for 2 rounds, parks in closing, then closes on confirmation", async () => {
    const { service, client, storage, updates, invalidUpdates } = await buildService(null);
    const room = await service.create(createInput());

    const started = await service.start(room.id);
    expect(started.status).toBe("opening");
    expect(started.members.map((member) => member.agentId)).toHaveLength(3);

    // Idempotent start while running.
    const again = await service.start(room.id);
    expect(again.id).toBe(room.id);

    // The summary lands and the room parks in closing awaiting the user's
    // confirmation; members stay alive (design §3.6, acceptance §1.3.4).
    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    expect(closing.summary).toContain("最终结论");
    expect(closing.transcript.at(-1)).toMatchObject({ kind: "moderator", text: "## 最终结论" });
    expect(closing.members.every((member) => member.status !== "archived")).toBe(true);

    const closed = await service.close(room.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedReason).toBe("closed by user");
    const memberEntries = closed.transcript.filter((entry) => entry.kind === "member");
    expect(memberEntries).toHaveLength(6);
    for (const member of closed.members) {
      expect(member.turnCount).toBe(2);
      expect(member.status).toBe("archived");
    }
    expect(closed.round.index).toBe(2);

    // The summary artifact landed in the workspace before archiving (§5.5).
    const artifact = await readFile(join(workDir, "notes", "summary.md"), "utf-8");
    expect(artifact).toContain("最终结论");

    // Exactly one moderator + three members were created, all room-labeled.
    expect(client.configs).toHaveLength(4);
    const agentIds = [closed.moderator.agentId, ...closed.members.map((m) => m.agentId)].filter(
      (agentId): agentId is string => typeof agentId === "string",
    );
    for (const agentId of agentIds) {
      const stored = await storage.get(agentId);
      expect(stored?.labels?.[ROOM_ID_LABEL]).toBe(room.id);
    }

    // Every push parses against the wire schema; the record also landed on disk.
    expect(invalidUpdates).toEqual([]);
    expect(updates.length).toBeGreaterThanOrEqual(4);
    expect(updates.at(-1)).toMatchObject({
      type: "room_update",
      payload: { room: { id: room.id } },
    });
    // Wire snapshots carry each member's live lastUsage (§8.1).
    expect(hasMemberUsage(updates)).toBe(true);
    const { room: final } = await service.get(room.id);
    expect(final).toMatchObject({ status: "closed" });
  });

  test("an interjection during a held turn queues without interrupting the speaker", async () => {
    const gate = deferred<void>();
    const { service, client } = await buildService(gate);
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    // Give the first member turn a moment to reach its held startTurn.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    const afterInterject = await service.interject(room.id, "先等等");
    expect(afterInterject.transcript.at(-1)).toMatchObject({
      kind: "interjection",
      text: "先等等",
    });
    expect(
      afterInterject.members.every(
        (member) => member.status === "speaking" || member.status === "ready",
      ),
    ).toBe(true);

    gate.resolve();
    // Wait through the summary so cleanup does not race in-flight writes.
    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    // R9 #1 semantics: the interjection stayed queued through the held turn,
    // was listed exactly once by the round_end checkpoint prompt's Pending
    // section, and settled to delivered when that reply was consumed — never
    // answered (the scripted moderator never answers the user).
    expect(closing.interjections[0]?.status).toBe("delivered");
    expect(closing.interjections[0]?.decidedAt).toBeNull();
    expect(
      moderatorCheckpointPrompts(client).filter((prompt) =>
        pendingInterjectionsSection(prompt).includes("先等等"),
      ),
    ).toHaveLength(1);
  });

  test("restart marks running rooms interrupted; start without resume fails", async () => {
    const gate = deferred<void>();
    const { service } = await buildService(gate);
    const room = await service.create({
      ...createInput(),
      limits: { turnTimeoutMs: 100 },
    });
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    const fresh = new RoomService({
      roomsDir,
      logger,
      agentManager: new AgentManager({
        clients: { codex: new ScriptedRoomClient(logger, null) },
        logger,
      }),
      broadcast: () => undefined,
      resolveWorkspaceDirectory: () => Promise.resolve(workDir),
    });
    await fresh.interruptStaleRooms();
    const { room: interrupted } = await fresh.get(room.id);
    expect(interrupted?.status).toBe("interrupted");

    await expect(fresh.start(room.id)).rejects.toThrow(/resume/);
    // The held turn never resolves; its late timeout is dropped while interrupted.
  });

  test("a cancelled turn after pause feeds no scheduler event", async () => {
    const gate = deferred<void>();
    const { service } = await buildService(gate);
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));

    await service.pause(room.id);
    gate.resolve();
    await new Promise((resolveTick) => setTimeout(resolveTick, 80));

    const { room: paused } = await service.get(room.id);
    expect(paused?.status).toBe("interrupted");
    // The cancelled run must not land as a completed statement or trigger a retry.
    expect(paused?.transcript.filter((entry) => entry.kind === "member")).toHaveLength(0);
  });

  test("a late moderator opening cannot revive an interrupted room", async () => {
    const gate = deferred<void>();
    const { service } = await buildService(gate);
    const room = await service.create({ ...createInput(), limits: { turnTimeoutMs: 120 } });
    await service.start(room.id);
    await new Promise((resolveTick) => setTimeout(resolveTick, 60));

    // Opening still in flight (moderator runs unheld, but a member turn holds).
    await service.pause(room.id);
    gate.resolve();
    await new Promise((resolveTick) => setTimeout(resolveTick, 120));

    const { room: interrupted } = await service.get(room.id);
    expect(interrupted?.status).toBe("interrupted");
  });

  test("rejects artifact paths that escape the workspace", async () => {
    const { service } = await buildService(null);
    const base = createInput();
    await expect(service.create({ ...base, artifactPath: "" })).rejects.toThrow(/required/);
    await expect(service.create({ ...base, artifactPath: "C:\\abs\\path.md" })).rejects.toThrow(
      /workspace-relative/,
    );
    await expect(service.create({ ...base, artifactPath: "../outside.md" })).rejects.toThrow(
      /\.\./,
    );
    const ok = await service.create({ ...base, artifactPath: "notes/summary.md" });
    expect(ok.id).toMatch(/^room_[0-9a-f]{8}$/);
  });

  test("rejects member counts outside 2-6 even when called directly", async () => {
    const { service } = await buildService(null);
    const base = createInput();
    await expect(service.create({ ...base, members: [base.members[0]] })).rejects.toThrow(
      /2 to 6 members, got 1/,
    );
    await expect(
      service.create({
        ...base,
        members: [
          ...base.members,
          { provider: "codex", persona: "性能" },
          { provider: "codex", persona: "安全" },
          { provider: "codex", persona: "数据" },
          { provider: "codex", persona: "测试" },
        ],
      }),
    ).rejects.toThrow(/2 to 6 members, got 7/);
    // A full six-member room is accepted now that the cap moved up.
    const maxed = await service.create({
      ...base,
      members: [
        ...base.members,
        { provider: "codex", persona: "性能" },
        { provider: "codex", persona: "安全" },
        { provider: "codex", persona: "数据" },
      ],
    });
    expect(maxed.members).toHaveLength(6);
  });

  test("a failed artifact write keeps the room closing and surfaces the error", async () => {
    const { service } = await buildService(null);
    const room = await service.create(createInput());
    await service.start(room.id);
    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    expect(closing.summary).toContain("最终结论");

    // Occupy the artifact path with a directory so the atomic write fails.
    await mkdir(join(workDir, "notes", "summary.md"), { recursive: true });
    await expect(service.close(room.id)).rejects.toThrow();

    const { room: still } = await service.get(room.id);
    expect(still?.status).toBe("closing");
    expect(still?.summary).toContain("最终结论");
    expect(still?.members.every((member) => member.status !== "archived")).toBe(true);
  });

  test("rejects interjections outside discussing, closing, and interrupted", async () => {
    const { service } = await buildService(null);
    const room = await service.create(createInput());

    // forming: no discussion to interrupt yet.
    await expect(service.interject(room.id, "hi")).rejects.toThrow(/not allowed/);

    // opening: the moderator opening is still in flight.
    const started = await service.start(room.id);
    expect(started.status).toBe("opening");
    await expect(service.interject(room.id, "hi")).rejects.toThrow(/not allowed/);

    // closed: nothing to add.
    await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    await service.close(room.id);
    await expect(service.interject(room.id, "hi")).rejects.toThrow(/not allowed/);
  });

  test("caps the transcript on the wire past 2000 entries, disk stays complete", async () => {
    const { service, updates } = await buildService(null);
    const room = await service.create(createInput());

    // Pad the stored transcript the way a long-lived room would (§8.3).
    const store = new RoomStore(roomsDir, logger);
    const padded = Array.from({ length: 2001 }, (_, index) => ({
      seq: index + 1,
      at: "2026-10-21T00:00:00.000Z",
      kind: "member" as const,
      memberId: "member_1",
      agentId: null,
      text: `speech-${index + 1}`,
      turnId: null,
    }));
    await store.update(room.id, (current) => ({ ...current, transcript: padded, lastSeq: 2001 }));

    // room.get returns only the last 500 entries with truncated set.
    const { room: fetched, truncated } = await service.get(room.id);
    expect(truncated).toBe(true);
    expect(fetched?.transcript).toHaveLength(500);
    expect(fetched?.transcript[0]).toMatchObject({ seq: 1502 });
    expect(fetched?.transcript.at(-1)).toMatchObject({ seq: 2001 });

    // The broadcast goes through the same cap.
    await service.close(room.id); // forming room closes without a summary
    const lastUpdate = updates.at(-1);
    expect(lastUpdate).toMatchObject({
      type: "room_update",
      payload: { truncated: true, room: { id: room.id } },
    });
    if (lastUpdate?.type === "room_update") {
      expect(lastUpdate.payload.room.transcript).toHaveLength(500);
    }

    // The on-disk record keeps the full transcript.
    const onDisk = await store.get(room.id);
    expect(onDisk?.transcript).toHaveLength(2001);
  });

  test("a turn timeout retries once, then fails the member and moves on", async () => {
    const gate = deferred<void>();
    const { service } = await buildService(gate);
    const room = await service.create({ ...createInput(), limits: { turnTimeoutMs: 60 } });
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    // The held turn times out twice: retry, then the member fails for the round.
    const failed = await waitForRoom(service, room.id, hasSystemEntry);
    expect(failed.members[0]?.status).toBe("failed");
    gate.resolve();
    // Let the room reach its resting state so cleanup does not race in-flight writes.
    await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
  });

  test("adds members mid-discussion up to six and rejects the seventh", async () => {
    const { service, client } = await buildService(null);
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    const joined = await service.addMember(room.id, {
      provider: "codex",
      persona: "性能",
      displayName: "性能",
      roleId: "backend",
    });
    expect(joined.members).toHaveLength(4);
    expect(joined.members[3]).toMatchObject({
      id: "member_4",
      status: "ready",
      displayName: "性能",
      roleId: "backend",
      catchUpPending: true,
    });
    expect(joined.members[3]?.agentId).toBeTruthy();
    // Caught up to the pre-join lastSeq; the join marker itself lands after
    // the snapshot and reaches the joiner through the normal delta.
    expect(joined.members[3]?.lastDeliveredSeq).toBe(joined.lastSeq - 1);
    // Persistent join marker written by the scheduler; the joiner goes to the tail.
    expect(joined.transcript.at(-1)).toMatchObject({ kind: "system", memberId: "member_4" });
    expect(joined.transcript.at(-1)?.text).toContain("成员 性能");
    expect(joined.round.remainingMemberIds).toContain("member_4");

    // Fill the roster to the six-member cap, then prove the seventh is refused.
    await service.addMember(room.id, { provider: "codex", persona: "安全" });
    const filled = await service.addMember(room.id, { provider: "codex", persona: "数据" });
    expect(filled.members).toHaveLength(6);
    await expect(
      service.addMember(room.id, { provider: "codex", persona: "第七人" }),
    ).rejects.toThrow(/maximum is 6/);

    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    // The joiner spoke at least its catch-up turn (which round it lands in
    // depends on when the join is applied relative to the scripted rotation).
    expect(closing.members[3]?.turnCount).toBeGreaterThanOrEqual(1);
    expect(closing.members[3]?.catchUpPending).toBeFalsy();
    // Moderator + 3 initial members + exactly one probe agent per joiner (3).
    expect(client.configs).toHaveLength(7);
  });

  test("a joiner without session persistence is rejected before touching the roster", async () => {
    const { service, client } = await buildService(null, { withNonPersistentProvider: true });
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    await expect(
      service.addMember(room.id, { provider: MOCK_SLOW_PROVIDER_ID, persona: "压测" }),
    ).rejects.toThrow(/session persistence/);

    const { room: after } = await service.get(room.id);
    expect(after?.members).toHaveLength(3);
    expect(
      after?.transcript.some((entry) => entry.kind === "system" && entry.text.includes("加入房间")),
    ).toBe(false);
    // The probe agent never joined: no extra agent beyond moderator + 3 members.
    expect(client.configs).toHaveLength(4);
    // The room still runs to its scripted end.
    await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
  });

  test("a mid-room joiner runs a catch-up first turn with the full transcript", async () => {
    const { service, client } = await buildService(null);
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    await waitForRoom(service, room.id, hasMemberEntry);
    await service.interject(room.id, "插话一下");

    await service.addMember(room.id, {
      provider: "codex",
      persona: "安全",
      displayName: "安全",
    });

    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    const joiner = closing.members.find((member) => member.id === "member_4");
    expect(joiner?.turnCount).toBeGreaterThanOrEqual(1);
    expect(joiner?.catchUpPending).toBeFalsy();

    // The joiner's displayName replaces the member id in the system prompt,
    // so select its session by the catch-up marker instead of by id.
    const joinerSession = client.sessions.find((session) =>
      session.prompts[0]?.includes("[catch-up｜"),
    );
    const catchupPrompt = joinerSession?.prompts[0];
    expect(catchupPrompt).toContain("[catch-up｜你刚加入聊天室「架构评审」]");
    expect(catchupPrompt).toContain("全部历史发言（按时间顺序）");
    // Humanized transcript: every entry type is present with speaker names.
    expect(catchupPrompt).toContain("- 主持人: 开场白");
    expect(catchupPrompt).toContain("statement from member_1");
    expect(catchupPrompt).toContain("- 用户插话: 插话一下");
    // The file manifest section renders the empty-room placeholder.
    expect(catchupPrompt).toContain("房间产出物（可用你的文件工具读取）");
    expect(catchupPrompt).toContain("（还没有产出物。）");
  });

  test("an over-budget catch-up asks the moderator for a digest", async () => {
    const { service, client } = await buildService(null);
    const room = await service.create({ ...createInput(), limits: { deltaCharBudget: 60 } });
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    // Opening plus two statements push the humanized transcript past 60 chars.
    await waitForRoom(service, room.id, hasTwoMemberEntries);

    await service.addMember(room.id, { provider: "codex", persona: "数据" });

    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    expect(closing.members[3]?.turnCount).toBeGreaterThanOrEqual(1);
    const moderatorPrompts = client.sessions
      .filter((session) => session.memberId === null)
      .flatMap((session) => session.prompts);
    expect(
      moderatorPrompts.some((prompt) =>
        prompt.includes("A new member just joined the room and needs a history digest."),
      ),
    ).toBe(true);
    const history = client.sessions
      .find((session) => session.prompts[0]?.includes("[catch-up｜"))
      ?.prompts[0]?.split("全部历史发言（按时间顺序）：\n")[1]
      ?.split("\n\n房间产出物")[0];
    // Digest body first, then exactly the newest half-budget (30 chars) slice
    // of the transcript — older content is dropped.
    expect(history?.startsWith("statement from member\n\n")).toBe(true);
    expect(history?.length).toBe("statement from member\n\n".length + 30);
  });

  test("member turns stream partial updates and settle with done", async () => {
    const { service, updates } = await buildService(null, { streaming: true });
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    const findDonePartial = (messages: SessionOutboundMessage[]) =>
      messages.find((update) => update.type === "room_partial_update" && update.payload.done);
    const donePartial = await waitFor(() =>
      findDonePartial(partialUpdatesFor(updates, "member_1")),
    );
    const texts = partialUpdatesFor(updates, "member_1").map((update) => update.payload.text);
    // First visible char flushes immediately, the tool call resets the buffer,
    // the final segment flushes on the 300ms cadence, then exactly one done.
    expect(texts[0]).toBe("结论A");
    expect(texts).toContain("");
    expect(texts.at(-1)).toBe("补充B");
    expect(donePartial.payload.text).toBe("补充B");
    expect(donePartial.payload.toolCalls).toBe(1);
    expect(donePartial.payload.roomId).toBe(room.id);

    // The authoritative transcript entry lands right after the done flush.
    const settled = await waitForRoom(service, room.id, hasJoinerStatement);
    const statement = settled.transcript.findLast(
      (entry) => entry.kind === "member" && entry.memberId === "member_1",
    );
    expect(statement?.text).toBe("补充B");
  });

  test("a failed member turn still flushes a terminal done partial", async () => {
    const { service, updates } = await buildService(null, {
      streaming: true,
      failMemberTurns: true,
    });
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    // member_1 fails on both attempts: retry, then the scheduler fails it.
    await waitForRoom(service, room.id, (current) => current.members[0]?.status === "failed");

    const partials = partialUpdatesFor(updates, "member_1");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    // Every attempt ends with exactly one terminal flush closing the stream row;
    // a failing turn never streams intermediate text.
    expect(partials.every((update) => update.payload.done)).toBe(true);
    expect(partials.at(-1)?.payload.done).toBe(true);
    // A failed turn leaves no statement in the transcript.
    const { room: after } = await service.get(room.id);
    expect(
      after?.transcript.some((entry) => entry.kind === "member" && entry.memberId === "member_1"),
    ).toBe(false);
    // Let the room reach its resting state so cleanup does not race in-flight writes.
    await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
  });

  test("an interjection during an in-flight checkpoint keeps one member turn at a time", async () => {
    // 2026-10-25 acceptance §4: the user interjects inside the checkpoint
    // window (turn idle, round_end moderator run still streaming). The racing
    // second checkpoint must not produce a duplicate moderator reply that
    // starts a second member turn — the next prompt for the still-streaming
    // member would fail on AgentManager's active-run guard and kill the seat.
    const holdCheckpoint = deferred<void>();
    const holdMember1 = deferred<void>();
    const { service, client } = await buildService(holdMember1, {
      holdCheckpoint,
      // Round 1 runs free; from round 2 only member_1's turn holds open, so a
      // duplicate prompt for member_2 would complete and re-prompt member_1
      // while its run is still active.
      holdTurns: { fromRound: 2, memberIds: ["member_1"] },
    });
    const base = createInput();
    const room = await service.create({ ...base, members: base.members.slice(0, 2) });
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");

    // Round 1 finishes; the round_end checkpoint run then blocks on the gate.
    await waitForRoom(service, room.id, hasTwoMemberEntries);
    // The interjection lands in the idle window while the checkpoint runs.
    await service.interject(room.id, "先等等");
    // Let any racing fallback cascade fire; with the fix the only thing that
    // can start round 2 is the real checkpoint reply after the gate opens.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    holdCheckpoint.resolve();

    // Round 2's first turn (member_1, held) opens only after the checkpoint
    // window closes; releasing it lets the room rotate and finish.
    holdMember1.resolve();
    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );

    // No seat was failed and both members kept their rotation.
    expect(
      closing.transcript.some((entry) => entry.kind === "system" && entry.text.includes("failed")),
    ).toBe(false);
    expect(closing.members[0]).toMatchObject({ id: "member_1", turnCount: 2 });
    expect(closing.members[1]).toMatchObject({ id: "member_2", turnCount: 2 });
    // The interjection reached a moderator checkpoint prompt (the serialized
    // second checkpoint ran after the first, instead of losing the race and
    // falling back).
    const moderatorPrompts = client.sessions
      .filter((session) => session.memberId === null)
      .flatMap((session) => session.prompts);
    expect(
      moderatorPrompts.some(
        (prompt) => prompt.includes("Decide the next step") && prompt.includes("先等等"),
      ),
    ).toBe(true);
  });

  test("a cancelled member turn releases its run and the seat speaks again after resume", async () => {
    const gate = deferred<void>();
    const { service } = await buildService(gate);
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    // Let member_1's turn reach its held startTurn.
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));

    await service.pause(room.id);
    // The cancelled turn's held continuation must not resurrect it.
    gate.resolve();
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    const { room: paused } = await service.get(room.id);
    expect(paused?.status).toBe("interrupted");
    expect(paused?.transcript.filter((entry) => entry.kind === "member")).toHaveLength(0);

    const resumed = await service.resume(room.id);
    expect(resumed.status).toBe("discussing");
    // The interrupted member is re-prompted on a fresh run and completes: the
    // cancelled run was fully released, so the active-run guard stays silent.
    const withStatement = await waitForRoom(service, room.id, hasMemberOneStatement);
    expect(
      withStatement.transcript.some(
        (entry) => entry.kind === "system" && entry.text.includes("failed"),
      ),
    ).toBe(false);
    await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
  });

  test("start fails fast and rolls back every created agent when a member provider cannot persist", async () => {
    // Design §7.2.1 first patch: the room.start path (ensureAgents) probes
    // each member right after createAgent. A non-persistent provider must
    // fail at start (not at the member's first turn) with every agent this
    // pass created rolled back — moderator included.
    const { service, client, agentManager } = await buildService(null, {
      withNonPersistentProvider: true,
    });
    const archive = vi.spyOn(agentManager, "archiveAgent");
    const room = await service.create({
      ...createInput(),
      members: [
        { provider: "codex", persona: "可靠性" },
        { provider: MOCK_SLOW_PROVIDER_ID, persona: "成本" },
      ],
    });

    await expect(service.start(room.id)).rejects.toThrow(
      /does not support session persistence \(member member_2\)/,
    );

    // The room record was never written: forming, members pending, no agents.
    const { room: after } = await service.get(room.id);
    expect(after?.status).toBe("forming");
    expect(
      after?.members.every((member) => member.agentId === null && member.status === "pending"),
    ).toBe(true);
    expect(after?.transcript).toHaveLength(0);
    // The codex client saw moderator + member_1; member_2's probe landed on
    // the non-persistent client. The rollback array covers all three —
    // moderator and the earlier member included, probe agent included — and
    // nothing else leaks.
    expect(client.configs).toHaveLength(2);
    expect(archive).toHaveBeenCalledTimes(3);

    // A room with a persistent provider still starts cleanly.
    const retry = await service.create(createInput());
    const started = await service.start(retry.id);
    expect(started.status).toBe("opening");
    expect(started.members.every((member) => member.status === "ready")).toBe(true);
    await waitForRoom(
      service,
      retry.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
  });

  test("the create_member self-heal path rejects a non-persistent provider and rolls the probe back", async () => {
    const { service, agentManager } = await buildService(null, {
      withNonPersistentProvider: true,
    });
    const room = await service.create(createInput());
    await service.start(room.id);
    await waitForRoom(service, room.id, (current) => current.status === "discussing");
    const { room: current } = await service.get(room.id);
    expect(current).toBeTruthy();
    // Force the self-heal branch: member_1's agent never landed and the seat
    // would retry with the non-persistent provider (§7.2.1 entry table).
    const healMembers = [...current!.members];
    healMembers[0] = {
      ...healMembers[0]!,
      agentId: null,
      status: "pending" as const,
      provider: MOCK_SLOW_PROVIDER_ID,
    };
    const healRecord: RoomRecord = { ...current!, members: healMembers };
    const archive = vi.spyOn(agentManager, "archiveAgent");
    const ensureMember = (
      service as unknown as {
        ensureMember: (
          this: RoomService,
          record: RoomRecord,
          memberId: string,
        ) => Promise<RoomRecord>;
      }
    ).ensureMember;
    await expect(ensureMember.call(service, healRecord, "member_1")).rejects.toThrow(
      /does not support session persistence \(member member_1\)/,
    );
    expect(archive).toHaveBeenCalledTimes(1);
    // Let the room reach its resting state so cleanup does not race writes.
    await waitForRoom(
      service,
      room.id,
      (currentRoom) => currentRoom.status === "closing" && currentRoom.summary !== null,
    );
  });

  test("v1 rooms refuse mid-room joins without touching the roster", async () => {
    // Design §7.2.1 third patch: promptVersion < 2 rooms never upgraded and
    // the join mechanism is v2-only; the rpc_error names the way out.
    const { service } = await buildService(null);
    const room = await service.create(createInput());
    const store = new RoomStore(roomsDir, logger);
    await store.update(room.id, (current) => ({
      ...current,
      promptVersion: 1,
      status: "discussing",
    }));

    await expect(
      service.addMember(room.id, { provider: "codex", persona: "第五人" }),
    ).rejects.toThrow(/旧版本/);

    const { room: after } = await service.get(room.id);
    expect(after?.members).toHaveLength(3);
    expect(
      after?.transcript.some((entry) => entry.kind === "system" && entry.text.includes("加入房间")),
    ).toBe(false);
    expect(after?.round.remainingMemberIds).toHaveLength(0);
    // The v2 path keeps working (covered separately by the addMember suite).
  });

  test("a stale checkpoint reply is dropped at the backfill boundary and the fresh run settles the interjection", async () => {
    // Design §7.7: round_end run1 holds on the gate with a pre-interjection
    // snapshot; the interjection dispatches run2 and overwrites the binding.
    // run1's reply must be dropped at the service backfill boundary — had it
    // been consumed it would have settled nothing (its snapshot is empty) and
    // opened round 2 with the interjection still queued.
    const holdCheckpoint = deferred<void>();
    const { service, client } = await buildService(null, {
      holdCheckpoint,
      answerUser: true,
    });
    const warn = vi.spyOn(logger, "warn");
    const base = createInput();
    const room = await service.create({ ...base, members: base.members.slice(0, 2) });
    await service.start(room.id);
    await waitForRoom(service, room.id, hasTwoMemberEntries);
    // run1's checkpoint prompt is out (past its snapshot point) before the
    // interjection dispatches.
    await waitFor(() => (moderatorCheckpointPrompts(client).length > 0 ? true : null));

    await service.interject(room.id, "先等等");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    holdCheckpoint.resolve();

    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    // run1 was dropped by the runId mismatch; the serialized run2 listed the
    // interjection (queued snapshot) and settled it — the observable
    // difference vs a consumed run1 is the interjection's final status.
    expect(closing.interjections[0]?.status).toBe("answered");
    expect(
      closing.transcript.some((entry) => entry.kind === "moderator" && entry.text === "收到"),
    ).toBe(true);
    // The mismatch was warned, not silent.
    expect(
      warn.mock.calls.some((args) => String(args.at(-1)).includes("checkpointRunId mismatch")),
    ).toBe(true);
    // Invariant: the checkpoint prompt's Pending section lists only queued
    // interjections — the prompt that carried "先等等" is exactly the run whose
    // snapshot was queued; later checkpoint prompts never repeat it in the
    // Pending section once answered (their recent-transcript section may quote
    // it, which is not a pending listing).
    expect(
      moderatorCheckpointPrompts(client).filter((prompt) =>
        (prompt.split("Pending user interjections:")[1] ?? "").includes("先等等"),
      ),
    ).toHaveLength(1);
    // The binding table drains after every run finishes (cleanup in the
    // finally scope; multiple runs came and went).
    const bindings = (service as unknown as { checkpointRunIds: Map<string, string> })
      .checkpointRunIds;
    expect(bindings.size).toBe(0);
  });

  test("a hung moderator checkpoint times out and the room keeps rotating (R8)", async () => {
    // The round_end moderator run hangs forever on the gate; the timeout must
    // break the deadlock via the deterministic fallback (continue) instead of
    // leaving the room stuck on pendingCheckpoint with an idle turn.
    const holdCheckpoint = deferred<void>(); // never resolved
    const { service } = await buildService(null, { holdCheckpoint });
    const base = createInput();
    const room = await service.create({
      ...base,
      members: base.members.slice(0, 2),
      limits: { turnTimeoutMs: 300, maxRounds: 2, maxTurns: 12 },
    });
    await service.start(room.id);

    // Opening is not a checkpoint prompt, so it passes; round 1 completes and
    // the round_end checkpoint run then hangs on the gate.
    await waitForRoom(service, room.id, hasTwoMemberEntries);

    // The timeout fires (~300ms) and the fallback continues into round 2
    // instead of blocking the room forever.
    const reachedRound2 = (current: { transcript: Array<{ kind: string; text: string }> }) =>
      current.transcript.some((entry) => entry.kind === "system" && entry.text === "round:2");
    await waitForRoom(service, room.id, reachedRound2);

    // Round 2's checkpoint hang times out the same way; the budget exhausts
    // and the room still reaches a proper closing with a summary — the full
    // lifecycle survives a permanently unresponsive moderator run.
    const closing = await waitForRoom(
      service,
      room.id,
      (current) => current.status === "closing" && current.summary !== null,
    );
    expect(
      closing.transcript.some(
        (entry) => entry.kind === "moderator" && entry.text === "## 最终结论",
      ),
    ).toBe(true);
    expect(closing.members.map((member) => member.status)).not.toContain("failed");
  });

  test("repairs legacy wire-id session titles without touching renamed ones", async () => {
    const { service, agentManager } = await buildService(null);
    const room = await service.create(createInput());
    const started = await service.start(room.id);
    const memberAgentIds = started.members
      .map((member) => member.agentId)
      .filter((id): id is string => Boolean(id));
    const moderatorAgentId = started.moderator.agentId;
    expect(memberAgentIds).toHaveLength(3);
    expect(moderatorAgentId).toBeTruthy();

    // Rewrite the titles to the pre-role format as an old daemon would have
    // left them, and give one member a user-chosen title.
    await agentManager.setTitle(memberAgentIds[0]!, `Room member member_1 · ${room.name}`);
    await agentManager.setTitle(memberAgentIds[1]!, "我自己起的名字");
    await agentManager.setTitle(moderatorAgentId!, `Room moderator · ${room.name}`);

    await service.repairLegacyAgentTitles();

    // Legacy titles now read like roles.
    expect(await agentManager.getTitle(memberAgentIds[0]!)).toBe(`Member 1 · ${room.name}`);
    expect(await agentManager.getTitle(moderatorAgentId!)).toBe(`主持人 · ${room.name}`);
    // The hand-written title is untouched.
    expect(await agentManager.getTitle(memberAgentIds[1]!)).toBe("我自己起的名字");
    // A member created under the new format was never legacy, so it keeps the
    // positional title it already had.
    expect(await agentManager.getTitle(memberAgentIds[2]!)).toBe(`Member 3 · ${room.name}`);
  });

  test("ignores titles that merely start with the old prefix", async () => {
    const { service, agentManager } = await buildService(null);
    const room = await service.create(createInput());
    const started = await service.start(room.id);
    const agentId = started.members[0]!.agentId!;

    await agentManager.setTitle(agentId, "Room member onboarding notes");
    await service.repairLegacyAgentTitles();

    expect(await agentManager.getTitle(agentId)).toBe("Room member onboarding notes");
  });
});
