import { memo, useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { Database, File, Image as ImageIcon, Table, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import type { RoomRecord } from "@getpaseo/protocol/room/types";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  fileBaseName,
  formatRoomFileSize,
  roomFileIconKind,
  type RoomFileIconKind,
} from "@/components/rooms/room-body";
import {
  roomMemberAvatarChar,
  roomMemberDisplayName,
  roomProviderModelLabel,
} from "@/components/rooms/room-members";
import type { RoomFileEntry } from "@/rooms/rooms-query";
import { ROOM_AVATAR_FILL, roomNameStyle } from "@/components/rooms/room-identity-styles";
import { deriveIdentityColorName, type IdentityColorName } from "@/styles/identity-colors";
import { formatMessageTimestamp } from "@/utils/time";
import { StyleSheet as RNStyleSheet } from "react-native";

const FILE_ICONS: Record<RoomFileIconKind, typeof File> = {
  image: ImageIcon,
  table: Table,
  sql: Database,
  file: File,
};

interface FileGroup {
  key: string;
  /** Member-owned group header; null for the summary and room-root groups. */
  header: {
    memberId: string;
    name: string;
    avatarChar: string;
    colorName: IdentityColorName;
    providerModel: string;
  } | null;
  files: RoomFileEntry[];
}

/**
 * Drawer grouping (design §8.3): moderator summary, then one group per member,
 * then room-root files. Newest first within a group.
 */
export function groupRoomFiles(room: RoomRecord, files: readonly RoomFileEntry[]): FileGroup[] {
  const byMember = new Map<string, RoomFileEntry[]>();
  const root: RoomFileEntry[] = [];
  const summary: RoomFileEntry[] = [];
  for (const file of files) {
    if (file.memberId === null) {
      if (file.path === room.artifactPath) {
        summary.push(file);
      } else {
        root.push(file);
      }
      continue;
    }
    const bucket = byMember.get(file.memberId);
    if (bucket) {
      bucket.push(file);
    } else {
      byMember.set(file.memberId, [file]);
    }
  }
  const byUpdated = (left: RoomFileEntry, right: RoomFileEntry) =>
    right.updatedAtMs - left.updatedAtMs;
  summary.sort(byUpdated);
  root.sort(byUpdated);
  const groups: FileGroup[] = [];
  if (summary.length > 0) {
    groups.push({ key: "summary", header: null, files: summary });
  }
  for (const member of room.members) {
    const bucket = byMember.get(member.id);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    bucket.sort(byUpdated);
    groups.push({
      key: member.id,
      header: {
        memberId: member.id,
        name: roomMemberDisplayName(member),
        avatarChar: roomMemberAvatarChar(member),
        colorName: deriveIdentityColorName(member.id),
        providerModel: roomProviderModelLabel(member.provider, member.model),
      },
      files: bucket,
    });
  }
  // Artifacts of members no longer on the roster still belong somewhere visible.
  const knownMemberIds = new Set(room.members.map((member) => member.id));
  for (const [memberId, bucket] of byMember) {
    if (!knownMemberIds.has(memberId)) {
      root.push(...bucket);
    }
  }
  if (root.length > 0) {
    root.sort(byUpdated);
    groups.push({ key: "root", header: null, files: root });
  }
  return groups;
}

const FileRow = memo(function FileRow({
  file,
  onOpenFile,
}: {
  file: RoomFileEntry;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = FILE_ICONS[roomFileIconKind(file.path)];
  const handlePress = useCallback(() => onOpenFile(file.path), [file.path, onOpenFile]);
  return (
    <PressHighlight
      style={styles.fileRow}
      onPress={handlePress}
      accessibilityLabel={t("rooms.files.openFile", { name: fileBaseName(file.path) })}
      testID={`room-file-${file.path}`}
    >
      <View style={styles.fileIcon}>
        <Icon size={16} color={styles.metaText.color} />
      </View>
      <View style={styles.fileColumn}>
        <Text style={styles.fileName} numberOfLines={1}>
          {fileBaseName(file.path)}
        </Text>
        <Text style={styles.metaText} numberOfLines={1}>
          {formatRoomFileSize(file.sizeBytes)} ·{" "}
          {formatMessageTimestamp(new Date(file.updatedAtMs))}
        </Text>
      </View>
    </PressHighlight>
  );
});

const FileGroupHeader = memo(function FileGroupHeader({
  header,
}: {
  header: NonNullable<FileGroup["header"]>;
}) {
  return (
    <View style={styles.groupHeader}>
      <View style={[styles.groupAvatar, ROOM_AVATAR_FILL[header.colorName]]}>
        <Text style={styles.groupAvatarChar}>{header.avatarChar}</Text>
      </View>
      <Text style={[roomNameStyle(header.colorName), styles.groupName]} numberOfLines={1}>
        {header.name}
      </Text>
      <Text style={styles.metaText} numberOfLines={1}>
        {header.providerModel}
      </Text>
    </View>
  );
});

/**
 * Room files drawer (design §8.3): a right-side slide-over inside the room
 * panel. Previewing reuses the existing file tab via `openPreferredTarget`, so
 * no renderer lives here.
 */
export function RoomFilesDrawer({
  room,
  files,
  onClose,
  onOpenFile,
}: {
  room: RoomRecord;
  files: readonly RoomFileEntry[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupRoomFiles(room, files), [files, room]);
  return (
    <View style={RNStyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[RNStyleSheet.absoluteFill, maskStyles.mask]}
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(180)}
      >
        <PressHighlight
          style={RNStyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel={t("common.actions.cancel")}
          testID="room-files-drawer-mask"
        />
      </Animated.View>
      <Animated.View
        style={drawerStyles.drawer}
        entering={SlideInRight.duration(220)}
        exiting={SlideOutRight.duration(220)}
      >
        <View style={styles.drawerSurface}>
          <View style={styles.drawerHeader}>
            <Text style={styles.drawerTitle} numberOfLines={1}>
              {t("rooms.files.title")}
            </Text>
            <Text style={styles.metaText}>{t("rooms.files.count", { count: files.length })}</Text>
            <PressHighlight
              onPress={onClose}
              accessibilityLabel={t("common.actions.close")}
              // 16px glyph + 14px slop on every side = 44px touch target.
              hitSlop={14}
              testID="room-files-drawer-close"
            >
              <X size={16} color={styles.metaText.color} />
            </PressHighlight>
          </View>
          <ScrollView contentContainerStyle={drawerStyles.content}>
            {groups.length === 0 ? (
              <Text style={styles.emptyText}>{t("rooms.files.empty")}</Text>
            ) : (
              groups.map((group) => (
                <View key={group.key}>
                  {group.header ? (
                    <FileGroupHeader header={group.header} />
                  ) : (
                    <Text style={styles.groupNameSolo} numberOfLines={1}>
                      {group.key === "summary"
                        ? t("rooms.files.summaryGroup")
                        : t("rooms.files.rootGroup")}
                    </Text>
                  )}
                  {group.files.map((file) => (
                    <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}

// Geometry that Reanimated patches stays in a plain RN stylesheet.
const drawerStyles = RNStyleSheet.create({
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "86%",
    maxWidth: 360,
  },
  content: {
    paddingBottom: 24,
  },
});

const maskStyles = RNStyleSheet.create({
  mask: {
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
});

const styles = StyleSheet.create((theme) => ({
  drawerSurface: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  drawerTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  groupAvatar: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  groupAvatarChar: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
  },
  groupName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  groupNameSolo: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
  },
  fileIcon: {
    width: 20,
    alignItems: "center",
  },
  fileColumn: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  fileName: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[6],
    textAlign: "center",
  },
}));
