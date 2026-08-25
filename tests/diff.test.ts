import assert from "node:assert/strict";
import test from "node:test";
import { compareFileIndexes, createLineDiff } from "../electron/services/diff.ts";
import type { IndexedFile } from "../electron/shared.ts";

function indexed(relativePath: string, hash: string, size = 10): IndexedFile {
  return { id: `${relativePath}-${hash}`, relativePath, name: relativePath, extension: "md", type: "markdown", size, hash, previewable: true, isEntryFile: relativePath === "SKILL.md", hidden: false };
}

test("目录差异能区分新增、修改和删除", () => {
  const changes = compareFileIndexes(
    [indexed("SKILL.md", "old"), indexed("removed.md", "same")],
    [indexed("SKILL.md", "new"), indexed("added.md", "same")],
  );
  assert.deepEqual(changes.map((item) => [item.relativePath, item.kind]), [
    ["SKILL.md", "modified"],
    ["added.md", "added"],
    ["removed.md", "deleted"],
  ]);
});

test("逐行差异保留上下文和新旧行号", () => {
  const lines = createLineDiff("one\ntwo\nthree", "one\nsecond\nthree\nfour");
  assert.ok(lines.some((line) => line.kind === "deleted" && line.content === "two" && line.oldLine === 2));
  assert.ok(lines.some((line) => line.kind === "added" && line.content === "second" && line.newLine === 2));
  assert.ok(lines.some((line) => line.kind === "context" && line.content === "three"));
  assert.ok(lines.some((line) => line.kind === "added" && line.content === "four" && line.newLine === 4));
});
