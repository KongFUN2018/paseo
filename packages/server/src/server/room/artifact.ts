import { resolve } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * Writes the room summary artifact into the workspace (design §5.5).
 * `artifactPath` is workspace-relative and was validated at create time; the
 * write itself is atomic (temp file + rename) and UTF-8 encoded.
 */
export async function writeRoomArtifact(input: {
  workspaceDirectory: string;
  artifactPath: string;
  summary: string;
}): Promise<string> {
  const absolutePath = resolve(input.workspaceDirectory, input.artifactPath);
  await writeFileAtomic(absolutePath, input.summary);
  return absolutePath;
}
