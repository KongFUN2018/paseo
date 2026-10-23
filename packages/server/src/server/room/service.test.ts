import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, afterEach, test } from "vitest";
import {
  SessionOutboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { ROOM_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type pino from "pino";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { RoomService, type CreateRoomInput } from "./service.js";
import { RoomStore } from "./store.js";

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

function hasMemberUsage(updates: SessionOutboundMessage[]): boolean {
  for (const update of updates) {
    if (update.type !== "room_update") continue;
    for (const member of update.payload.room.members) {
      if (member.lastUsage !== undefined) return true;
    }
  }
  return false;
}

function hasSystemEntry(room: { transcript: Array<{ kind: string; text: string }> }): boolean {
  return room.transcript.some(
    (entry) => entry.kind === "system" && entry.text.includes("Member member_1 failed"),
  );
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
  const match = /You are member (member_\d+)/.exec(config.systemPrompt ?? "");
  return match?.[1] ?? null;
}

/** Scripted session: moderator answers JSON, members answer a fixed statement. */
class ScriptedRoomSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  interruptCount = 0;
  private turnCounter = 0;
  turnStarted = false;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly memberId: string | null;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly holdTurn: Deferred<void> | null,
  ) {
    this.memberId = memberIdFromPrompt(config);
  }

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnStarted = true;
    const turnId = `turn-${this.id}-${++this.turnCounter}`;
    const text = typeof prompt === "string" ? prompt : "";
    void (async () => {
      // Defer like real providers: events must arrive after the manager's waiter is set up.
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      if (this.holdTurn && text.includes("[round 1 | turn 0]")) {
        await this.holdTurn.promise;
      }
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
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
    this.pushEvent({
      type: "turn_cancelled",
      provider: this.provider,
      turnId: `turn-${this.id}-${this.turnCounter}`,
    });
  }

  async close(): Promise<void> {}
}

class ScriptedRoomClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly configs: AgentSessionConfig[] = [];
  readonly sessions: ScriptedRoomSession[] = [];

  constructor(
    private readonly logger: pino.Logger,
    private readonly holdTurn: Deferred<void> | null,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.configs.push(config);
    const session = new ScriptedRoomSession(config, this.holdTurn);
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

  async function buildService(holdTurn: Deferred<void> | null) {
    workDir = await mkdtemp(join(tmpdir(), "room-service-ws-"));
    roomsDir = await mkdtemp(join(tmpdir(), "room-service-rooms-"));
    agentsDir = await mkdtemp(join(tmpdir(), "room-service-agents-"));
    logger = createTestLogger();
    const storage = new AgentStorage(agentsDir, logger);
    await storage.initialize();
    const client = new ScriptedRoomClient(logger, holdTurn);
    const agentManager = new AgentManager({
      clients: { codex: client },
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
    const { service } = await buildService(gate);
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
    const closing = await waitForRoom(service, room.id, (current) => current.status === "closing");
    expect(closing.interjections[0]?.status).toBe("queued");
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

  test("rejects member counts outside 2-4 even when called directly", async () => {
    const { service } = await buildService(null);
    const base = createInput();
    await expect(service.create({ ...base, members: [base.members[0]] })).rejects.toThrow(
      /2 to 4 members, got 1/,
    );
    await expect(
      service.create({
        ...base,
        members: [
          ...base.members,
          { provider: "codex", persona: "性能" },
          { provider: "codex", persona: "安全" },
        ],
      }),
    ).rejects.toThrow(/2 to 4 members, got 5/);
    const ok = await service.create({
      ...base,
      members: base.members.slice(0, 2),
    });
    expect(ok.members).toHaveLength(2);
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
});
