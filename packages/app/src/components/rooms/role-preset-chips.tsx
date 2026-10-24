import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ROOM_ROLE_PRESETS } from "@/rooms/role-presets";

/**
 * Role preset chips (design §5.2/§5.5): the nine server-mirrored presets plus
 * a "custom" choice (roleId null). Shared by the create-room form and the
 * mid-room member-add sheet.
 */
export const RolePresetChips = memo(function RolePresetChips({
  selectedRoleId,
  onSelect,
  testIDPrefix = "room-form-member-role",
}: {
  selectedRoleId: string | null;
  onSelect: (roleId: string | null) => void;
  testIDPrefix?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.chipRow}>
      {ROOM_ROLE_PRESETS.map((preset) => (
        <RolePresetChip
          key={preset.roleId}
          roleId={preset.roleId}
          label={preset.label}
          selected={selectedRoleId === preset.roleId}
          onSelect={onSelect}
          testID={`${testIDPrefix}-${preset.roleId}`}
        />
      ))}
      <RolePresetChip
        roleId={null}
        label={t("rooms.form.roleCustom")}
        selected={selectedRoleId === null}
        onSelect={onSelect}
        testID={`${testIDPrefix}-custom`}
      />
    </View>
  );
});

const RolePresetChip = memo(function RolePresetChip({
  roleId,
  label,
  selected,
  onSelect,
  testID,
}: {
  roleId: string | null;
  label: string;
  selected: boolean;
  onSelect: (roleId: string | null) => void;
  testID: string;
}) {
  const handlePress = useCallback(() => onSelect(roleId), [onSelect, roleId]);
  return (
    <PressHighlight
      style={[styles.chip, selected ? styles.chipSelected : null]}
      onPress={handlePress}
      hitSlop={6}
      testID={testID}
    >
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{label}</Text>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chip: {
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  chipSelected: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.surface3,
  },
  chipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chipTextSelected: {
    color: theme.colors.foreground,
  },
}));
