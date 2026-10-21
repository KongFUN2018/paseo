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

export interface SidebarWorkspaceSessionRows {
  /**
   * Delegated agents with no visible parent: parent archived, parent missing, or parent in
   * another workspace. Behaviorally they are root agents, so they render unindented at the same
   * level as a workspace row and are never hidden behind a disclosure.
   */
  rootRows: SidebarSessionRow[];
  /** Children of the workspace's own root agents. These indent under the workspace row. */
  childRows: SidebarSessionRow[];
}

export interface SidebarSessionAgentSource {
  serverId: string;
  agents: ReadonlyMap<string, Agent> | undefined;
}

/**
 * Expansion keys live in one persisted set for both row kinds. Each part is percent-encoded so a
 * separator inside a server, workspace, or agent id cannot make two different keys identical.
 */
export function workspaceSessionTreeKey(serverId: string, workspaceId: string): string {
  return `ws:${encodeURIComponent(serverId)}:${encodeURIComponent(workspaceId)}`;
}

export function agentSessionTreeKey(serverId: string, agentId: string): string {
  return `agent:${encodeURIComponent(serverId)}:${encodeURIComponent(agentId)}`;
}

/**
 * Builds every workspace's delegated-agent rows, keyed by the sidebar's `${serverId}:${workspaceId}`.
 *
 * Nesting only happens when the parent is alive and in the same workspace. Everything else becomes
 * a root row of its own workspace: visible, flat, and never reaching across workspaces.
 */
export function buildSidebarSessionRowsByWorkspace(
  sources: readonly SidebarSessionAgentSource[],
): Map<string, SidebarWorkspaceSessionRows> {
  const rowsByWorkspaceKey = new Map<string, SidebarWorkspaceSessionRows>();
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
): Map<string, SidebarWorkspaceSessionRows> {
  const rowsByWorkspaceId = new Map<string, SidebarWorkspaceSessionRows>();
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

  const groups = groupDelegatedAgents(delegated, liveById);
  for (const workspaceId of groups.workspaceIds) {
    const rows = buildWorkspaceSessionRows(serverId, workspaceId, delegated, groups);
    if (rows) {
      rowsByWorkspaceId.set(workspaceId, rows);
    }
  }
  return rowsByWorkspaceId;
}

interface DelegatedAgentGroups {
  childrenByParentId: Map<string, Agent[]>;
  indentedRootsByWorkspaceId: Map<string, Agent[]>;
  flatRootsByWorkspaceId: Map<string, Agent[]>;
  workspaceIds: Set<string>;
}

function groupDelegatedAgents(
  delegated: Agent[],
  liveById: ReadonlyMap<string, Agent>,
): DelegatedAgentGroups {
  const childrenByParentId = new Map<string, Agent[]>();
  const indentedRootsByWorkspaceId = new Map<string, Agent[]>();
  const flatRootsByWorkspaceId = new Map<string, Agent[]>();
  for (const agent of delegated) {
    const parent = liveById.get(agent.parentAgentId ?? "");
    if (!parent || parent.workspaceId !== agent.workspaceId) {
      pushAgent(flatRootsByWorkspaceId, agent.workspaceId ?? "", agent);
    } else if (!parent.parentAgentId) {
      // The parent is a workspace root agent, represented by the workspace row itself. Its
      // children start the indented tree.
      pushAgent(indentedRootsByWorkspaceId, agent.workspaceId ?? "", agent);
    } else {
      pushAgent(childrenByParentId, parent.id, agent);
    }
  }
  return {
    childrenByParentId,
    indentedRootsByWorkspaceId,
    flatRootsByWorkspaceId,
    workspaceIds: new Set(delegated.map((agent) => agent.workspaceId ?? "")),
  };
}

function buildWorkspaceSessionRows(
  serverId: string,
  workspaceId: string,
  delegated: Agent[],
  groups: DelegatedAgentGroups,
): SidebarWorkspaceSessionRows | null {
  // Shared across the whole workspace so a malformed parent chain (A→B→A) cannot recurse
  // forever. Anything the known roots cannot reach still renders, as a root row.
  const rendered = new Set<string>();
  const childRows = sortAgents(groups.indentedRootsByWorkspaceId.get(workspaceId) ?? []).map(
    (agent) =>
      buildRow({ serverId, agent, childrenByParentId: groups.childrenByParentId, rendered }),
  );
  const rootRows = sortAgents(groups.flatRootsByWorkspaceId.get(workspaceId) ?? []).map((agent) =>
    buildRow({ serverId, agent, childrenByParentId: groups.childrenByParentId, rendered }),
  );
  const unrendered = delegated.filter(
    (agent) => agent.workspaceId === workspaceId && !rendered.has(agent.id),
  );
  for (const agent of sortAgents(unrendered)) {
    if (rendered.has(agent.id)) continue;
    rootRows.push(
      buildRow({ serverId, agent, childrenByParentId: groups.childrenByParentId, rendered }),
    );
  }
  return childRows.length > 0 || rootRows.length > 0 ? { rootRows, childRows } : null;
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
