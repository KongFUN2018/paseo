import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { SidebarSessionRow } from "@/hooks/sidebar-session-tree-view-model";
import { resolveRowLabel } from "@/subagents/track-presentation";
import { density } from "@/styles/density";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SidebarAgentStatusIndicator, SidebarTreeToggle } from "./sidebar-workspace-row-content";

// The workspace row's own left padding (theme.spacing[2]) and one step of tree indent
// (theme.spacing[4]). Static reads of theme values: the indent is geometry, not paint, and
// Unistyles must not see a new style object every time depth changes.
const ROW_BASE_PADDING = 8;
const ROW_INDENT = 16;

export interface SidebarSessionTreeProps {
  rows: readonly SidebarSessionRow[];
  expandedSessionKeys: ReadonlySet<string>;
  onToggleSessionExpanded: (sessionKey: string) => void;
  onOpenSession: (row: SidebarSessionRow) => void;
  /** 1 = directly under a workspace row. Each nested level adds one indent step. */
  depth?: number;
}

/**
 * Delegated-agent rows under a workspace row. A row with children renders its own disclosure and
 * nests the subtree only while its key is in `expandedSessionKeys` — collapsed is the default.
 */
export function SidebarSessionTree({
  rows,
  expandedSessionKeys,
  onToggleSessionExpanded,
  onOpenSession,
  depth = 1,
}: SidebarSessionTreeProps) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <View testID={depth === 1 ? "sidebar-session-tree" : undefined}>
      {rows.map((row) => (
        <SidebarSessionTreeRow
          key={row.key}
          row={row}
          depth={depth}
          expandedSessionKeys={expandedSessionKeys}
          onToggleSessionExpanded={onToggleSessionExpanded}
          onOpenSession={onOpenSession}
        />
      ))}
    </View>
  );
}

function SidebarSessionTreeRow({
  row,
  depth,
  expandedSessionKeys,
  onToggleSessionExpanded,
  onOpenSession,
}: {
  row: SidebarSessionRow;
  depth: number;
  expandedSessionKeys: ReadonlySet<string>;
  onToggleSessionExpanded: (sessionKey: string) => void;
  onOpenSession: (row: SidebarSessionRow) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const hasChildren = row.children.length > 0;
  const expanded = hasChildren && expandedSessionKeys.has(row.key);
  const label = resolveRowLabel(row.title) ?? t("common.states.loading");

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => onOpenSession(row), [onOpenSession, row]);
  const handleToggle = useCallback(
    () => onToggleSessionExpanded(row.key),
    [onToggleSessionExpanded, row.key],
  );

  return (
    <>
      <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={handlePress}
          highlightStyle={styles.rowPressed}
          style={[
            styles.row,
            isHovered && styles.rowHovered,
            inlineUnistylesStyle({ paddingLeft: ROW_BASE_PADDING + depth * ROW_INDENT }),
          ]}
          testID={`sidebar-session-row-${row.key}`}
        >
          <SidebarAgentStatusIndicator bucket={row.statusBucket} />
          {hasChildren ? (
            <SidebarTreeToggle
              expanded={expanded}
              onToggle={handleToggle}
              accessibilityLabel={t(
                expanded ? "sidebar.sessionTree.collapse" : "sidebar.sessionTree.expand",
              )}
              testID={`sidebar-session-tree-toggle-${row.key}`}
            />
          ) : null}
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
        </PressHighlight>
      </View>
      {expanded ? (
        <SidebarSessionTree
          rows={row.children}
          depth={depth + 1}
          expandedSessionKeys={expandedSessionKeys}
          onToggleSessionExpanded={onToggleSessionExpanded}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
}));
