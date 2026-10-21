import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "./sidebar-workspaces-view-model";
import {
  buildSidebarSessionRowsByWorkspace,
  type SidebarWorkspaceSessionRows,
} from "./sidebar-session-tree-view-model";

const EMPTY_ROWS: ReadonlyMap<string, SidebarWorkspaceSessionRows> = new Map();
const EMPTY_AGENT_MAPS: Array<ReadonlyMap<string, Agent> | undefined> = [];

function areAgentMapsEqual(
  left: ReadonlyArray<ReadonlyMap<string, Agent> | undefined>,
  right: ReadonlyArray<ReadonlyMap<string, Agent> | undefined>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((map, index) => map === right[index]);
}

/**
 * Child-session trees for every visible workspace, keyed by `${serverId}:${workspaceId}`.
 *
 * One subscription over the session store's per-host agent maps, like
 * `useSidebarWorkspaceEntries` — the rows share it instead of each mounting its own.
 */
export function useSidebarSessionRows(
  placements: readonly SidebarWorkspacePlacement[],
  enabled = true,
): ReadonlyMap<string, SidebarWorkspaceSessionRows> {
  const serverIds = useMemo(
    () => Array.from(new Set(placements.map((placement) => placement.serverId))),
    [placements],
  );
  const agentsByServer = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      enabled ? serverIds.map((serverId) => state.sessions[serverId]?.agents) : EMPTY_AGENT_MAPS,
    areAgentMapsEqual,
  );

  return useMemo(() => {
    if (!enabled || agentsByServer.length === 0) {
      return EMPTY_ROWS;
    }
    return buildSidebarSessionRowsByWorkspace(
      serverIds.map((serverId, index) => ({ serverId, agents: agentsByServer[index] })),
    );
  }, [agentsByServer, enabled, serverIds]);
}
