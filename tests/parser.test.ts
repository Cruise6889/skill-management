import assert from "node:assert/strict";
import test from "node:test";
import { parseSkill } from "../electron/services/parser.ts";
import type { IndexedFile } from "../electron/shared.ts";

function file(relativePath: string, entry = false): IndexedFile {
  return {
    id: relativePath,
    relativePath,
    name: relativePath.split("/").at(-1) || relativePath,
    extension: relativePath.split(".").at(-1) || "",
    type: relativePath.endsWith(".md") ? "markdown" : "code",
    size: 10,
    hash: "hash",
    previewable: true,
    isEntryFile: entry,
    hidden: false,
  };
}

test("解析 frontmatter、流程、约束和文件职责", () => {
  const result = parseSkill({
    entryPath: "SKILL.md",
    fallbackName: "fallback",
    files: [file("SKILL.md", true), file("scripts/run.ts"), file("references/guide.md")],
    entryContent: `---
name: demo-skill
description: 用于安全拆解演示项目
---
# Demo

## Trigger
- Use when a user asks to inspect a skill.

## Workflow
1. Read \`references/guide.md\`.
2. Run \`scripts/run.ts\`.

## Constraints
- Never execute imported scripts automatically.
`,
  });

  assert.equal(result.name, "demo-skill");
  assert.equal(result.description, "用于安全拆解演示项目");
  assert.ok(result.analysis.items.some((item) => item.section === "workflow"));
  assert.ok(result.analysis.items.some((item) => item.section === "constraints"));
  assert.ok(result.analysis.items.some((item) => item.section === "file_roles" && item.title === "可执行脚本"));
  assert.equal(result.analysis.references.filter((reference) => reference.status === "resolved").length, 2);
});

test("越界和缺失引用不会被当作可读文件", () => {
  const result = parseSkill({
    entryPath: "SKILL.md",
    fallbackName: "demo",
    files: [file("SKILL.md", true)],
    entryContent: "# Demo\n\nRead `../secret.txt` and `references/missing.md`.",
  });

  assert.equal(result.analysis.references[0].status, "outside");
  assert.equal(result.analysis.references[1].status, "missing");
  assert.equal(result.analysis.warnings.length, 2);
});
