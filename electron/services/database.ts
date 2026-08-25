import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  AiAnalysis,
  IndexedFile,
  LibraryQuery,
  RuleAnalysis,
  SkillDetail,
  SkillFormat,
  SkillSummary,
  SourceType,
  TaxonomySnapshot,
} from "../shared";

interface SkillRecord {
  id: string;
  name: string;
  description: string;
  format: SkillFormat;
  sourceType: SourceType;
  sourceUrl: string | null;
  sourceDisplay: string;
  libraryPath: string;
  originalPath: string | null;
  importedAt: string;
}

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

function stringValue(row: Row, key: string): string {
  return typeof row[key] === "string" ? row[key] as string : "";
}

function nullableString(row: Row, key: string): string | null {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class SkillDatabase {
  private readonly db: DatabaseSync;

  constructor(dataRoot: string) {
    const databaseDir = path.join(dataRoot, "database");
    mkdirSync(databaseDir, { recursive: true });
    this.db = new DatabaseSync(path.join(databaseDir, "skill-explorer.sqlite3"));
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        source_display TEXT NOT NULL,
        library_path TEXT NOT NULL,
        original_path TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        category TEXT,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        analysis_status TEXT NOT NULL DEFAULT 'not_started',
        removed_at TEXT,
        trashed_path TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        previewable INTEGER NOT NULL,
        is_entry_file INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        UNIQUE(skill_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        content TEXT NOT NULL,
        source_files TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        prompt_version TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
      CREATE TABLE IF NOT EXISTS skill_tags (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(skill_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(removed_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_files_skill ON files(skill_id);
      CREATE INDEX IF NOT EXISTS idx_analyses_skill ON analyses(skill_id, kind, created_at);
    `);
  }

  saveImportedSkill(record: SkillRecord, files: IndexedFile[], analysis: RuleAnalysis): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO skills (
          id, name, description, format, source_type, source_url, source_display,
          library_path, original_path, imported_at, updated_at, analysis_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started')
      `).run(
        record.id,
        record.name,
        record.description,
        record.format,
        record.sourceType,
        record.sourceUrl,
        record.sourceDisplay,
        record.libraryPath,
        record.originalPath,
        record.importedAt,
        record.importedAt,
      );
      const fileStatement = this.db.prepare(`
        INSERT INTO files (
          id, skill_id, relative_path, name, extension, type, size, content_hash,
          previewable, is_entry_file, hidden
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      files.forEach((file) => fileStatement.run(
        file.id,
        record.id,
        file.relativePath,
        file.name,
        file.extension,
        file.type,
        file.size,
        file.hash,
        file.previewable ? 1 : 0,
        file.isEntryFile ? 1 : 0,
        file.hidden ? 1 : 0,
      ));
      this.db.prepare(`
        INSERT INTO analyses (id, skill_id, kind, schema_version, content, source_files, created_at, status)
        VALUES (?, ?, 'rule', ?, ?, ?, ?, 'succeeded')
      `).run(
        crypto.randomUUID(),
        record.id,
        analysis.schemaVersion,
        JSON.stringify(analysis),
        JSON.stringify(files.filter((file) => file.isEntryFile).map((file) => file.relativePath)),
        record.importedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSkills(query: LibraryQuery = {}): SkillSummary[] {
    const conditions = ["s.removed_at IS NULL"];
    const parameters: SqlValue[] = [];
    if (query.search?.trim()) {
      conditions.push(`(
        LOWER(s.name) LIKE ? OR LOWER(s.description) LIKE ? OR
        EXISTS (SELECT 1 FROM files f WHERE f.skill_id = s.id AND LOWER(f.relative_path) LIKE ?) OR
        EXISTS (
          SELECT 1 FROM skill_tags st JOIN tags t ON t.id = st.tag_id
          WHERE st.skill_id = s.id AND LOWER(t.name) LIKE ?
        )
      )`);
      const needle = `%${query.search.trim().toLowerCase()}%`;
      parameters.push(needle, needle, needle, needle);
    }
    if (query.sourceType && query.sourceType !== "all") {
      conditions.push("s.source_type = ?");
      parameters.push(query.sourceType);
    }
    if (query.favoritesOnly) conditions.push("s.is_favorite = 1");
    if (query.aiStatus === "analyzed") conditions.push("s.analysis_status = 'succeeded'");
    if (query.aiStatus === "not_analyzed") conditions.push("s.analysis_status != 'succeeded'");
    if (query.category && query.category !== "all") {
      conditions.push("s.category = ?");
      parameters.push(query.category);
    }
    const rows = this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM files f WHERE f.skill_id = s.id) AS file_count
      FROM skills s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.is_favorite DESC, s.updated_at DESC
    `).all(...parameters) as Row[];
    return rows.map((row) => this.summaryFromRow(row));
  }

  getSkill(id: string, includeRemoved = false): SkillDetail {
    const skillRow = this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM files f WHERE f.skill_id = s.id) AS file_count
      FROM skills s WHERE s.id = ? ${includeRemoved ? "" : "AND s.removed_at IS NULL"}
    `).get(id) as Row | undefined;
    if (!skillRow) throw new Error("未找到该 Skill，它可能已被移除。");
    const fileRows = this.db.prepare("SELECT * FROM files WHERE skill_id = ? ORDER BY relative_path COLLATE NOCASE").all(id) as Row[];
    const ruleRow = this.db.prepare("SELECT * FROM analyses WHERE skill_id = ? AND kind = 'rule' ORDER BY created_at DESC LIMIT 1").get(id) as Row | undefined;
    const aiRow = this.db.prepare("SELECT * FROM analyses WHERE skill_id = ? AND kind = 'ai' ORDER BY created_at DESC LIMIT 1").get(id) as Row | undefined;
    return {
      ...this.summaryFromRow(skillRow),
      files: fileRows.map((row) => ({
        id: stringValue(row, "id"),
        relativePath: stringValue(row, "relative_path"),
        name: stringValue(row, "name"),
        extension: stringValue(row, "extension"),
        type: stringValue(row, "type") as IndexedFile["type"],
        size: Number(row.size || 0),
        hash: stringValue(row, "content_hash"),
        previewable: Boolean(row.previewable),
        isEntryFile: Boolean(row.is_entry_file),
        hidden: Boolean(row.hidden),
      })),
      ruleAnalysis: parseJson<RuleAnalysis>(ruleRow?.content, {
        schemaVersion: "1.0",
        parserLabel: "规则解析",
        items: [],
        references: [],
        warnings: ["规则解析结果不存在"],
      }),
      aiAnalysis: aiRow ? {
        id: stringValue(aiRow, "id"),
        content: parseJson<Record<string, unknown>>(aiRow.content, {}),
        model: nullableString(aiRow, "model") || "",
        sourceFiles: parseJson<string[]>(aiRow.source_files, []),
        promptVersion: nullableString(aiRow, "prompt_version") || "",
        createdAt: stringValue(aiRow, "created_at"),
        status: stringValue(aiRow, "status") as AiAnalysis["status"],
      } : null,
    };
  }

  getInternalPaths(id: string): { libraryPath: string; originalPath: string | null; trashedPath: string | null } {
    const row = this.db.prepare("SELECT library_path, original_path, trashed_path FROM skills WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error("未找到该 Skill。");
    return {
      libraryPath: stringValue(row, "library_path"),
      originalPath: nullableString(row, "original_path"),
      trashedPath: nullableString(row, "trashed_path"),
    };
  }

  replaceRuleAnalysis(skillId: string, name: string, description: string, analysis: RuleAnalysis): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE skills SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now, skillId);
      this.db.prepare("DELETE FROM analyses WHERE skill_id = ? AND kind = 'rule'").run(skillId);
      this.db.prepare(`
        INSERT INTO analyses (id, skill_id, kind, schema_version, content, source_files, created_at, status)
        VALUES (?, ?, 'rule', ?, ?, '[]', ?, 'succeeded')
      `).run(crypto.randomUUID(), skillId, analysis.schemaVersion, JSON.stringify(analysis), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveAiAnalysis(skillId: string, analysis: Omit<AiAnalysis, "id">): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO analyses (id, skill_id, kind, schema_version, content, source_files, model, prompt_version, created_at, status)
        VALUES (?, ?, 'ai', '1.0', ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        skillId,
        JSON.stringify(analysis.content),
        JSON.stringify(analysis.sourceFiles),
        analysis.model,
        analysis.promptVersion,
        analysis.createdAt,
        analysis.status,
      );
      this.db.prepare("UPDATE skills SET analysis_status = ?, updated_at = ? WHERE id = ?").run(analysis.status, analysis.createdAt, skillId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAnalysisStatus(skillId: string, status: string): void {
    this.db.prepare("UPDATE skills SET analysis_status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), skillId);
  }

  setFavorite(skillId: string, value: boolean): void {
    this.db.prepare("UPDATE skills SET is_favorite = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(value ? 1 : 0, new Date().toISOString(), skillId);
  }

  updateTaxonomy(skillId: string, category: string | null, tags: string[]): void {
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE skills SET category = ?, updated_at = ? WHERE id = ?").run(category?.trim() || null, new Date().toISOString(), skillId);
      this.db.prepare("DELETE FROM skill_tags WHERE skill_id = ?").run(skillId);
      for (const tag of normalizedTags) {
        this.db.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(tag);
        const tagRow = this.db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").get(tag) as Row;
        this.db.prepare("INSERT INTO skill_tags(skill_id, tag_id) VALUES (?, ?)").run(skillId, Number(tagRow.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTaxonomy(): TaxonomySnapshot {
    const categories = (this.db.prepare("SELECT DISTINCT category FROM skills WHERE category IS NOT NULL AND removed_at IS NULL ORDER BY category COLLATE NOCASE").all() as Row[])
      .map((row) => stringValue(row, "category"));
    const tags = (this.db.prepare(`
      SELECT DISTINCT t.name FROM tags t
      JOIN skill_tags st ON st.tag_id = t.id
      JOIN skills s ON s.id = st.skill_id
      WHERE s.removed_at IS NULL ORDER BY t.name COLLATE NOCASE
    `).all() as Row[]).map((row) => stringValue(row, "name"));
    return { categories, tags };
  }

  markRemoved(skillId: string, trashedPath: string): void {
    this.db.prepare("UPDATE skills SET removed_at = ?, trashed_path = ?, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      trashedPath,
      new Date().toISOString(),
      skillId,
    );
  }

  restore(skillId: string): void {
    this.db.prepare("UPDATE skills SET removed_at = NULL, trashed_path = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), skillId);
  }

  private summaryFromRow(row: Row): SkillSummary {
    const id = stringValue(row, "id");
    const tags = (this.db.prepare(`
      SELECT t.name FROM tags t JOIN skill_tags st ON st.tag_id = t.id
      WHERE st.skill_id = ? ORDER BY t.name COLLATE NOCASE
    `).all(id) as Row[]).map((tagRow) => stringValue(tagRow, "name"));
    return {
      id,
      name: stringValue(row, "name"),
      description: stringValue(row, "description"),
      format: stringValue(row, "format") as SkillFormat,
      sourceType: stringValue(row, "source_type") as SourceType,
      sourceDisplay: stringValue(row, "source_display"),
      importedAt: stringValue(row, "imported_at"),
      updatedAt: stringValue(row, "updated_at"),
      category: nullableString(row, "category"),
      tags,
      isFavorite: Boolean(row.is_favorite),
      analysisStatus: stringValue(row, "analysis_status") as SkillSummary["analysisStatus"],
      fileCount: Number(row.file_count || 0),
    };
  }
}
