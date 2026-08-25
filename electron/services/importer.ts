import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import type { GithubPreflight, ImportProgress, LocalPreflight, RuleAnalysis, SkillDetail } from "../shared";
import { SkillDatabase } from "./database";
import { copyDirectorySafely, indexDirectory, previewFile, readTextFile, scanDirectory } from "./files";
import { parseSkill } from "./parser";

interface PendingLocal {
  sourcePath: string;
  preflight: LocalPreflight;
}

interface PendingGithub {
  clonePath: string;
  url: string;
  preflight: GithubPreflight;
}

function displayLocalPath(absolutePath: string): string {
  const parts = absolutePath.split(path.sep).filter(Boolean);
  return parts.length <= 2 ? absolutePath : `…/${parts.slice(-2).join("/")}`;
}

function githubUrl(value: string): { normalized: string; owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入公开 GitHub 仓库地址。");
  }
  const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || segments.length !== 2) {
    throw new Error("请输入 https://github.com/{owner}/{repo} 格式的公开仓库地址。");
  }
  return { normalized: `https://github.com/${segments[0]}/${segments[1]}.git`, owner: segments[0], repo: segments[1] };
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      reject(error.message.includes("ENOENT") ? new Error("未找到 Git，请安装 Git 或改用本机目录导入。") : error);
    });
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const lowered = stderr.toLowerCase();
      if (lowered.includes("not found") || lowered.includes("repository not found")) return reject(new Error("仓库不存在或地址错误，请先在浏览器中确认地址。"));
      if (lowered.includes("authentication") || lowered.includes("403") || lowered.includes("permission")) return reject(new Error("无法访问该仓库，MVP 仅支持公开仓库。"));
      if (lowered.includes("could not resolve host") || lowered.includes("timed out") || lowered.includes("failed to connect")) return reject(new Error("无法连接 GitHub，请检查网络后重试。"));
      return reject(new Error("克隆失败，请检查仓库地址和网络状态。"));
    });
  });
}

async function findCandidates(root: string): Promise<GithubPreflight["candidates"]> {
  const candidates: GithubPreflight["candidates"] = [];
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const relativePath = path.relative(root, current).split(path.sep).join("/") || ".";
      candidates.push({ relativePath, label: relativePath === "." ? path.basename(root) : path.basename(current), confidence: "high" });
      return;
    }
    const hasConventionalDir = entries.some((entry) => entry.isDirectory() && ["scripts", "references", "assets"].includes(entry.name));
    const hasMarkdown = entries.some((entry) => entry.isFile() && /\.md$/i.test(entry.name));
    if (hasConventionalDir && hasMarkdown) {
      const relativePath = path.relative(root, current).split(path.sep).join("/") || ".";
      candidates.push({ relativePath, label: path.basename(current), confidence: "low" });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      await visit(path.join(current, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return candidates.length ? candidates : [{ relativePath: ".", label: path.basename(root), confidence: "low" }];
}

export class ImportService {
  private readonly localTokens = new Map<string, PendingLocal>();
  private readonly githubTokens = new Map<string, PendingGithub>();

  constructor(
    private readonly dataRoot: string,
    private readonly database: SkillDatabase,
    private readonly emitProgress: (progress: ImportProgress) => void,
  ) {}

  async chooseLocalDirectory(window: BrowserWindow): Promise<LocalPreflight | null> {
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "选择一个 Skill 目录" });
    if (result.canceled || !result.filePaths[0]) return null;
    this.emitProgress({ stage: "checking", message: "正在只读检查目录…" });
    const sourcePath = result.filePaths[0];
    const scan = await scanDirectory(sourcePath);
    const token = randomUUID();
    const preflight: LocalPreflight = {
      token,
      directoryName: path.basename(sourcePath),
      sourceDisplay: displayLocalPath(sourcePath),
      fileCount: scan.fileCount,
      totalBytes: scan.totalBytes,
      hasSkillEntry: scan.hasSkillEntry,
      format: scan.hasSkillEntry ? "codex" : "custom",
      warnings: scan.warnings,
    };
    this.localTokens.set(token, { sourcePath, preflight });
    return preflight;
  }

  async confirmLocalImport(token: string): Promise<SkillDetail> {
    const pending = this.localTokens.get(token);
    if (!pending) throw new Error("导入确认已过期，请重新选择目录。");
    try {
      return await this.importFromDirectory(pending.sourcePath, {
        sourceType: "local",
        sourceUrl: null,
        sourceDisplay: pending.preflight.sourceDisplay,
        originalPath: pending.sourcePath,
        fallbackName: pending.preflight.directoryName,
      });
    } finally {
      this.localTokens.delete(token);
    }
  }

  async inspectGithub(value: string): Promise<GithubPreflight> {
    const parsed = githubUrl(value);
    this.emitProgress({ stage: "checking", message: "正在连接 GitHub 并读取仓库…" });
    const token = randomUUID();
    const clonePath = path.join(this.dataRoot, "temp", `github-${token}`, "repository");
    await fs.mkdir(path.dirname(clonePath), { recursive: true });
    try {
      await runGit(["-c", "core.hooksPath=/dev/null", "clone", "--depth=1", "--no-tags", "--filter=blob:none", "--no-recurse-submodules", parsed.normalized, clonePath]);
      const branch = await runGit(["-c", "core.hooksPath=/dev/null", "branch", "--show-current"], clonePath);
      const candidates = await findCandidates(clonePath);
      const preflight: GithubPreflight = {
        token,
        repositoryName: `${parsed.owner}/${parsed.repo}`,
        defaultBranch: branch || "default",
        candidates,
        warnings: candidates.every((candidate) => candidate.confidence === "low") ? ["未检测到标准 SKILL.md，可作为自定义格式导入"] : [],
      };
      this.githubTokens.set(token, { clonePath, url: parsed.normalized.replace(/\.git$/, ""), preflight });
      return preflight;
    } catch (error) {
      await fs.rm(path.join(this.dataRoot, "temp", `github-${token}`), { recursive: true, force: true });
      throw error;
    }
  }

  async confirmGithubImport(token: string, candidatePath: string): Promise<SkillDetail> {
    const pending = this.githubTokens.get(token);
    if (!pending) throw new Error("仓库导入会话已过期，请重新检查仓库。");
    const candidate = pending.preflight.candidates.find((item) => item.relativePath === candidatePath);
    if (!candidate) throw new Error("未找到所选 Skill 候选目录。");
    const sourcePath = path.resolve(pending.clonePath, candidate.relativePath);
    if (!sourcePath.startsWith(path.resolve(pending.clonePath))) throw new Error("已拦截越界候选目录。");
    try {
      return await this.importFromDirectory(sourcePath, {
        sourceType: "github",
        sourceUrl: pending.url,
        sourceDisplay: pending.preflight.repositoryName,
        originalPath: null,
        fallbackName: candidate.label,
      });
    } finally {
      this.githubTokens.delete(token);
      await fs.rm(path.dirname(pending.clonePath), { recursive: true, force: true });
    }
  }

  async getFilePreview(skillId: string, fileId: string) {
    const detail = this.database.getSkill(skillId);
    const file = detail.files.find((item) => item.id === fileId);
    if (!file) throw new Error("未找到该文件。");
    const { libraryPath } = this.database.getInternalPaths(skillId);
    return await previewFile(path.join(libraryPath, "content"), file);
  }

  async rerunRules(skillId: string): Promise<SkillDetail> {
    const detail = this.database.getSkill(skillId);
    const { libraryPath } = this.database.getInternalPaths(skillId);
    const contentRoot = path.join(libraryPath, "content");
    const entry = detail.files.find((file) => file.isEntryFile) || detail.files.find((file) => file.type === "markdown");
    if (!entry) throw new Error("该目录没有可用于规则拆解的 Markdown 入口文件。");
    const { content } = await readTextFile(contentRoot, entry.relativePath, 2 * 1024 * 1024);
    const parsed = parseSkill({ entryPath: entry.relativePath, entryContent: content, files: detail.files, fallbackName: detail.name });
    this.database.replaceRuleAnalysis(skillId, parsed.name, parsed.description, parsed.analysis);
    return this.database.getSkill(skillId);
  }

  private async importFromDirectory(
    sourcePath: string,
    source: { sourceType: "local" | "github"; sourceUrl: string | null; sourceDisplay: string; originalPath: string | null; fallbackName: string },
  ): Promise<SkillDetail> {
    const id = randomUUID();
    const tempSkillPath = path.join(this.dataRoot, "temp", `import-${id}`);
    const finalSkillPath = path.join(this.dataRoot, "library", id);
    const tempContentPath = path.join(tempSkillPath, "content");
    await fs.mkdir(path.dirname(finalSkillPath), { recursive: true });
    try {
      this.emitProgress({ stage: "copying", message: "正在复制到应用资料库，原目录不会被修改…" });
      await copyDirectorySafely(sourcePath, tempContentPath);
      this.emitProgress({ stage: "indexing", message: "正在建立文件索引…" });
      const files = await indexDirectory(tempContentPath);
      if (!files.length) throw new Error("所选目录没有可导入的文件。");
      const entry = files.find((file) => file.isEntryFile) || files.find((file) => file.type === "markdown");
      let name = source.fallbackName;
      let description = "自定义格式 Skill，可浏览文件并使用通用规则拆解。";
      let analysis: RuleAnalysis = {
        schemaVersion: "1.0" as const,
        parserLabel: "规则解析" as const,
        items: [],
        references: [],
        warnings: ["未找到 Markdown 入口文件，暂时只提供文件浏览。"],
      };
      this.emitProgress({ stage: "parsing", message: "正在运行本地规则拆解…" });
      if (entry) {
        const { content } = await readTextFile(tempContentPath, entry.relativePath, 2 * 1024 * 1024);
        const parsed = parseSkill({ entryPath: entry.relativePath, entryContent: content, files, fallbackName: source.fallbackName });
        name = parsed.name;
        description = parsed.description;
        analysis = parsed.analysis;
      }
      const importedAt = new Date().toISOString();
      await fs.writeFile(path.join(tempSkillPath, "source.json"), JSON.stringify({ sourceType: source.sourceType, sourceUrl: source.sourceUrl, sourceDisplay: source.sourceDisplay, importedAt }, null, 2), "utf8");
      await fs.rename(tempSkillPath, finalSkillPath);
      this.database.saveImportedSkill({
        id,
        name,
        description,
        format: files.some((file) => file.isEntryFile) ? "codex" : "custom",
        sourceType: source.sourceType,
        sourceUrl: source.sourceUrl,
        sourceDisplay: source.sourceDisplay,
        libraryPath: finalSkillPath,
        originalPath: source.originalPath,
        importedAt,
      }, files, analysis);
      this.emitProgress({ stage: "done", message: "导入完成" });
      return this.database.getSkill(id);
    } catch (error) {
      await fs.rm(tempSkillPath, { recursive: true, force: true });
      await fs.rm(finalSkillPath, { recursive: true, force: true });
      this.emitProgress({ stage: "failed", message: error instanceof Error ? error.message : "导入失败" });
      throw error;
    }
  }
}
