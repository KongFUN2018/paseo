import type { Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

/**
 * One delegated agent under a sidebar workspace row.
 *
 * The workspace row stands for the workspace's own root sessions; only agents carrying a
 * `paseo.parent-agent-id` label become rows here. `children` is built from the label chain, so a
 * grandchild nests under its parent rather than under the workspace.
 */
export interface SidebarSessionRow {
  /** `agent:${serverId}:${agentId}` — also the persisted expansion key. */
  key: string;
  serverId: string;
  workspaceId: string;
  /** `${serverId}:${workspaceId}` of the workspace row this tree hangs from. */
  workspaceKey: string;
  agentId: string;
  title: string | null;
  statusBucket: SidebarStateBucket;
  createdAt: Date;
  children: SidebarSessionRow[];
}

export interface SidebarSessionAgentSource {
  serverId: string;
  agents: ReadonlyMap<string, Agent> | undefined;
}

/**
 * Expansion keys live in one persisted set for both row kinds. The prefixes keep a
 * client-supplied agent id from ever naming a workspace row (or the reverse).
 */
export function workspaceSessionTreeKey(workspaceKey: string): string {
  return `ws:${workspaceKey}`;
}

export function agentSessionTreeKey(serverId: string, agentId: string): string {
  return `agent:${serverId}:${agentId}`;
}

/**
 * Builds every workspace's child-session tree, keyed by the sidebar's `${serverId}:${workspaceId}`.
 *
 * A child nests only when its parent is alive and in the same workspace. A child whose parent is
 * archived, missing, or in another workspace becomes a root row of its own workspace's tree: it
 * stays visible, flat, and never reaches across workspaces to nest.
 */
export function buildSidebarSessionRowsByWorkspace(
  sources: readonly SidebarSessionAgentSource[],
): Map<string, SidebarSessionRow[]> {
  const rowsByWorkspaceKey = new Map<string, SidebarSessionRow[]>();
  for (const source of sources) {
    const rowsByWorkspaceId = buildServerSessionRows(source.serverId, source.agents);
    for (const [workspaceId, rows] of rowsByWorkspaceId) {
      rowsByWorkspaceKey.set(`${source.serverId}:${workspaceId}`, rows);
    }
  }
  return rowsByWorkspaceKey;
}

function buildServerSessionRows(
  serverId: string,
  agents: ReadonlyMap<string, Agent> | undefined,
): Map<string, SidebarSessionRow[]> {
  const rowsByWorkspaceId = new Map<string, SidebarSessionRow[]>();
  if (!agents || agents.size === 0) {
    return rowsByWorkspaceId;
  }

  const liveById = new Map<string, Agent>();
  const delegated: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    liveById.set(agent.id, agent);
    if (agent.parentAgentId) delegated.push(agent);
  }

  const childrenByParentId = new Map<string, Agent[]>();
  const rootsByWorkspaceId = new Map<string, Agent[]>();
  for (const agent of delegated) {
    const parent = liveById.get(agent.parentAgentId ?? "");
    // Only a delegated parent is a row of its own. A workspace root agent is represented by the
    // workspace row itself, so its children start the tree.
    if (parent && parent.parentAgentId && parent.workspaceId === agent.workspaceId) {
      pushAgent(childrenByParentId, parent.id, agent);
    } else {
      pushAgent(rootsByWorkspaceId, agent.workspaceId ?? "", agent);
    }
  }

  const workspaceIds = new Set<string>();
  for (const agent of delegated) {
    workspaceIds.add(agent.workspaceId ?? "");
  }

  for (const workspaceId of workspaceIds) {
    // Shared across the whole workspace so a malformed parent chain (A→B→A) cannot recurse
    // forever. Anything the roots cannot reach is still rendered, as a root of its own.
    const rendered = new Set<string>();
    const rows = sortAgents(rootsByWorkspaceId.get(workspaceId) ?? []).map((agent) =>
      buildRow({ serverId, agent, childrenByParentId, rendered }),
    );
    const unrendered = delegated.filter(
      (agent) => agent.workspaceId === workspaceId && !rendered.has(agent.id),
    );
    for (const agent of sortAgents(unrendered)) {
      if (rendered.has(agent.id)) continue;
      rows.push(buildRow({ serverId, agent, childrenByParentId, rendered }));
    }
    if (rows.length > 0) {
      rowsByWorkspaceId.set(workspaceId, rows);
    }
  }
  return rowsByWorkspaceId;
}

function buildRow(input: {
  serverId: string;
  agent: Agent;
  childrenByParentId: ReadonlyMap<string, Agent[]>;
  rendered: Set<string>;
}): SidebarSessionRow {
  const { serverId, agent, childrenByParentId, rendered } = input;
  rendered.add(agent.id);
  const childAgents = sortAgents(childrenByParentId.get(agent.id) ?? []).filter(
    (child) => !rendered.has(child.id),
  );
  const workspaceId = agent.workspaceId ?? "";
  return {
    key: agentSessionTreeKey(serverId, agent.id),
    serverId,
    workspaceId,
    workspaceKey: `${serverId}:${workspaceId}`,
    agentId: agent.id,
    title: agent.title,
    statusBucket: deriveAgentStatusBucket(agent),
    createdAt: agent.createdAt,
    children: childAgents.map((child) =>
      buildRow({ serverId, agent: child, childrenByParentId, rendered }),
    ),
  };
}

/** Same bucket the workspace row uses, so a child row's dot means what a sibling's dot means. */
function deriveAgentStatusBucket(agent: Agent): SidebarStateBucket {
  let status: Agent["status"] = agent.status;
  if (agent.turn.phase === "open") {
    status = "running";
  } else if (agent.status === "running") {
    status = "idle";
  }
  return deriveSidebarStateBucket({
    status,
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
}

function sortAgents(agents: Agent[]): Agent[] {
  return agents.sort((left, right) => {
    const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
    return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
  });
}

function pushAgent(target: Map<string, Agent[]>, key: string, agent: Agent): void {
  const existing = target.get(key);
  if (existing) {
    existing.push(agent);
  } else {
    target.set(key, [agent]);
  }
}
