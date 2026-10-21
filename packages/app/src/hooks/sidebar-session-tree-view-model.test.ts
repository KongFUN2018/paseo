import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  agentSessionTreeKey,
  buildSidebarSessionRowsByWorkspace,
  workspaceSessionTreeKey,
} from "./sidebar-session-tree-view-model";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const OTHER_WORKSPACE_ID = "workspace-2";

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: new Date("2026-03-08T10:00:00.000Z"),
  updatedAt: new Date("2026-03-08T10:00:00.000Z"),
  lastUserMessageAt: null,
  lastActivityAt: new Date("2026-03-08T10:00:00.000Z"),
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  title: "Agent",
  cwd: "/tmp/project",
  workspaceId: WORKSPACE_ID,
  model: null,
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function build(agents: Agent[]) {
  return buildSidebarSessionRowsByWorkspace([
    { serverId: SERVER_ID, agents: new Map(agents.map((agent) => [agent.id, agent])) },
  ]);
}

describe("buildSidebarSessionRowsByWorkspace", () => {
  it("nests delegated agents under their parent, recursively", () => {
    const rows = build([
      makeAgent({ id: "parent", parentAgentId: null }),
      makeAgent({
        id: "child",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:00:01.000Z"),
      }),
      makeAgent({
        id: "grandchild",
        parentAgentId: "child",
        createdAt: new Date("2026-03-08T10:00:02.000Z"),
      }),
    ]);

    const workspaceRows = rows.get(`${SERVER_ID}:${WORKSPACE_ID}`);
    expect(workspaceRows?.childRows.map((row) => row.agentId)).toEqual(["child"]);
    expect(workspaceRows?.childRows[0]?.children.map((row) => row.agentId)).toEqual(["grandchild"]);
    expect(workspaceRows?.rootRows).toEqual([]);
    expect(workspaceRows?.childRows[0]?.key).toBe(`agent:${SERVER_ID}:child`);
    expect(workspaceRows?.childRows[0]?.workspaceKey).toBe(`${SERVER_ID}:${WORKSPACE_ID}`);
  });

  it("keeps workspace root sessions out of the tree", () => {
    expect(build([makeAgent({ id: "root" })]).size).toBe(0);
  });

  it("shows an archived parent's child as a root row, at the same level as a root session", () => {
    const archivedParent = makeAgent({
      id: "parent",
      archivedAt: new Date("2026-03-08T10:05:00.000Z"),
    });
    const rows = build([
      archivedParent,
      makeAgent({ id: "orphan", parentAgentId: "parent" }),
      makeAgent({ id: "hidden", parentAgentId: "parent", archivedAt: new Date() }),
    ]);

    const workspaceRows = rows.get(`${SERVER_ID}:${WORKSPACE_ID}`);
    expect(workspaceRows?.rootRows.map((row) => row.agentId)).toEqual(["orphan"]);
    expect(workspaceRows?.childRows).toEqual([]);
    expect(workspaceRows?.rootRows[0]?.children).toEqual([]);
  });

  it("treats a missing parent the same as an archived one", () => {
    const rows = build([makeAgent({ id: "orphan", parentAgentId: "not-loaded" })]);

    expect(rows.get(`${SERVER_ID}:${WORKSPACE_ID}`)?.rootRows.map((row) => row.agentId)).toEqual([
      "orphan",
    ]);
  });

  it("does not nest across workspaces and keeps the child as a root row", () => {
    const rows = build([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({
        id: "cross-workspace-child",
        parentAgentId: "parent",
        workspaceId: OTHER_WORKSPACE_ID,
      }),
    ]);

    expect(rows.get(`${SERVER_ID}:${WORKSPACE_ID}`)).toBeUndefined();
    const otherWorkspace = rows.get(`${SERVER_ID}:${OTHER_WORKSPACE_ID}`);
    expect(otherWorkspace?.rootRows.map((row) => row.agentId)).toEqual(["cross-workspace-child"]);
    expect(otherWorkspace?.childRows).toEqual([]);
  });

  it("orders indented siblings by creation time and breaks ties by id", () => {
    const createdAt = new Date("2026-03-08T10:00:00.000Z");
    const rows = build([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "second", parentAgentId: "parent", createdAt }),
      makeAgent({ id: "first", parentAgentId: "parent", createdAt }),
      makeAgent({
        id: "later",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:00:01.000Z"),
      }),
    ]);

    expect(rows.get(`${SERVER_ID}:${WORKSPACE_ID}`)?.childRows.map((row) => row.agentId)).toEqual([
      "first",
      "second",
      "later",
    ]);
  });

  it("still renders both agents when the parent chain forms a cycle", () => {
    const rows = build([
      makeAgent({ id: "cycle-a", parentAgentId: "cycle-b" }),
      makeAgent({ id: "cycle-b", parentAgentId: "cycle-a" }),
    ]);

    const workspaceRows = rows.get(`${SERVER_ID}:${WORKSPACE_ID}`);
    expect(workspaceRows?.rootRows.map((row) => row.agentId)).toEqual(["cycle-a"]);
    expect(workspaceRows?.rootRows[0]?.children.map((row) => row.agentId)).toEqual(["cycle-b"]);
    expect(workspaceRows?.childRows).toEqual([]);
  });

  it("derives the row status from the agent's turn and attention", () => {
    const rows = build([
      makeAgent({ id: "parent" }),
      makeAgent({
        id: "running",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:00:01.000Z"),
        turn: { phase: "open", turnId: "turn-1", startedAt: null, cancellationRequestId: null },
      }),
      makeAgent({
        id: "needs-input",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:00:02.000Z"),
        pendingPermissions: [{ id: "permission-1" }] as Agent["pendingPermissions"],
      }),
    ]);

    const children = rows.get(`${SERVER_ID}:${WORKSPACE_ID}`)?.childRows ?? [];
    expect(children.map((row) => [row.agentId, row.statusBucket])).toEqual([
      ["running", "running"],
      ["needs-input", "needs_input"],
    ]);
  });
});

describe("session tree keys", () => {
  it("percent-encodes each identity so separators cannot merge two keys", () => {
    expect(agentSessionTreeKey("srv:a", "agent:b")).not.toBe(
      agentSessionTreeKey("srv", "a:agent:b"),
    );
    expect(workspaceSessionTreeKey("srv:a", "workspace:b")).not.toBe(
      workspaceSessionTreeKey("srv", "a:workspace:b"),
    );
    expect(agentSessionTreeKey(SERVER_ID, "agent")).toBe(`agent:${SERVER_ID}:agent`);
    expect(workspaceSessionTreeKey(SERVER_ID, WORKSPACE_ID)).toBe(
      `ws:${SERVER_ID}:${WORKSPACE_ID}`,
    );
  });
});
