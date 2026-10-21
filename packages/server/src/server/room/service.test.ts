import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
): Promise<Awaited<ReturnType<RoomService["get"]>> & object> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const room = await service.get(roomId);
    if (room && until(room)) return room;
    if (Date.now() > deadline) throw new Error(`timed out waiting for room ${roomId}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
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
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
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
    // eslint-disable-next-line no-console -- temporary debug
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

  test("runs 3 members for 2 rounds and closes with a summary", async () => {
    const { service, client, storage, updates, invalidUpdates } = await buildService(null);
    const room = await service.create(createInput());

    const started = await service.start(room.id);
    expect(started.status).toBe("opening");
    expect(started.members.map((member) => member.agentId)).toHaveLength(3);

    // Idempotent start while running.
    const again = await service.start(room.id);
    expect(again.id).toBe(room.id);

    const closed = await waitForRoom(service, room.id, (current) => current.status === "closed");
    expect(closed.summary).toContain("最终结论");
    const memberEntries = closed.transcript.filter((entry) => entry.kind === "member");
    expect(memberEntries).toHaveLength(6);
    for (const member of closed.members) {
      expect(member.turnCount).toBe(2);
      expect(member.status).toBe("archived");
    }
    expect(closed.round.index).toBe(2);

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
    await expect(service.get(room.id)).resolves.toMatchObject({ status: "closed" });
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
    const closed = await waitForRoom(service, room.id, (current) => current.status === "closed");
    expect(closed.interjections[0]?.status).toBe("queued");
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
    const interrupted = await fresh.get(room.id);
    expect(interrupted?.status).toBe("interrupted");

    await expect(fresh.start(room.id)).rejects.toThrow(/resume/);
    // The held turn never resolves; its late timeout is dropped while interrupted.
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
});
