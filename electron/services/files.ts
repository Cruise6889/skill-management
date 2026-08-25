import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FilePreview, IndexedFile } from "../shared";

const SKIPPED_NAMES = new Set([".git", ".DS_Store", "Thumbs.db"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "log", "ini", "conf", "toml"]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "cs", "php", "vue", "svelte", "sh", "bash", "zsh", "fish", "ps1", "sql", "css", "scss", "less", "html", "xml",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const MAX_PREVIEW_BYTES = 512 * 1024;

export interface ScanResult {
  fileCount: number;
  totalBytes: number;
  hasSkillEntry: boolean;
  warnings: string[];
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function classify(extension: string): IndexedFile["type"] {
  if (extension === "md" || extension === "mdx") return "markdown";
  if (extension === "json" || extension === "jsonc") return "json";
  if (extension === "yaml" || extension === "yml") return "yaml";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension) || extension === "") return "text";
  return "binary";
}

async function walk(
  root: string,
  visitor: (absolutePath: string, relativePath: string, entry: Awaited<ReturnType<typeof fs.lstat>>) => Promise<void>,
  current = root,
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeRelative(path.relative(root, absolutePath));
    const stats = await fs.lstat(absolutePath);
    await visitor(absolutePath, relativePath, stats);
    if (stats.isDirectory() && !stats.isSymbolicLink()) await walk(root, visitor, absolutePath);
  }
}

export async function scanDirectory(root: string): Promise<ScanResult> {
  let fileCount = 0;
  let totalBytes = 0;
  let hasSkillEntry = false;
  let symlinks = 0;
  let unreadable = 0;
  await walk(root, async (absolutePath, relativePath, stats) => {
    if (stats.isSymbolicLink()) {
      symlinks += 1;
      return;
    }
    if (!stats.isFile()) return;
    fileCount += 1;
    totalBytes += Number(stats.size);
    if (relativePath === "SKILL.md") hasSkillEntry = true;
    try {
      await fs.access(absolutePath);
    } catch {
      unreadable += 1;
    }
  });
  const warnings: string[] = [];
  if (symlinks) warnings.push(`发现 ${symlinks} 个符号链接，导入时将安全跳过`);
  if (unreadable) warnings.push(`发现 ${unreadable} 个不可读文件，导入时将跳过`);
  if (!hasSkillEntry) warnings.push("未找到 SKILL.md，将作为自定义格式导入");
  if (fileCount > 200) warnings.push(`文件数为 ${fileCount}，超过 MVP 建议的 200 个文件`);
  if (totalBytes > 20 * 1024 * 1024) warnings.push("目录大于 20 MB，导入和解析可能较慢");
  return { fileCount, totalBytes, hasSkillEntry, warnings };
}

export async function copyDirectorySafely(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await walk(source, async (absolutePath, relativePath, stats) => {
    if (stats.isSymbolicLink()) return;
    const target = path.join(destination, relativePath);
    if (stats.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      return;
    }
    if (!stats.isFile()) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(absolutePath, target);
  });
}

export async function indexDirectory(root: string): Promise<IndexedFile[]> {
  const files: IndexedFile[] = [];
  await walk(root, async (absolutePath, relativePath, stats) => {
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const extension = path.extname(relativePath).slice(1).toLowerCase();
    const type = classify(extension);
    const hash = createHash("sha256");
    const handle = await fs.open(absolutePath, "r");
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
      await handle.close();
    }
    files.push({
      id: randomUUID(),
      relativePath,
      name: path.basename(relativePath),
      extension,
      type,
      size: Number(stats.size),
      hash: hash.digest("hex"),
      previewable: type !== "binary" && (type === "image" || Number(stats.size) <= 5 * 1024 * 1024),
      isEntryFile: relativePath === "SKILL.md",
      hidden: relativePath.split("/").some((segment) => segment.startsWith(".")),
    });
  });
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function readTextFile(root: string, relativePath: string, maxBytes = MAX_PREVIEW_BYTES): Promise<{ content: string; truncated: boolean }> {
  const target = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error("已拦截越界文件访问。");
  const handle = await fs.open(target, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { content: buffer.toString("utf8"), truncated: stats.size > maxBytes };
  } finally {
    await handle.close();
  }
}

function imageMime(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "bmp") return "image/bmp";
  if (extension === "ico") return "image/x-icon";
  return "image/png";
}

export async function previewFile(root: string, file: IndexedFile): Promise<FilePreview> {
  if (!file.previewable) {
    return { relativePath: file.relativePath, type: file.type, size: file.size, content: null, dataUrl: null, truncated: false };
  }
  if (file.type === "image") {
    if (file.size > 10 * 1024 * 1024) return { relativePath: file.relativePath, type: file.type, size: file.size, content: null, dataUrl: null, truncated: true };
    const target = path.resolve(root, file.relativePath);
    const normalizedRoot = path.resolve(root);
    if (!target.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error("已拦截越界文件访问。");
    const buffer = await fs.readFile(target);
    return {
      relativePath: file.relativePath,
      type: file.type,
      size: file.size,
      content: null,
      dataUrl: `data:${imageMime(file.extension)};base64,${buffer.toString("base64")}`,
      truncated: false,
    };
  }
  const result = await readTextFile(root, file.relativePath);
  return { relativePath: file.relativePath, type: file.type, size: file.size, content: result.content, dataUrl: null, truncated: result.truncated };
}
