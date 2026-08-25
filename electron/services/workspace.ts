import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import type {
  AnalysisSection,
  EditPreview,
  FileChange,
  IndexedFile,
  LineChange,
  SkillComparison,
  SkillDetail,
  TransferPreview,
  UpdatePreview,
  VersionDiff,
  VersionSummary,
} from "../shared";
import { copyDirectorySafely, indexDirectory, readTextFile, scanDirectory } from "./files";
import { SkillDatabase } from "./database";
import { parseSkill } from "./parser";
import { compareFileIndexes, createLineDiff } from "./diff";

interface PendingContent {
  skillId: string;
  candidateRoot: string;
  cleanupRoot: string;
  preview: UpdatePreview;
  revision: string | null;
  candidateFiles: IndexedFile[];
}

interface PendingEdit {
  skillId: string;
  relativePath: string;
  content: string;
  preview: EditPreview;
}

interface PendingTransfer {
  skillId: string;
  targetRoot: string;
  destination: string;
  preview: TransferPreview;
}

const SECTIONS: AnalysisSection[] = ["basic", "use_cases", "triggers", "workflow", "inputs_outputs", "constraints", "tools", "file_roles"];

function displayPath(absolutePath: string): string {
  const parts = absolutePath.split(path.sep).filter(Boolean);
  return parts.length <= 2 ? absolutePath : `…/${parts.slice(-2).join("/")}`;
}

function safeFolderName(value: string): string {
  const result = value.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+|\.+$/g, "").slice(0, 100);
  return result || "skill";
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
    child.on("error", () => reject(new Error("未找到 Git，请先安装 Git。")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else if (/resolve host|timed out|failed to connect/i.test(stderr)) reject(new Error("无法连接 GitHub，请检查网络后重试。"));
      else if (/not found|authentication|permission|403/i.test(stderr)) reject(new Error("仓库不存在、已转为私有或当前无权访问。"));
      else reject(new Error("Git 更新检查失败，请稍后重试。"));
    });
  });
}

function changeSummary(changes: FileChange[]): UpdatePreview["summary"] {
  return {
    added: changes.filter((item) => item.kind === "added").length,
    modified: changes.filter((item) => item.kind === "modified").length,
    deleted: changes.filter((item) => item.kind === "deleted").length,
    unchanged: changes.filter((item) => item.kind === "unchanged").length,
  };
}

async function textForDiff(root: string, relativePath: string): Promise<string> {
  try { return (await readTextFile(root, relativePath, 2 * 1024 * 1024)).content; } catch { return ""; }
}

async function locateLegacyGithubSkill(root: string, skillName: string): Promise<string> {
  const candidates: Array<{ root: string; name: string }> = [];
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    const entry = entries.find((item) => item.isFile() && item.name === "SKILL.md");
    if (entry) {
      const content = await textForDiff(current, "SKILL.md");
      const name = content.match(/^---[\s\S]*?^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || path.basename(current);
      candidates.push({ root: current, name });
      return;
    }
    for (const item of entries) if (item.isDirectory() && ![".git", "node_modules"].includes(item.name)) await visit(path.join(current, item.name), depth + 1);
  }
  await visit(root, 0);
  const exact = candidates.find((item) => item.name.toLowerCase() === skillName.toLowerCase());
  if (exact) return exact.root;
  if (candidates.length === 1) return candidates[0].root;
  if (!candidates.length) return root;
  throw new Error("这是旧版 GitHub 导入记录，仓库中存在多个 Skill，无法安全判断原子目录。请重新导入该 Skill。 ");
}

export class WorkspaceService {
  private readonly updates = new Map<string, PendingContent>();
  private readonly edits = new Map<string, PendingEdit>();
  private readonly transfers = new Map<string, PendingTransfer>();
  private readonly baselineJobs = new Map<string, Promise<VersionSummary[]>>();

  constructor(private readonly dataRoot: string, private readonly database: SkillDatabase) {}

  async linkLocalSource(window: BrowserWindow, skillId: string): Promise<UpdatePreview | null> {
    const detail = this.database.getSkill(skillId);
    if (detail.sourceType !== "local") throw new Error("GitHub Skill 无需关联本机来源目录。");
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: `关联“${detail.name}”的原始目录` });
    if (result.canceled || !result.filePaths[0]) return null;
    const sourcePath = result.filePaths[0];
    const scan = await scanDirectory(sourcePath);
    if (!scan.fileCount) throw new Error("所选目录没有可关联的文件。");
    this.database.linkLocalSource(skillId, sourcePath, displayPath(sourcePath));
    return await this.stageSource(skillId, sourcePath, null);
  }

  async checkSourceUpdate(skillId: string): Promise<UpdatePreview> {
    const detail = this.database.getSkill(skillId);
    const paths = this.database.getInternalPaths(skillId);
    if (detail.sourceType === "local") {
      if (!paths.originalPath) throw new Error("尚未关联原始目录，请先选择来源目录。");
      try { await fs.access(paths.originalPath); } catch { throw new Error("原始目录已移动或不可访问，请重新关联。"); }
      return await this.stageSource(skillId, paths.originalPath, null);
    }
    if (!paths.sourceUrl) throw new Error("该 Skill 缺少 GitHub 来源地址，无法检查更新。");
    const token = randomUUID();
    const cleanupRoot = path.join(this.dataRoot, "temp", `update-${token}`);
    const cloneRoot = path.join(cleanupRoot, "repository");
    await fs.mkdir(cleanupRoot, { recursive: true });
    try {
      const branchArgs = paths.sourceBranch ? ["--branch", paths.sourceBranch] : [];
      await runGit(["-c", "core.hooksPath=/dev/null", "clone", "--depth=1", "--no-tags", "--filter=blob:none", "--no-recurse-submodules", ...branchArgs, paths.sourceUrl, cloneRoot]);
      const revision = await runGit(["rev-parse", "HEAD"], cloneRoot);
      const branch = await runGit(["branch", "--show-current"], cloneRoot);
      const sourceRoot = paths.sourceSubpath ? path.resolve(cloneRoot, paths.sourceSubpath) : await locateLegacyGithubSkill(cloneRoot, detail.name);
      if (sourceRoot !== cloneRoot && !sourceRoot.startsWith(`${cloneRoot}${path.sep}`)) throw new Error("GitHub Skill 子目录越界，无法更新。");
      await fs.access(sourceRoot);
      if (!paths.sourceSubpath) this.database.updateGithubLocation(skillId, path.relative(cloneRoot, sourceRoot).split(path.sep).join("/") || ".", branch || "default");
      return await this.stageSource(skillId, sourceRoot, revision, token, cleanupRoot);
    } catch (error) {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async applySourceUpdate(token: string): Promise<SkillDetail> {
    const pending = this.updates.get(token);
    if (!pending) throw new Error("更新预览已过期，请重新检查来源。");
    if (!pending.preview.changes.length) {
      this.database.markSourceChecked(pending.skillId, pending.revision);
      await this.cleanupUpdate(token);
      return this.database.getSkill(pending.skillId);
    }
    try {
      return await this.commitCandidate(pending.skillId, pending.candidateRoot, "source_update", "从已关联来源更新", pending.revision);
    } finally {
      await this.cleanupUpdate(token);
    }
  }

  async discardSourceUpdate(token: string): Promise<void> {
    await this.cleanupUpdate(token);
  }

  async getChangeLines(token: string, relativePath: string): Promise<LineChange[]> {
    const pending = this.updates.get(token);
    if (!pending) throw new Error("变更预览已过期。");
    if (!pending.preview.changes.some((item) => item.relativePath === relativePath)) throw new Error("该文件不在变更清单中。");
    const oldFile = this.database.getSkill(pending.skillId).files.find((item) => item.relativePath === relativePath);
    const newFile = pending.candidateFiles.find((item) => item.relativePath === relativePath);
    if ([oldFile?.type, newFile?.type].some((type) => type === "binary" || type === "image")) return [];
    const { libraryPath } = this.database.getInternalPaths(pending.skillId);
    return createLineDiff(await textForDiff(path.join(libraryPath, "content"), relativePath), await textForDiff(pending.candidateRoot, relativePath));
  }

  compareSkills(leftId: string, rightId: string): SkillComparison {
    if (leftId === rightId) throw new Error("请选择两个不同的 Skill。");
    const left = this.database.getSkill(leftId);
    const right = this.database.getSkill(rightId);
    return {
      left: { id: left.id, name: left.name, description: left.description, sourceType: left.sourceType, fileCount: left.fileCount },
      right: { id: right.id, name: right.name, description: right.description, sourceType: right.sourceType, fileCount: right.fileCount },
      sections: SECTIONS.map((section) => {
        const leftItems = [...new Set(left.ruleAnalysis.items.filter((item) => item.section === section).map((item) => item.summary.trim()).filter(Boolean))];
        const rightItems = [...new Set(right.ruleAnalysis.items.filter((item) => item.section === section).map((item) => item.summary.trim()).filter(Boolean))];
        return { section, left: leftItems.filter((item) => !rightItems.includes(item)), right: rightItems.filter((item) => !leftItems.includes(item)), shared: leftItems.filter((item) => rightItems.includes(item)) };
      }),
    };
  }

  async getEditableFile(skillId: string, fileId: string): Promise<{ relativePath: string; content: string }> {
    const detail = this.database.getSkill(skillId);
    const file = detail.files.find((item) => item.id === fileId);
    if (!file || !file.previewable || file.type === "image" || file.type === "binary") throw new Error("该文件格式不支持在线编辑。");
    if (file.size > 1024 * 1024) throw new Error("超过 1 MB 的文件暂不支持在线编辑。");
    const { libraryPath } = this.database.getInternalPaths(skillId);
    return { relativePath: file.relativePath, content: (await readTextFile(path.join(libraryPath, "content"), file.relativePath, 1024 * 1024)).content };
  }

  async prepareFileEdit(skillId: string, fileId: string, content: string): Promise<EditPreview> {
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) throw new Error("编辑后的文件超过 1 MB 限制。");
    const original = await this.getEditableFile(skillId, fileId);
    const oldHash = createHash("sha256").update(original.content).digest("hex");
    const newHash = createHash("sha256").update(content).digest("hex");
    if (oldHash === newHash) throw new Error("文件内容没有变化。");
    const token = randomUUID();
    const preview: EditPreview = { token, relativePath: original.relativePath, lines: createLineDiff(original.content, content), oldHash, newHash };
    this.edits.set(token, { skillId, relativePath: original.relativePath, content, preview });
    return preview;
  }

  async applyFileEdit(token: string): Promise<SkillDetail> {
    const pending = this.edits.get(token);
    if (!pending) throw new Error("编辑预览已过期，请重新保存。");
    const { libraryPath } = this.database.getInternalPaths(pending.skillId);
    const stageRoot = path.join(this.dataRoot, "temp", `edit-${token}`, "content");
    try {
      await copyDirectorySafely(path.join(libraryPath, "content"), stageRoot);
      const target = path.resolve(stageRoot, pending.relativePath);
      if (!target.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) throw new Error("已拦截越界编辑。");
      await fs.writeFile(target, pending.content, "utf8");
      return await this.commitCandidate(pending.skillId, stageRoot, "edit", `编辑 ${pending.relativePath}`, null);
    } finally {
      this.edits.delete(token);
      await fs.rm(path.join(this.dataRoot, "temp", `edit-${token}`), { recursive: true, force: true });
    }
  }

  async listVersions(skillId: string): Promise<VersionSummary[]> {
    const deduplicate = (items: VersionSummary[]) => items.filter((item, index, all) => all.findIndex((candidate) => candidate.origin === item.origin && candidate.createdAt === item.createdAt && candidate.fileCount === item.fileCount && candidate.note === item.note) === index);
    const existing = deduplicate(this.database.listVersions(skillId));
    if (existing.length) return existing;
    const running = this.baselineJobs.get(skillId);
    if (running) return await running;
    const job = this.createBaseline(skillId).then(deduplicate).finally(() => this.baselineJobs.delete(skillId));
    this.baselineJobs.set(skillId, job);
    return await job;
  }

  private async createBaseline(skillId: string): Promise<VersionSummary[]> {
    const { libraryPath } = this.database.getInternalPaths(skillId);
    const sourceRoot = path.join(libraryPath, "content");
    const files = await indexDirectory(sourceRoot);
    const id = randomUUID();
    const createdAt = this.database.getSkill(skillId).importedAt || new Date().toISOString();
    const contentPath = path.join(libraryPath, "versions", id, "content");
    await copyDirectorySafely(sourceRoot, contentPath);
    this.database.saveVersion(skillId, { id, label: "初始导入", origin: "import", note: "由 v0.2 为既有资料建立的基线", createdAt, contentPath, fileCount: files.length });
    return this.database.listVersions(skillId);
  }

  async diffVersion(skillId: string, versionId: string): Promise<VersionDiff> {
    const version = this.database.listVersions(skillId).find((item) => item.id === versionId);
    if (!version) throw new Error("未找到该历史版本。");
    const versionRoot = this.database.getVersionPath(skillId, versionId);
    const { libraryPath } = this.database.getInternalPaths(skillId);
    return { version, changes: compareFileIndexes(await indexDirectory(versionRoot), await indexDirectory(path.join(libraryPath, "content"))) };
  }

  async restoreVersion(skillId: string, versionId: string): Promise<SkillDetail> {
    const version = this.database.listVersions(skillId).find((item) => item.id === versionId);
    if (!version) throw new Error("未找到该历史版本。");
    return await this.commitCandidate(skillId, this.database.getVersionPath(skillId, versionId), "restore", `恢复自 ${version.label}`, null);
  }

  async prepareTransfer(window: BrowserWindow, skillId: string, mode: "install" | "export"): Promise<TransferPreview | null> {
    const detail = this.database.getSkill(skillId);
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], title: mode === "install" ? "选择 Agent 的 Skills 目标目录" : "选择导出位置" });
    if (result.canceled || !result.filePaths[0]) return null;
    const targetRoot = path.resolve(result.filePaths[0]);
    const folderName = safeFolderName(detail.name);
    const destination = path.join(targetRoot, folderName);
    if (destination === targetRoot) throw new Error("目标目录不安全。");
    const { libraryPath } = this.database.getInternalPaths(skillId);
    const sourceFiles = await indexDirectory(path.join(libraryPath, "content"));
    let targetFiles: IndexedFile[] = [];
    let targetExists = false;
    try { targetFiles = await indexDirectory(destination); targetExists = true; } catch { /* 目标子目录尚不存在 */ }
    const changes = compareFileIndexes(targetFiles, sourceFiles);
    const token = randomUUID();
    const preview: TransferPreview = { token, mode, targetDisplay: displayPath(targetRoot), folderName, targetExists, changes, conflicts: changes.filter((item) => item.kind === "modified" || item.kind === "deleted").length };
    this.transfers.set(token, { skillId, targetRoot, destination, preview });
    return preview;
  }

  async applyTransfer(token: string, strategy: "overwrite" | "rename"): Promise<{ destinationDisplay: string }> {
    const pending = this.transfers.get(token);
    if (!pending) throw new Error("安装/导出预览已过期，请重新选择目标目录。");
    const { libraryPath } = this.database.getInternalPaths(pending.skillId);
    let destination = pending.destination;
    try {
      if (pending.preview.targetExists && strategy === "rename") {
        let suffix = 2;
        while (true) {
          const candidate = path.join(pending.targetRoot, `${pending.preview.folderName}-${suffix}`);
          try { await fs.access(candidate); suffix += 1; } catch { destination = candidate; break; }
        }
      } else if (pending.preview.targetExists) {
        const backup = path.join(this.dataRoot, "installation-backups", `${pending.preview.folderName}-${Date.now()}`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(destination, backup);
      }
      await copyDirectorySafely(path.join(libraryPath, "content"), destination);
      return { destinationDisplay: displayPath(destination) };
    } finally {
      this.transfers.delete(token);
    }
  }

  private async stageSource(skillId: string, sourceRoot: string, revision: string | null, providedToken?: string, providedCleanupRoot?: string): Promise<UpdatePreview> {
    const token = providedToken || randomUUID();
    const cleanupRoot = providedCleanupRoot || path.join(this.dataRoot, "temp", `update-${token}`);
    const candidateRoot = path.join(cleanupRoot, "candidate");
    await fs.mkdir(cleanupRoot, { recursive: true });
    await copyDirectorySafely(sourceRoot, candidateRoot);
    const detail = this.database.getSkill(skillId);
    const { libraryPath } = this.database.getInternalPaths(skillId);
    const candidateFiles = await indexDirectory(candidateRoot);
    const changes = compareFileIndexes(await indexDirectory(path.join(libraryPath, "content")), candidateFiles);
    const preview: UpdatePreview = {
      token,
      source: { ...detail.sourceStatus, state: changes.length ? "changes" : "up_to_date", revision, lastCheckedAt: new Date().toISOString() },
      changes,
      summary: changeSummary(changes),
    };
    this.updates.set(token, { skillId, candidateRoot, cleanupRoot, preview, revision, candidateFiles });
    this.database.markSourceChecked(skillId, changes.length ? null : revision);
    return preview;
  }

  private async commitCandidate(skillId: string, candidateRoot: string, origin: VersionSummary["origin"], note: string, revision: string | null): Promise<SkillDetail> {
    const detail = this.database.getSkill(skillId);
    const files = await indexDirectory(candidateRoot);
    if (!files.length) throw new Error("变更后的 Skill 目录为空，已停止写入。");
    const entry = files.find((file) => file.isEntryFile) || files.find((file) => file.type === "markdown");
    let name = detail.name;
    let description = detail.description;
    let analysis = detail.ruleAnalysis;
    if (entry) {
      const parsed = parseSkill({ entryPath: entry.relativePath, entryContent: (await readTextFile(candidateRoot, entry.relativePath, 2 * 1024 * 1024)).content, files, fallbackName: detail.name });
      name = parsed.name; description = parsed.description; analysis = parsed.analysis;
    }
    const { libraryPath } = this.database.getInternalPaths(skillId);
    const currentRoot = path.join(libraryPath, "content");
    const nextRoot = path.join(libraryPath, `.content-next-${randomUUID()}`);
    const previousRoot = path.join(libraryPath, `.content-previous-${randomUUID()}`);
    await copyDirectorySafely(candidateRoot, nextRoot);
    const versionId = randomUUID();
    const createdAt = new Date().toISOString();
    const contentPath = path.join(libraryPath, "versions", versionId, "content");
    await copyDirectorySafely(candidateRoot, contentPath);
    const labels: Record<VersionSummary["origin"], string> = { import: "初始导入", source_update: "来源更新", edit: "在线编辑", restore: "历史恢复" };
    const version = { id: versionId, label: labels[origin], origin, note, createdAt, contentPath, fileCount: files.length };
    try {
      await fs.rename(currentRoot, previousRoot);
      await fs.rename(nextRoot, currentRoot);
      this.database.replaceSkillContent(skillId, name, description, files, analysis, version, revision);
      await fs.rm(previousRoot, { recursive: true, force: true });
      return this.database.getSkill(skillId);
    } catch (error) {
      try { await fs.access(previousRoot); await fs.rm(currentRoot, { recursive: true, force: true }); await fs.rename(previousRoot, currentRoot); } catch { /* 保留原始错误 */ }
      await fs.rm(nextRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async cleanupUpdate(token: string): Promise<void> {
    const pending = this.updates.get(token);
    this.updates.delete(token);
    if (pending) await fs.rm(pending.cleanupRoot, { recursive: true, force: true });
  }
}
