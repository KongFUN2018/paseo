import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { RoomRecordSchema, type RoomRecord } from "@getpaseo/protocol/room/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

export function generateRoomId(): string {
  return `room_${randomBytes(4).toString("hex")}`;
}

type RoomUpdater = (room: RoomRecord) => RoomRecord | Promise<RoomRecord>;

function parseRoomRecord(
  content: string,
): { success: true; data: RoomRecord } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return RoomRecordSchema.safeParse(json);
}

export class RoomStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // Rooms are listed on every client connect, so an invalid file is reported once when it
  // first appears instead of on every list call.
  async list(): Promise<RoomRecord[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(this.dir, entry.name);
          return { filePath, parsed: parseRoomRecord(await readFile(filePath, "utf-8")) };
        }),
    );
    const rooms: RoomRecord[] = [];
    const invalidFiles = new Set<string>();
    for (const { filePath, parsed } of files) {
      if (parsed.success) {
        rooms.push(parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, "Skipping invalid room file");
      }
    }
    this.reportedInvalidFiles = invalidFiles;
    return rooms.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<RoomRecord | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return RoomRecordSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(room: Omit<RoomRecord, "id"> & { id?: string }): Promise<RoomRecord> {
    const created = RoomRecordSchema.parse({ ...room, id: room.id ?? generateRoomId() });
    await this.write(created);
    return created;
  }

  async update(id: string, updater: RoomUpdater): Promise<RoomRecord | null> {
    return this.serializeMutation(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      if (next.id !== id) {
        throw new Error(`Room update cannot change id: ${id}`);
      }
      const updated = RoomRecordSchema.parse(next);
      await this.write(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serializeMutation(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  private async write(room: RoomRecord): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(room.id), room);
  }

  private async serializeMutation<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) {
        this.mutations.delete(key);
      }
    }
  }
}
