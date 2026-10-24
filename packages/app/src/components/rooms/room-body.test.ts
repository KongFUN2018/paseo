import { describe, expect, it } from "vitest";
import {
  findAttachmentPaths,
  roomFileIconKind,
  roomFilesDirOf,
  splitCodeSegments,
  splitMentionSegments,
} from "@/components/rooms/room-body";

describe("splitCodeSegments", () => {
  it("cuts out inline code spans and fenced blocks", () => {
    const segments = splitCodeSegments("运行 `@DBA` 再看：\n```\n@架构师 in fence\n```");
    expect(segments).toEqual([
      { text: "运行 ", code: false },
      { text: "`@DBA`", code: true },
      { text: " 再看：\n", code: false },
      { text: "```\n@架构师 in fence\n```", code: true },
    ]);
  });

  it("keeps plain prose as one segment", () => {
    expect(splitCodeSegments("结论：可行")).toEqual([{ text: "结论：可行", code: false }]);
  });
});

describe("splitMentionSegments", () => {
  const names = ["架构师", "DBA", "业务/产品", "老王"];

  it("matches complete mentions case-insensitively", () => {
    const segments = splitMentionSegments("@dba 请确认 @架构师 的改造量", names);
    expect(segments).toEqual([
      { text: "@dba", mention: true },
      { text: " 请确认 ", mention: false },
      { text: "@架构师", mention: true },
      { text: " 的改造量", mention: false },
    ]);
  });

  it("does not match a name embedded in a longer word", () => {
    expect(splitMentionSegments("@DBAx 请回复", names)).toEqual([
      { text: "@DBAx 请回复", mention: false },
    ]);
  });

  it("prefers the longest name when names overlap", () => {
    expect(splitMentionSegments("@老王 一下", ["老王", "老王二"])).toEqual([
      { text: "@老王", mention: true },
      { text: " 一下", mention: false },
    ]);
  });

  it("returns the text untouched without names", () => {
    expect(splitMentionSegments("没有点名", [])).toEqual([{ text: "没有点名", mention: false }]);
    expect(splitMentionSegments("", names)).toEqual([]);
  });
});

describe("findAttachmentPaths", () => {
  const files = [
    { path: ".paseo/rooms/review/方案.md", memberId: null, sizeBytes: 1, updatedAtMs: 1 },
    {
      path: ".paseo/rooms/review/member_1/数据.xlsx",
      memberId: "member_1",
      sizeBytes: 2,
      updatedAtMs: 2,
    },
    { path: "docs/outside.md", memberId: null, sizeBytes: 3, updatedAtMs: 3 },
  ];

  it("chips only room-dir paths that appear in the body and the files list", () => {
    const text =
      "细节在 .paseo/rooms/review/member_1/数据.xlsx，方案见 .paseo/rooms/review/方案.md";
    expect(findAttachmentPaths(text, files, ".paseo/rooms/review")).toEqual([
      ".paseo/rooms/review/member_1/数据.xlsx",
      ".paseo/rooms/review/方案.md",
    ]);
  });

  it("ignores paths outside the room dir or absent from the list", () => {
    expect(
      findAttachmentPaths(
        "见 docs/outside.md 和 .paseo/rooms/review/缺失.md",
        files,
        ".paseo/rooms/review",
      ),
    ).toEqual([]);
  });
});

describe("room file helpers", () => {
  it("derives the room files dir from the artifact path", () => {
    expect(roomFilesDirOf(".paseo/rooms/review/summary.md")).toBe(".paseo/rooms/review");
    expect(roomFilesDirOf("summary.md")).toBe("");
  });

  it("buckets file icons by extension", () => {
    expect(roomFileIconKind("a/b.png")).toBe("image");
    expect(roomFileIconKind("a/b.xlsx")).toBe("table");
    expect(roomFileIconKind("a/b.csv")).toBe("table");
    expect(roomFileIconKind("a/b.sql")).toBe("sql");
    expect(roomFileIconKind("a/b.md")).toBe("file");
  });
});
