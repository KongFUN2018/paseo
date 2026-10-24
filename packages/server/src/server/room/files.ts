import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** One room file entry for `room.files.list` and prompt injection (design §8.4). */
export interface RoomFileEntry {
  /** Workspace-relative path with `/` separators. */
  path: string;
  /** Owning member id; null means the moderator summary or a root-level file. */
  memberId: string | null;
  sizeBytes: number;
  updatedAtMs: number;
}

const MAX_DEPTH = 4;
const MAX_ENTRIES = 200;

/**
 * The workspace-inside prefix check shared with artifactPath validation
 * (design §8.4): the resolved path must stay inside the workspace directory.
 */
export function assertInsideWorkspaceDirectory(
  resolvedPath: string,
  workspaceDirectory: string,
): void {
  const prefix = workspaceDirectory.endsWith(sep) ? workspaceDirectory : workspaceDirectory + sep;
  if (!resolvedPath.startsWith(prefix)) {
    throw new Error("path must stay inside the workspace directory");
  }
}

/**
 * List the files of a room's files directory (design §8.4). Read-only: the
 * directory itself is created by member agents, never by this function.
 * Depth is capped at 4 levels below the root, entries at 200, symlinks are
 * never followed, and a missing directory yields an empty list.
 */
export async function listRoomFiles(input: {
  workspaceDirectory: string;
  roomFilesDir: string;
  memberIds?: readonly string[];
}): Promise<RoomFileEntry[]> {
  const root = resolve(input.workspaceDirectory, input.roomFilesDir);
  assertInsideWorkspaceDirectory(root, input.workspaceDirectory);
  const memberIds = new Set(input.memberIds ?? []);
  const entries: RoomFileEntry[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
    let dirents: Dirent[];
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // The room files root is created lazily by member agents; treat any
      // missing level as empty. Everything else fails loud.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) return;
      if (dirent.isSymbolicLink()) continue;
      const absolutePath = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      let sizeBytes: number;
      let updatedAtMs: number;
      try {
        const stats = await stat(absolutePath);
        sizeBytes = stats.size;
        updatedAtMs = stats.mtimeMs;
      } catch (error) {
        // The file vanished between readdir and stat; skip it instead of
        // failing the whole listing.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const relativeToWorkspace = relative(input.workspaceDirectory, absolutePath);
      const relativeToRoot = relative(root, absolutePath);
      const firstSegment = relativeToRoot.split(sep)[0] ?? "";
      entries.push({
        path: relativeToWorkspace.split(sep).join("/"),
        memberId: firstSegment !== "" && memberIds.has(firstSegment) ? firstSegment : null,
        sizeBytes,
        updatedAtMs,
      });
    }
  }

  await walk(root, 1);
  return entries;
}

/**
 * Render a file manifest for prompt injection (design §8.2/§7.5): paths plus
 * size and producer, never file content.
 */
export function formatRoomFilesManifest(entries: readonly RoomFileEntry[]): string {
  if (entries.length === 0) return "（还没有产出物。）";
  return entries
    .map((entry) => `- ${entry.path}（${entry.memberId ?? "房间根"}，${entry.sizeBytes} bytes）`)
    .join("\n");
}
