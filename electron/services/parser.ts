import path from "node:path";
import { parseDocument } from "yaml";
import type {
  AnalysisItem,
  AnalysisSection,
  Evidence,
  FileReference,
  IndexedFile,
  RuleAnalysis,
} from "../shared";

interface ParserInput {
  entryPath: string;
  entryContent: string;
  files: IndexedFile[];
  fallbackName: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  analysis: RuleAnalysis;
}

interface SectionSlice {
  heading: string;
  start: number;
  end: number;
  lines: string[];
}

const SECTION_SIGNALS: Record<Exclude<AnalysisSection, "basic" | "file_roles">, RegExp[]> = {
  use_cases: [/overview/i, /when to use/i, /use cases?/i, /适用/, /应用场景/, /核心功能/],
  triggers: [/triggers?/i, /invocation/i, /触发/, /调用/],
  workflow: [/workflow/i, /steps?/i, /process/i, /流程/, /步骤/, /工作方式/],
  inputs_outputs: [/inputs?/i, /outputs?/i, /parameters?/i, /returns?/i, /输入/, /输出/, /参数/],
  constraints: [/constraints?/i, /safety/i, /limitations?/i, /do not/i, /约束/, /禁止/, /安全/, /限制/],
  tools: [/tools?/i, /dependencies/i, /requirements/i, /工具/, /依赖/, /运行时/],
};

const FALLBACK_LINE_SIGNALS: Partial<Record<AnalysisSection, RegExp>> = {
  triggers: /\b(must use|should use|use when|invoke|trigger)\b|当.+时|必须使用|应当使用/i,
  workflow: /^\s*(?:\d+[.)]|[-*])\s*(?:first|then|next|finally|首先|然后|接着|最后|读取|调用|生成)/i,
  inputs_outputs: /\b(input|output|parameter|return)\b|输入|输出|参数|返回/i,
  constraints: /\b(do not|never|must not|required|permission|offline)\b|禁止|不得|不要|必须|权限|离线/i,
  tools: /\b(MCP|CLI|API|Node(?:\.js)?|Python|Git|Docker|npm|pnpm|yarn|runtime)\b|命令行|外部服务|脚本/i,
};

function cleanMarkdown(value: string): string {
  return value
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .trim();
}

function evidence(pathname: string, line: number, excerpt: string, ruleId: string): Evidence {
  return {
    relativePath: pathname,
    startLine: line,
    endLine: line,
    excerpt: excerpt.trim().slice(0, 280),
    ruleId,
  };
}

function headingSections(lines: string[]): SectionSlice[] {
  const headings: Array<{ heading: string; line: number }> = [];
  lines.forEach((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) headings.push({ heading: cleanMarkdown(match[1]), line: index });
  });
  return headings.map((item, index) => {
    const end = headings[index + 1]?.line ?? lines.length;
    return {
      heading: item.heading,
      start: item.line + 1,
      end,
      lines: lines.slice(item.line + 1, end),
    };
  });
}

function meaningfulLines(lines: string[]): Array<{ value: string; offset: number }> {
  const result: Array<{ value: string; offset: number }> = [];
  let inCode = false;
  lines.forEach((line, offset) => {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      return;
    }
    if (inCode || /^\s*$/.test(line) || /^\s*<!--/.test(line)) return;
    const value = cleanMarkdown(line);
    if (value.length >= 4) result.push({ value, offset });
  });
  return result;
}

function extractFrontmatter(content: string): {
  name?: string;
  description?: string;
  endLine: number;
  warning?: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { endLine: 0 };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { endLine: 0, warning: "SKILL.md 的 YAML frontmatter 未闭合" };
  const endLine = closing + 2;
  try {
    const document = parseDocument(lines.slice(1, endLine - 1).join("\n"));
    if (document.errors.length) throw new Error(document.errors[0].message);
    const data = document.toJS() as Record<string, unknown> | null;
    return {
      name: typeof data?.name === "string" ? data.name.trim() : undefined,
      description: typeof data?.description === "string" ? data.description.trim() : undefined,
      endLine,
    };
  } catch (error) {
    return {
      endLine,
      warning: `YAML frontmatter 解析失败：${error instanceof Error ? error.message : "格式错误"}`,
    };
  }
}

function sectionItems(
  section: Exclude<AnalysisSection, "basic" | "file_roles">,
  slices: SectionSlice[],
  allLines: string[],
  entryPath: string,
): AnalysisItem[] {
  const matching = slices.filter((slice) => SECTION_SIGNALS[section].some((signal) => signal.test(slice.heading)));
  const fromHeadings = matching.flatMap((slice, sliceIndex) =>
    meaningfulLines(slice.lines).slice(0, 6).map(({ value, offset }, itemIndex) => ({
      id: `${section}-heading-${sliceIndex}-${itemIndex}`,
      section,
      title: slice.heading,
      summary: value,
      confidence: "high" as const,
      evidence: [evidence(entryPath, slice.start + offset + 1, slice.lines[offset], `heading:${section}`)],
    })),
  );
  if (fromHeadings.length) return fromHeadings;

  const fallback = FALLBACK_LINE_SIGNALS[section];
  if (!fallback) return [];
  return allLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => fallback.test(line))
    .slice(0, 5)
    .map(({ line, index }, itemIndex) => ({
      id: `${section}-fallback-${itemIndex}`,
      section,
      summary: cleanMarkdown(line),
      confidence: "medium" as const,
      evidence: [evidence(entryPath, index + 1, line, `keyword:${section}`)],
    }));
}

function fileRoleItems(files: IndexedFile[]): AnalysisItem[] {
  const groups = [
    { title: "入口指令", test: (file: IndexedFile) => file.isEntryFile, role: "定义 Skill 的名称、用途、触发条件和工作流程" },
    { title: "可执行脚本", test: (file: IndexedFile) => file.relativePath.startsWith("scripts/"), role: "提供 Skill 在特定步骤中调用的脚本能力；本应用不会执行它们" },
    { title: "参考资料", test: (file: IndexedFile) => file.relativePath.startsWith("references/"), role: "承载按需读取的详细规则、范例或背景材料" },
    { title: "可复用资产", test: (file: IndexedFile) => file.relativePath.startsWith("assets/"), role: "提供模板、图片或其他可被 Skill 复用的非指令资产" },
  ];
  return groups.flatMap((group, index) => {
    const matched = files.filter(group.test);
    if (!matched.length) return [];
    const shown = matched.slice(0, 5).map((file) => file.relativePath).join("、");
    const suffix = matched.length > 5 ? ` 等 ${matched.length} 个文件` : "";
    return [{
      id: `file-role-${index}`,
      section: "file_roles" as const,
      title: group.title,
      summary: `${group.role}。包含：${shown}${suffix}`,
      confidence: "high" as const,
      evidence: matched.slice(0, 3).map((file) => evidence(file.relativePath, 1, file.relativePath, "path:conventional-role")),
    }];
  });
}

function parseReferences(entryPath: string, content: string, files: IndexedFile[]): FileReference[] {
  const fileSet = new Set(files.map((file) => file.relativePath));
  const sourceDir = path.posix.dirname(entryPath);
  const found = new Map<string, FileReference>();
  content.split(/\r?\n/).forEach((line, index) => {
    const candidates: string[] = [];
    for (const match of line.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) candidates.push(match[1].trim());
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const value = match[1].trim();
      if (/^(?:\.\.?\/|[\w.-]+\/)[^\s]+$/.test(value) || /\.(?:md|txt|json|ya?ml|ts|tsx|js|py|sh)$/i.test(value)) candidates.push(value);
    }
    candidates.forEach((targetText) => {
      if (/^(?:https?:|mailto:)/i.test(targetText)) {
        found.set(`${index}:${targetText}`, { sourcePath: entryPath, targetText, resolvedPath: null, status: "external", line: index + 1 });
        return;
      }
      const normalized = path.posix.normalize(path.posix.join(sourceDir, targetText.replace(/^\.\//, "")));
      const outside = normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized);
      found.set(`${index}:${targetText}`, {
        sourcePath: entryPath,
        targetText,
        resolvedPath: outside ? null : normalized,
        status: outside ? "outside" : fileSet.has(normalized) ? "resolved" : "missing",
        line: index + 1,
      });
    });
  });
  return [...found.values()];
}

export function parseSkill(input: ParserInput): ParsedSkill {
  const lines = input.entryContent.split(/\r?\n/);
  const frontmatter = extractFrontmatter(input.entryContent);
  const slices = headingSections(lines);
  const h1 = lines.find((line) => /^#\s+/.test(line));
  const firstParagraph = lines
    .slice(frontmatter.endLine)
    .map(cleanMarkdown)
    .find((line) => line.length > 12 && !/^[-\d]/.test(line));
  const name = frontmatter.name || (h1 ? cleanMarkdown(h1) : input.fallbackName);
  const description = frontmatter.description || firstParagraph || "未提取到明确描述";

  const items: AnalysisItem[] = [
    {
      id: "basic-name",
      section: "basic",
      title: "名称与用途",
      summary: `${name}：${description}`,
      confidence: frontmatter.name || frontmatter.description ? "high" : "medium",
      evidence: [
        evidence(input.entryPath, frontmatter.name ? 2 : Math.max(1, lines.indexOf(h1 || "") + 1), frontmatter.name ? lines[1] : h1 || name, "metadata:name"),
      ],
    },
    ...sectionItems("use_cases", slices, lines, input.entryPath),
    ...sectionItems("triggers", slices, lines, input.entryPath),
    ...sectionItems("workflow", slices, lines, input.entryPath),
    ...sectionItems("inputs_outputs", slices, lines, input.entryPath),
    ...sectionItems("constraints", slices, lines, input.entryPath),
    ...sectionItems("tools", slices, lines, input.entryPath),
    ...fileRoleItems(input.files),
  ];

  const references = parseReferences(input.entryPath, input.entryContent, input.files);
  const warnings = [
    ...(frontmatter.warning ? [frontmatter.warning] : []),
    ...references.filter((reference) => reference.status === "outside").map((reference) => `已拦截越界引用：${reference.targetText}`),
    ...references.filter((reference) => reference.status === "missing").map((reference) => `未找到引用文件：${reference.targetText}`),
  ];

  return {
    name,
    description,
    analysis: {
      schemaVersion: "1.0",
      parserLabel: "规则解析",
      items,
      references,
      warnings,
    },
  };
}
