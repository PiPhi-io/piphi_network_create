import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function assertMatchesSnapshot(actual, snapshotPath) {
  const normalized = normalizeSnapshot(actual);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, normalized, "utf8");
    return;
  }
  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot is missing: ${snapshotPath}\nRun UPDATE_SNAPSHOTS=1 npm test to create it.`);
  }
  const expected = await readFile(snapshotPath, "utf8");
  assert.equal(normalized, expected, snapshotPath);
}

function normalizeSnapshot(value) {
  return value.replaceAll("\r\n", "\n");
}
