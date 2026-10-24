import type { RoomFileEntry } from "@/rooms/rooms-query";

/**
 * Client-side mention highlighting for member statements (design §4.3).
 * Statement bodies render as plain text, segmented locally so `@displayName`
 * matches only land on prose: fenced code blocks and inline code spans are cut
 * out first and never matched, and no marker is ever injected into a markdown
 * source.
 */

export interface BodySegment {
  text: string;
  mention: boolean;
}

const CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

/** Split a statement body into code and prose segments (code never matched). */
export function splitCodeSegments(text: string): Array<{ text: string; code: boolean }> {
  const segments: Array<{ text: string; code: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(CODE_SEGMENT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), code: false });
    }
    segments.push({ text: match[0], code: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), code: false });
  }
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMentionPattern(displayNames: readonly string[]): RegExp | null {
  const names = [...new Set(displayNames.map((name) => name.trim()))]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length);
  if (names.length === 0) {
    return null;
  }
  // Longest names first, case-insensitive, and only complete @words: a name
  // followed by more letters/digits does not match (design §4.3).
  return new RegExp(`@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** Split prose into plain and @mentioned segments for nested Text rendering. */
export function splitMentionSegments(text: string, displayNames: readonly string[]): BodySegment[] {
  const pattern = buildMentionPattern(displayNames);
  if (!pattern) {
    return text.length > 0 ? [{ text, mention: false }] : [];
  }
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), mention: false });
    }
    segments.push({ text: match[0], mention: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), mention: false });
  }
  return segments;
}

/**
 * Attachment chips (design §4.3, v1 conservative match): a chip renders only
 * for a workspace-relative path that carries the room files directory prefix
 * AND is present in the latest `room.files.list` result.
 */
export function findAttachmentPaths(
  text: string,
  files: readonly RoomFileEntry[] | undefined,
  roomFilesDir: string,
): string[] {
  if (!files || files.length === 0 || roomFilesDir.length === 0) {
    return [];
  }
  const prefix = `${roomFilesDir}/`;
  const found: Array<{ path: string; index: number }> = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) {
      continue;
    }
    const index = text.indexOf(file.path);
    if (index >= 0) {
      found.push({ path: file.path, index });
    }
  }
  return found.sort((left, right) => left.index - right.index).map((entry) => entry.path);
}

/** The room files directory is the parent of the moderator's artifact path. */
export function roomFilesDirOf(artifactPath: string): string {
  const separator = Math.max(artifactPath.lastIndexOf("/"), artifactPath.lastIndexOf("\\"));
  return separator > 0 ? artifactPath.slice(0, separator) : "";
}

export function fileBaseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

export type RoomFileIconKind = "image" | "table" | "sql" | "file";

/** Icon bucket per extension, mirroring the prototype's `fileIcon`. */
export function roomFileIconKind(path: string): RoomFileIconKind {
  const name = fileBaseName(path).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) {
    return "image";
  }
  if (/\.(xlsx?|csv)$/.test(name)) {
    return "table";
  }
  if (/\.(sql|db|sqlite)$/.test(name)) {
    return "sql";
  }
  return "file";
}

export function formatRoomFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
