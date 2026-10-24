import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertInsideWorkspaceDirectory, formatRoomFilesManifest, listRoomFiles } from "./files.js";

describe("listRoomFiles", () => {
  let workDir: string;
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of cleanup.toReversed()) await dispose();
    cleanup.length = 0;
  });

  async function buildWorkspace(): Promise<string> {
    workDir = await mkdtemp(join(tmpdir(), "room-files-ws-"));
    cleanup.push(async () => rm(workDir, { recursive: true, force: true }));
    return workDir;
  }

  test("returns an empty list when the room files directory does not exist", async () => {
    const workspace = await buildWorkspace();
    const files = await listRoomFiles({
      workspaceDirectory: workspace,
      roomFilesDir: "notes",
      memberIds: ["member_1"],
    });
    expect(files).toEqual([]);
  });

  test("lists files with member attribution and workspace-relative paths", async () => {
    const workspace = await buildWorkspace();
    await mkdir(join(workspace, "notes", "member_1"), { recursive: true });
    await writeFile(join(workspace, "notes", "member_1", "api.md"), "内容");
    await writeFile(join(workspace, "notes", "summary.md"), "总结");
    await writeFile(join(workspace, "notes", "root.txt"), "x");

    const files = await listRoomFiles({
      workspaceDirectory: workspace,
      roomFilesDir: "notes",
      memberIds: ["member_1"],
    });

    expect(files.map((file) => file.path)).toEqual([
      "notes/member_1/api.md",
      "notes/root.txt",
      "notes/summary.md",
    ]);
    expect(files[0]).toMatchObject({ memberId: "member_1", sizeBytes: 6 });
    expect(files[1]).toMatchObject({ memberId: null });
    expect(files[2]).toMatchObject({ memberId: null });
    expect(files[0]?.updatedAtMs).toBeGreaterThan(0);
  });

  test("caps the walk depth at four levels below the root", async () => {
    const workspace = await buildWorkspace();
    const deep = join(workspace, "notes", "l1", "l2", "l3");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "depth4.md"), "ok");
    await mkdir(join(deep, "l4"), { recursive: true });
    await writeFile(join(deep, "l4", "depth5.md"), "too deep");

    const files = await listRoomFiles({
      workspaceDirectory: workspace,
      roomFilesDir: "notes",
    });

    expect(files.map((file) => file.path)).toEqual(["notes/l1/l2/l3/depth4.md"]);
  });

  test("caps the entry count at 200", async () => {
    const workspace = await buildWorkspace();
    await mkdir(join(workspace, "notes"), { recursive: true });
    for (let index = 0; index < 205; index++) {
      await writeFile(join(workspace, "notes", `file-${String(index).padStart(3, "0")}.txt`), "x");
    }

    const files = await listRoomFiles({
      workspaceDirectory: workspace,
      roomFilesDir: "notes",
    });

    expect(files).toHaveLength(200);
  });

  test("skips symlinked directories instead of following them", async () => {
    const workspace = await buildWorkspace();
    await mkdir(join(workspace, "notes"), { recursive: true });
    await mkdir(join(workspace, "outside"), { recursive: true });
    await writeFile(join(workspace, "outside", "secret.txt"), "secret");
    await writeFile(join(workspace, "notes", "real.txt"), "real");
    // A junction needs no privileges on Windows and is a plain symlink on
    // POSIX; readdir reports both as symlinked directories.
    await symlink(join(workspace, "outside"), join(workspace, "notes", "link-dir"), "junction");

    const files = await listRoomFiles({
      workspaceDirectory: workspace,
      roomFilesDir: "notes",
    });

    expect(files.map((file) => file.path)).toEqual(["notes/real.txt"]);
  });

  test("rejects a room files directory that escapes the workspace", async () => {
    const workspace = await buildWorkspace();
    await expect(
      listRoomFiles({ workspaceDirectory: workspace, roomFilesDir: "../outside" }),
    ).rejects.toThrow(/inside the workspace/);
  });
});

describe("assertInsideWorkspaceDirectory", () => {
  test("accepts a resolved path inside the workspace and rejects siblings", () => {
    const workspace = join(tmpdir(), "room-files-ws-check");
    expect(() => assertInsideWorkspaceDirectory(join(workspace, "notes"), workspace)).not.toThrow();
    expect(() =>
      assertInsideWorkspaceDirectory(join(tmpdir(), "room-files-elsewhere"), workspace),
    ).toThrow(/inside the workspace/);
  });
});

describe("formatRoomFilesManifest", () => {
  test("renders the empty placeholder and per-file lines", () => {
    expect(formatRoomFilesManifest([])).toBe("（还没有产出物。）");
    expect(
      formatRoomFilesManifest([
        { path: "notes/member_1/api.md", memberId: "member_1", sizeBytes: 12, updatedAtMs: 1 },
        { path: "notes/summary.md", memberId: null, sizeBytes: 3, updatedAtMs: 2 },
      ]),
    ).toBe("- notes/member_1/api.md（member_1，12 bytes）\n- notes/summary.md（房间根，3 bytes）");
  });
});
