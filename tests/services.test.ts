import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillDatabase } from "../electron/services/database.ts";
import { copyDirectorySafely, indexDirectory, readTextFile, scanDirectory } from "../electron/services/files.ts";
import { parseSkill } from "../electron/services/parser.ts";

test("安全复制不修改原目录，并跳过符号链接", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-explorer-files-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "copy");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  const entryContent = "---\nname: safe-copy\ndescription: 测试安全复制\n---\n# Safe copy\n\n## Workflow\n1. Read files.\n";
  writeFileSync(path.join(source, "SKILL.md"), entryContent);
  writeFileSync(path.join(source, "scripts", "run.sh"), "echo never-run\n");
  writeFileSync(path.join(root, "outside.txt"), "private");
  symlinkSync(path.join(root, "outside.txt"), path.join(source, "outside-link"));

  const before = readFileSync(path.join(source, "SKILL.md"), "utf8");
  const scan = await scanDirectory(source);
  await copyDirectorySafely(source, destination);
  const indexed = await indexDirectory(destination);

  assert.equal(scan.hasSkillEntry, true);
  assert.ok(scan.warnings.some((warning) => warning.includes("符号链接")));
  assert.equal(readFileSync(path.join(source, "SKILL.md"), "utf8"), before);
  assert.equal(indexed.some((file) => file.relativePath === "outside-link"), false);
  assert.equal(indexed.some((file) => file.relativePath === "scripts/run.sh"), true);
  await assert.rejects(() => readTextFile(destination, "../outside.txt"), /越界/);
});

test("SQLite 资料库支持入库、搜索、分类、标签和收藏", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-explorer-db-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const contentRoot = path.join(root, "library", "content");
  mkdirSync(contentRoot, { recursive: true });
  const entryContent = "---\nname: legal-research\ndescription: 检索法律资料\n---\n# Legal research\n\n## Trigger\nUse when researching a case.\n";
  writeFileSync(path.join(contentRoot, "SKILL.md"), entryContent);
  const files = await indexDirectory(contentRoot);
  const parsed = parseSkill({ entryPath: "SKILL.md", entryContent, files, fallbackName: "fallback" });
  const database = new SkillDatabase(root);
  const id = randomUUID();
  const now = new Date().toISOString();
  database.saveImportedSkill({
    id,
    name: parsed.name,
    description: parsed.description,
    format: "codex",
    sourceType: "local",
    sourceUrl: null,
    sourceDisplay: "…/skills/legal-research",
    libraryPath: path.join(root, "library"),
    originalPath: path.join(root, "source"),
    importedAt: now,
  }, files, parsed.analysis);
  database.updateTaxonomy(id, "法律检索", ["案例", "Codex"]);
  database.setFavorite(id, true);

  assert.equal(database.listSkills({ search: "案例" }).length, 1);
  assert.equal(database.listSkills({ favoritesOnly: true })[0].name, "legal-research");
  assert.deepEqual(database.getTaxonomy().categories, ["法律检索"]);
  assert.deepEqual(database.getSkill(id).tags, ["Codex", "案例"]);
});
