/**
 * Room member role presets (design §5.2). Mirrors the server-side library in
 * `packages/server/src/server/room/role-prompts.ts` — keys must stay 1:1 with
 * `ROLE_PROMPTS`, and the labels match its Chinese labels because the label
 * seeds the member's `displayName`, which is the name every member sees in
 * prompts and transcripts. These are intentionally not i18n'd.
 */
export interface RoomRolePreset {
  roleId: string;
  label: string;
}

export const ROOM_ROLE_PRESETS: readonly RoomRolePreset[] = [
  { roleId: "architect", label: "架构师" },
  { roleId: "dba", label: "DBA" },
  { roleId: "backend", label: "后端" },
  { roleId: "frontend", label: "前端" },
  { roleId: "ops", label: "运维/SRE" },
  { roleId: "security", label: "安全" },
  { roleId: "qa", label: "测试" },
  { roleId: "data", label: "数据/报表" },
  { roleId: "product", label: "业务/产品" },
];

export function roomRolePresetLabel(roleId: string): string | null {
  return ROOM_ROLE_PRESETS.find((preset) => preset.roleId === roleId)?.label ?? null;
}
