import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AiConfirmation,
  AiSettingsPublic,
  AnalysisItem,
  AnalysisSection,
  FilePreview,
  GithubPreflight,
  ImportProgress,
  IndexedFile,
  LibraryQuery,
  LocalPreflight,
  SkillDetail,
  SkillSummary,
  TaxonomySnapshot,
} from "../electron/shared";

const api = window.skillExplorer;

type PaneWidths = { files: number; analysis: number };

const PANE_WIDTHS_STORAGE_KEY = "skill-explorer.detail-pane-widths";
const WIDE_DEFAULT_PANE_WIDTHS: PaneWidths = { files: 380, analysis: 600 };
const RESIZER_WIDTH = 8;

function getLayoutBounds(containerWidth: number) {
  const compact = window.innerWidth <= 1360;
  const filesMin = compact ? 220 : 240;
  const analysisMin = compact ? 345 : 360;
  const previewMin = compact ? 300 : 480;
  const availableForSides = Math.max(filesMin + analysisMin, containerWidth - previewMin - RESIZER_WIDTH * 2);
  return { filesMin, analysisMin, availableForSides };
}

function clampPaneWidths(widths: PaneWidths, containerWidth: number): PaneWidths {
  const { filesMin, analysisMin, availableForSides } = getLayoutBounds(containerWidth);
  const requestedFiles = Math.max(widths.files, filesMin);
  const requestedAnalysis = Math.max(widths.analysis, analysisMin);
  if (requestedFiles + requestedAnalysis > availableForSides) {
    const requestedExtraFiles = requestedFiles - filesMin;
    const requestedExtraAnalysis = requestedAnalysis - analysisMin;
    const requestedExtra = requestedExtraFiles + requestedExtraAnalysis;
    const availableExtra = availableForSides - filesMin - analysisMin;
    const fileShare = requestedExtra ? requestedExtraFiles / requestedExtra : 0.4;
    return { files: filesMin + availableExtra * fileShare, analysis: analysisMin + availableExtra * (1 - fileShare) };
  }
  const filesMax = Math.max(filesMin, availableForSides - analysisMin);
  const files = Math.min(requestedFiles, filesMax);
  const analysisMax = Math.max(analysisMin, availableForSides - files);
  return { files, analysis: Math.min(requestedAnalysis, analysisMax) };
}

function initialPaneWidths(): PaneWidths {
  const fallback = clampPaneWidths(WIDE_DEFAULT_PANE_WIDTHS, Math.max(900, window.innerWidth - 224));
  try {
    const stored = JSON.parse(window.localStorage.getItem(PANE_WIDTHS_STORAGE_KEY) || "null") as Partial<PaneWidths> | null;
    if (typeof stored?.files !== "number" || typeof stored.analysis !== "number") return fallback;
    return clampPaneWidths({ files: stored.files, analysis: stored.analysis }, Math.max(900, window.innerWidth - 224));
  } catch { return fallback; }
}

const SECTION_LABELS: Record<AnalysisSection, string> = {
  basic: "基本信息",
  use_cases: "应用场景与核心功能",
  triggers: "触发条件",
  workflow: "执行流程",
  inputs_outputs: "输入与输出",
  constraints: "约束条件",
  tools: "依赖工具",
  file_roles: "目录与文件职责",
};

const SECTION_ICONS: Record<AnalysisSection, string> = {
  basic: "◎",
  use_cases: "◇",
  triggers: "⌘",
  workflow: "↳",
  inputs_outputs: "⇄",
  constraints: "!",
  tools: "⚙",
  file_roles: "◫",
};

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "操作失败，请稍后重试。";
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function fileIcon(file: IndexedFile): string {
  if (file.isEntryFile) return "S";
  if (file.type === "markdown") return "M";
  if (file.type === "image") return "▣";
  if (file.type === "json" || file.type === "yaml") return "{}";
  if (file.type === "code") return "</>";
  return "·";
}

function MarkdownPreview({ content, focusLine, onHeadingClick }: { content: string; focusLine: number | null; onHeadingClick?: (line: number) => void }) {
  // 元数据已显示在详情页标题区；阅读正文不重复展示 YAML frontmatter。
  const body = content.replace(/^(?:\uFEFF)?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
  const articleRef = useRef<HTMLElement>(null);
  const headingLine = useCallback((heading: string) => content.split(/\r?\n/).findIndex((line) => line.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim() === heading.replace(/[*_`]/g, "").trim()) + 1, [content]);
  useEffect(() => {
    if (!focusLine) return;
    const headings = [...(articleRef.current?.querySelectorAll<HTMLElement>(".linked-heading") || [])];
    const candidates = headings.map((heading) => ({ heading, line: headingLine(heading.textContent || "") }));
    const nearest = candidates.filter((item) => item.line > 0 && item.line <= focusLine).at(-1) ?? candidates[0];
    nearest?.heading.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusLine, headingLine]);
  const handleHeadingClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".linked-heading") : null;
    if (!target || !onHeadingClick) return;
    const line = headingLine(target.textContent || "");
    if (line > 0) onHeadingClick(line);
  };
  return (
    <article className="markdown-preview" ref={articleRef} onClick={handleHeadingClick}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => <div className="table-scroll" aria-label="Markdown 表格"><table>{children}</table></div>,
          h1: ({ children }) => <h1 className="linked-heading" title="定位右侧拆解">{children}</h1>,
          h2: ({ children }) => <h2 className="linked-heading" title="定位右侧拆解">{children}</h2>,
          h3: ({ children }) => <h3 className="linked-heading" title="定位右侧拆解">{children}</h3>,
          h4: ({ children }) => <h4 className="linked-heading" title="定位右侧拆解">{children}</h4>,
          h5: ({ children }) => <h5 className="linked-heading" title="定位右侧拆解">{children}</h5>,
          h6: ({ children }) => <h6 className="linked-heading" title="定位右侧拆解">{children}</h6>,
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}

function SourcePreview({ content, focusLine }: { content: string; focusLine: number | null }) {
  const focusedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { focusedRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focusLine, content]);
  return (
    <div className="source-preview">
      {content.split(/\r?\n/).map((line, index) => {
        const lineNumber = index + 1;
        const focused = focusLine === lineNumber;
        return (
          <div className={`source-line ${focused ? "focused" : ""}`} key={lineNumber} ref={focused ? focusedRef : undefined}>
            <span className="line-number">{lineNumber}</span>
            <code>{line || " "}</code>
          </div>
        );
      })}
    </div>
  );
}

function JsonSection({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ul className="ai-list">{value.map((item, index) => <li key={index}>{typeof item === "string" ? item : JSON.stringify(item)}</li>)}</ul>;
  if (value && typeof value === "object") return (
    <div className="ai-object">
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <div key={key} className="ai-object-row"><strong>{key.replaceAll("_", " ")}</strong><JsonSection value={item} /></div>
      ))}
    </div>
  );
  return <p>{String(value ?? "—")}</p>;
}

function Modal({ title, eyebrow, onClose, children, wide = false }: { title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

type ImportView = "source" | "github" | "local-ready" | "github-ready" | "working";

function ImportModal({ onClose, onImported, setToast }: { onClose: () => void; onImported: (skill: SkillDetail) => void; setToast: (message: string) => void }) {
  const [view, setView] = useState<ImportView>("source");
  const [local, setLocal] = useState<LocalPreflight | null>(null);
  const [github, setGithub] = useState<GithubPreflight | null>(null);
  const [url, setUrl] = useState("");
  const [candidate, setCandidate] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => api.onImportProgress(setProgress), []);

  async function chooseLocal() {
    setError("");
    try {
      const result = await api.chooseLocalDirectory();
      if (!result) return;
      setLocal(result);
      setView("local-ready");
    } catch (reason) { setError(cleanError(reason)); }
  }

  async function inspectGithub() {
    setError("");
    setView("working");
    try {
      const result = await api.inspectGithub(url);
      setGithub(result);
      setCandidate(result.candidates[0]?.relativePath || "");
      setView("github-ready");
    } catch (reason) { setError(cleanError(reason)); setView("github"); }
  }

  async function confirmImport() {
    setError("");
    setView("working");
    try {
      const skill = local
        ? await api.confirmLocalImport(local.token)
        : await api.confirmGithubImport(github!.token, candidate);
      setToast(`已导入 ${skill.name}`);
      onImported(skill);
    } catch (reason) { setError(cleanError(reason)); setView(local ? "local-ready" : "github-ready"); }
  }

  return (
    <Modal title="导入 Skill" eyebrow="内容始终由你掌控" onClose={onClose} wide>
      {view === "source" && <>
        <p className="modal-lead">导入会创建一份独立副本。原目录与远程仓库都不会被修改。</p>
        <div className="source-options">
          <button className="source-option" onClick={chooseLocal}>
            <span className="source-symbol">⌘</span><strong>本机目录</strong><small>选择一个文件夹，先检查再导入</small><em>推荐</em>
          </button>
          <button className="source-option" onClick={() => setView("github")}>
            <span className="source-symbol">GH</span><strong>GitHub 仓库</strong><small>克隆公开仓库并选择 Skill 目录</small>
          </button>
        </div>
      </>}

      {view === "github" && <>
        <button className="text-button back-inline" onClick={() => setView("source")}>← 返回</button>
        <label className="field-label" htmlFor="github-url">公开仓库地址</label>
        <input id="github-url" className="text-input large" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" autoFocus />
        <p className="privacy-note"><span>✓</span> 只做浅克隆和只读扫描，不执行 Hook、脚本、子模块或安装命令。</p>
        <div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!url.trim()} onClick={inspectGithub}>检查仓库</button></div>
      </>}

      {view === "local-ready" && local && <PreflightCard
        title={local.directoryName}
        subtitle={local.sourceDisplay}
        facts={[["SKILL.md", local.hasSkillEntry ? "已检测" : "未检测"], ["文件", `${local.fileCount} 个`], ["大小", formatBytes(local.totalBytes)], ["格式", local.format === "codex" ? "Codex Skill" : "自定义"]]}
        warnings={local.warnings}
        onBack={() => { setLocal(null); setView("source"); }}
        onConfirm={confirmImport}
      />}

      {view === "github-ready" && github && <>
        <div className="preflight-title"><span className="source-symbol small">GH</span><div><h3>{github.repositoryName}</h3><p>默认分支 {github.defaultBranch} · 已安全克隆</p></div></div>
        <label className="field-label" htmlFor="candidate">选择要收录的 Skill</label>
        <div className="candidate-list" id="candidate">
          {github.candidates.map((item) => <label className={`candidate ${candidate === item.relativePath ? "selected" : ""}`} key={item.relativePath}>
            <input type="radio" name="candidate" checked={candidate === item.relativePath} onChange={() => setCandidate(item.relativePath)} />
            <span><strong>{item.label}</strong><small>{item.relativePath}</small></span><em>{item.confidence === "high" ? "高置信" : "候选"}</em>
          </label>)}
        </div>
        {github.warnings.map((warning) => <p className="warning" key={warning}>! {warning}</p>)}
        <div className="modal-actions"><button className="button secondary" onClick={() => setView("github")}>上一步</button><button className="button primary" onClick={confirmImport}>导入并拆解</button></div>
      </>}

      {view === "working" && <div className="working-state"><span className="spinner"/><h3>{progress?.message || "正在准备…"}</h3><p>可以安心等待，不会运行导入内容。</p><div className="indeterminate"><span/></div></div>}
      {error && <div className="error-box"><strong>没有完成</strong><p>{error}</p></div>}
    </Modal>
  );
}

function PreflightCard({ title, subtitle, facts, warnings, onBack, onConfirm }: { title: string; subtitle: string; facts: string[][]; warnings: string[]; onBack: () => void; onConfirm: () => void }) {
  return <>
    <div className="preflight-title"><span className="source-symbol small">⌘</span><div><h3>{title}</h3><p>{subtitle}</p></div></div>
    <div className="fact-grid">{facts.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <div className="safe-card"><span>✓</span><div><strong>只读检查完成</strong><p>确认后复制到应用资料库，原目录保持不变。</p></div></div>
    {warnings.map((warning) => <p className="warning" key={warning}>! {warning}</p>)}
    <div className="modal-actions"><button className="button secondary" onClick={onBack}>上一步</button><button className="button primary" onClick={onConfirm}>确认导入</button></div>
  </>;
}

function SettingsModal({ onClose, setToast }: { onClose: () => void; setToast: (message: string) => void }) {
  const [settings, setSettings] = useState<AiSettingsPublic>({ baseUrl: "https://api.openai.com/v1", model: "", hasKey: false, keyLast4: "", allowLocalHttp: false });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.getAiSettings().then(setSettings).catch((reason) => setError(cleanError(reason))); }, []);

  async function save(test = false) {
    setSaving(true); setError("");
    try {
      const next = await api.saveAiSettings({ ...settings, apiKey: apiKey || undefined });
      setSettings(next); setApiKey("");
      if (test) {
        await api.testAiConnection();
        setToast("连接测试成功");
      } else setToast("AI 设置已保存");
      if (!test) onClose();
    } catch (reason) { setError(cleanError(reason)); }
    finally { setSaving(false); }
  }

  return <Modal title="AI 服务设置" eyebrow="只在你确认后调用" onClose={onClose}>
    <div className="form-stack">
      <label><span>API Base URL</span><input className="text-input" value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
      <label><span>API Key</span><input className="text-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasKey ? `已保存 ••••${settings.keyLast4}` : "sk-..."} /></label>
      <label><span>模型名称</span><input className="text-input" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder="gpt-5-mini" /></label>
      <label className="check-row"><input type="checkbox" checked={settings.allowLocalHttp} onChange={(event) => setSettings({ ...settings, allowLocalHttp: event.target.checked })} /><span>允许 localhost 使用 HTTP（仅本机开发）</span></label>
    </div>
    <p className="privacy-note"><span>⌥</span> API Key 由 macOS Keychain 保护，不写入 SQLite、日志或导出文件。</p>
    {error && <div className="error-box"><p>{error}</p></div>}
    <div className="modal-actions split"><button className="button ghost" disabled={saving} onClick={() => save(true)}>保存并测试连接</button><button className="button primary" disabled={saving} onClick={() => save(false)}>{saving ? "正在保存…" : "保存设置"}</button></div>
  </Modal>;
}

function AiConfirmModal({ skill, onClose, onComplete, openSettings }: { skill: SkillDetail; onClose: () => void; onComplete: (detail: SkillDetail) => void; openSettings: () => void }) {
  const [confirmation, setConfirmation] = useState<AiConfirmation | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.prepareAiAnalysis(skill.id).then((result) => {
      setConfirmation(result);
      setSelected(new Set(result.files.filter((file) => file.selected).map((file) => file.id)));
    }).catch((reason) => setError(cleanError(reason))).finally(() => setLoading(false));
  }, [skill.id]);
  const chosen = confirmation?.files.filter((file) => selected.has(file.id)) || [];
  const totalCharacters = chosen.reduce((sum, file) => sum + file.characters, 0);
  const totalTokens = chosen.reduce((sum, file) => sum + file.estimatedTokens, 0);
  const contentBatches = Math.max(1, Math.ceil(totalCharacters / 60_000));
  const estimatedRequests = contentBatches + (contentBatches > 1 ? 1 : 0);

  async function run() {
    setRunning(true); setError("");
    try { onComplete(await api.runAiAnalysis(skill.id, [...selected])); }
    catch (reason) { setError(cleanError(reason)); setRunning(false); }
  }

  return <Modal title="AI 深度拆解" eyebrow="发送前最后确认" onClose={onClose} wide>
    {loading ? <div className="working-state compact"><span className="spinner"/><h3>正在本地检查文件…</h3></div> : confirmation ? <>
      <div className="ai-summary-strip"><div><small>目标服务</small><strong>{confirmation.providerHost}</strong></div><div><small>模型</small><strong>{confirmation.model}</strong></div><div><small>已选内容</small><strong>{totalCharacters.toLocaleString()} 字符</strong></div><div><small>估算</small><strong>≈ {totalTokens.toLocaleString()} tokens</strong></div></div>
      <div className="selection-heading"><div><strong>将发送的文件</strong><p>默认仅选择 SKILL.md 及其直接引用</p></div><span>{chosen.length} / {confirmation.files.length}</span></div>
      <div className="file-selection-list">{confirmation.files.map((file) => <label className={`file-selection ${file.blocked ? "blocked" : ""}`} key={file.id}>
        <input type="checkbox" disabled={file.blocked} checked={selected.has(file.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} />
        <span><strong>{file.relativePath}</strong><small>{file.blocked ? file.risk : `${file.characters.toLocaleString()} 字符 · ≈ ${file.estimatedTokens.toLocaleString()} tokens`}</small></span>
        {file.blocked && <em>已拦截</em>}
      </label>)}</div>
      <p className="privacy-note"><span>⌥</span> 本次估计 {estimatedRequests} 个请求（多批时含 1 次合并）；只有点击“确认并发送”后才会上传所选内容。</p>
    </> : null}
    {error && <div className="error-box"><p>{error}</p>{error.includes("设置") && <button className="text-button" onClick={openSettings}>打开 AI 设置</button>}</div>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!confirmation || !selected.size || running} onClick={run}>{running ? "分析中…" : "确认并发送"}</button></div>
  </Modal>;
}

export default function App() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [taxonomy, setTaxonomy] = useState<TaxonomySnapshot>({ categories: [], tags: [] });
  const [query, setQuery] = useState<LibraryQuery>({ sourceType: "all", aiStatus: "all" });
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<SkillDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [analysisTab, setAnalysisTab] = useState<"rule" | "ai">("rule");
  const [mobilePane, setMobilePane] = useState<"files" | "preview" | "analysis">("analysis");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [taxonomyOpen, setTaxonomyOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [removedSkill, setRemovedSkill] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeAnalysisItemId, setActiveAnalysisItemId] = useState<string | null>(null);
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(initialPaneWidths);
  const [collapsedPanes, setCollapsedPanes] = useState({ files: false, analysis: false });
  const [isResizing, setIsResizing] = useState(false);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const analysisAnchorsRef = useRef(new Map<string, HTMLElement>());
  const detailGridRef = useRef<HTMLElement>(null);

  const loadLibrary = useCallback(async (nextQuery: LibraryQuery) => {
    try {
      const [items, taxonomies] = await Promise.all([api.listSkills(nextQuery), api.getTaxonomy()]);
      setSkills(items); setTaxonomy(taxonomies); setError("");
    } catch (reason) { setError(cleanError(reason)); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = { ...query, search };
      void loadLibrary(next);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [search, query, loadLibrary]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => { setToast(""); setRemovedSkill(null); }, 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const savePaneWidths = useCallback((next: PaneWidths) => {
    setPaneWidths(next);
    try { window.localStorage.setItem(PANE_WIDTHS_STORAGE_KEY, JSON.stringify(next)); } catch { /* 本地存储不可用时仍保留当前会话布局 */ }
  }, []);

  const resetPaneWidths = useCallback(() => {
    const next = clampPaneWidths(WIDE_DEFAULT_PANE_WIDTHS, detailGridRef.current?.clientWidth || Math.max(900, window.innerWidth - 224));
    savePaneWidths(next);
    setCollapsedPanes({ files: false, analysis: false });
    setMoreOpen(false);
    setToast("已恢复默认三栏宽度");
  }, [savePaneWidths]);

  const updatePaneWidth = useCallback((side: "files" | "analysis", desiredWidth: number) => {
    const gridWidth = detailGridRef.current?.clientWidth || Math.max(900, window.innerWidth - 224);
    const next = side === "files" ? { ...paneWidths, files: desiredWidth } : { ...paneWidths, analysis: desiredWidth };
    savePaneWidths(clampPaneWidths(next, gridWidth));
  }, [paneWidths, savePaneWidths]);

  function startPaneResize(side: "files" | "analysis", event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !detailGridRef.current) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = paneWidths;
    const grid = detailGridRef.current;
    setIsResizing(true);
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const desiredWidth = side === "files" ? startWidths.files + delta : startWidths.analysis - delta;
      const next = side === "files" ? { ...startWidths, files: desiredWidth } : { ...startWidths, analysis: desiredWidth };
      savePaneWidths(clampPaneWidths(next, grid.clientWidth));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setIsResizing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function handleResizerKeyDown(side: "files" | "analysis", event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const delta = side === "files" ? direction * 24 : direction * -24;
    updatePaneWidth(side, paneWidths[side] + delta);
  }

  function togglePane(side: "files" | "analysis") {
    setCollapsedPanes((previous) => ({ ...previous, [side]: !previous[side] }));
  }

  async function openDetail(skillOrId: SkillDetail | string) {
    setBusy(true); setError("");
    try {
      const detail = typeof skillOrId === "string" ? await api.getSkill(skillOrId) : skillOrId;
      setCurrent(detail);
      const entry = detail.files.find((file) => file.isEntryFile) || detail.files.find((file) => file.previewable) || detail.files[0] || null;
      setSelectedFile(entry); setFileSearch(""); setAnalysisTab("rule"); setMobilePane("analysis"); setFocusLine(null);
      if (entry) setPreview(await api.getFilePreview(detail.id, entry.id));
    } catch (reason) { setError(cleanError(reason)); }
    finally { setBusy(false); }
  }

  async function chooseFile(file: IndexedFile, line: number | null = null) {
    if (!current) return;
    setSelectedFile(file); setFocusLine(line); setPreview(null); setMobilePane("preview");
    try { setPreview(await api.getFilePreview(current.id, file.id)); }
    catch (reason) { setError(cleanError(reason)); }
  }

  const registerAnalysisAnchor = useCallback((itemIds: string[], element: HTMLElement | null) => {
    if (!element) return;
    itemIds.forEach((id) => analysisAnchorsRef.current.set(id, element));
  }, []);

  function revealAnalysisItem(item: AnalysisItem) {
    setAnalysisTab("rule");
    setActiveAnalysisItemId(item.id);
    window.setTimeout(() => analysisAnchorsRef.current.get(item.id)?.scrollIntoView({ block: "center", behavior: "smooth" }), 0);
  }

  function openEvidence(item: AnalysisItem) {
    const evidence = item.evidence.find((candidate) => current?.files.some((file) => file.relativePath === candidate.relativePath));
    if (!evidence || !current) {
      setToast("此条内容没有可定位的本地原文依据");
      return;
    }
    const file = current.files.find((candidate) => candidate.relativePath === evidence.relativePath);
    if (!file) return;
    revealAnalysisItem(item);
    void chooseFile(file, evidence.startLine);
  }

  function revealAnalysisForHeading(line: number) {
    if (!current || !selectedFile) return;
    const candidates = current.ruleAnalysis.items.flatMap((item) => item.evidence.filter((evidence) => evidence.relativePath === selectedFile.relativePath && evidence.startLine).map((evidence) => ({ item, distance: Math.abs((evidence.startLine || 0) - line) })));
    const closest = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (!closest || closest.distance > 80) {
      setToast("未找到与此标题直接对应的拆解条目");
      return;
    }
    revealAnalysisItem(closest.item);
  }

  async function toggleFavorite(skill: SkillSummary | SkillDetail) {
    const next = !skill.isFavorite;
    try {
      await api.setFavorite(skill.id, next);
      if (current?.id === skill.id) setCurrent({ ...current, isFavorite: next });
      await loadLibrary({ ...query, search });
    } catch (reason) { setError(cleanError(reason)); }
  }

  async function saveTaxonomy(category: string | null, tags: string[]) {
    if (!current) return;
    try {
      await api.updateTaxonomy(current.id, category, tags);
      setCurrent(await api.getSkill(current.id));
      setTaxonomyOpen(false); setToast("分类与标签已更新");
      await loadLibrary({ ...query, search });
    } catch (reason) { setError(cleanError(reason)); }
  }

  async function rerunRules() {
    if (!current) return;
    setMoreOpen(false); setBusy(true);
    try { setCurrent(await api.rerunRules(current.id)); setToast("规则拆解已更新"); }
    catch (reason) { setError(cleanError(reason)); }
    finally { setBusy(false); }
  }

  async function removeCurrent() {
    if (!current || !window.confirm(`从资料库移除“${current.name}”？\n\n只会移除应用副本和索引，原本机目录或 GitHub 仓库不受影响。`)) return;
    const removed = current;
    try {
      await api.removeSkill(removed.id); setCurrent(null); setMoreOpen(false); await loadLibrary({ ...query, search });
      setRemovedSkill({ id: removed.id, name: removed.name });
      setToast(`已移除 ${removed.name} · 点此撤销`);
    } catch (reason) { setError(cleanError(reason)); }
  }

  async function undoToast() {
    if (!removedSkill) return;
    try {
      await api.undoRemove(removedSkill.id);
      setToast(`已恢复 ${removedSkill.name}`);
      setRemovedSkill(null);
      await loadLibrary({ ...query, search });
    } catch (reason) { setError(cleanError(reason)); }
  }

  const filteredFiles = useMemo(() => current?.files.filter((file) => file.relativePath.toLowerCase().includes(fileSearch.toLowerCase())) || [], [current, fileSearch]);
  const shownSections = useMemo(() => Object.keys(SECTION_LABELS) as AnalysisSection[], []);

  function forwardDetailWheel(event: WheelEvent<HTMLElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!event.deltaY || target?.closest(".preview-body, .analysis-scroll, .file-list")) return;
    const previewBody = previewBodyRef.current;
    if (!previewBody) return;
    previewBody.scrollBy({ top: event.deltaY, behavior: "auto" });
    event.preventDefault();
  }

  function scrollPreviewFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const previewBody = previewBodyRef.current;
    if (!previewBody) return;
    const page = Math.max(160, previewBody.clientHeight * 0.82);
    const offsets: Partial<Record<string, number>> = {
      ArrowDown: 48,
      ArrowUp: -48,
      PageDown: page,
      PageUp: -page,
      Home: -previewBody.scrollTop,
      End: previewBody.scrollHeight,
      " ": event.shiftKey ? -page : page,
    };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    previewBody.scrollBy({ top: offset, behavior: "smooth" });
    event.preventDefault();
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand" onClick={() => setCurrent(null)} role="button" tabIndex={0}>
        <span className="brand-mark">S<span>/</span></span><div><strong>Skill 拆解器</strong><small>Skill Explorer</small></div>
      </div>
      <nav className="main-nav" aria-label="资料库导航">
        <button className={!query.favoritesOnly && !query.category ? "active" : ""} onClick={() => setQuery({ ...query, favoritesOnly: false, category: "all" })}><span>◫</span>全部 Skill<em>{skills.length}</em></button>
        <button className={query.favoritesOnly ? "active" : ""} onClick={() => setQuery({ ...query, favoritesOnly: true, category: "all" })}><span>☆</span>收藏</button>
      </nav>
      <div className="nav-section"><div className="nav-label"><span>分类</span></div>{taxonomy.categories.length ? taxonomy.categories.map((category) => <button key={category} className={query.category === category ? "active" : ""} onClick={() => setQuery({ ...query, category, favoritesOnly: false })}><span className="folder-glyph"/>{category}</button>) : <p>导入后可添加分类</p>}</div>
      <div className="nav-section tags"><div className="nav-label"><span>标签</span></div>{taxonomy.tags.slice(0, 8).map((tag) => <button key={tag} onClick={() => setSearch(tag)}><span>#</span>{tag}</button>)}</div>
      <div className="sidebar-foot"><div className="privacy-pill"><span>●</span><div><strong>本地优先</strong><small>未经确认不上传</small></div></div><button className="settings-button" onClick={() => setSettingsOpen(true)} aria-label="设置">⚙</button></div>
    </aside>

    <main className="workspace">
      {!current ? <>
        <header className="topbar drag-region"><div className="search-wrap no-drag"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、描述、路径或标签…" />{search && <button onClick={() => setSearch("")} aria-label="清空">×</button>}</div><span className="result-count">{skills.length} 个结果</span><button className="button primary no-drag" onClick={() => setImportOpen(true)}><span>+</span> 导入 Skill</button></header>
        <section className="library-view">
          <div className="library-heading"><div><span className="eyebrow">你的本地知识库</span><h1>{query.favoritesOnly ? "收藏的 Skill" : query.category && query.category !== "all" ? query.category : "看懂每一个 Skill"}</h1><p>从用途、触发到执行流程，结论都能回到原文验证。</p></div><div className="filter-row"><select aria-label="来源筛选" value={query.sourceType} onChange={(event) => setQuery({ ...query, sourceType: event.target.value as LibraryQuery["sourceType"] })}><option value="all">全部来源</option><option value="local">本机目录</option><option value="github">GitHub</option></select><select aria-label="AI 状态筛选" value={query.aiStatus} onChange={(event) => setQuery({ ...query, aiStatus: event.target.value as LibraryQuery["aiStatus"] })}><option value="all">全部分析状态</option><option value="analyzed">已 AI 拆解</option><option value="not_analyzed">未 AI 拆解</option></select></div></div>
          {error && <div className="page-error"><span>!</span><p>{error}</p><button onClick={() => setError("")}>关闭</button></div>}
          {skills.length ? <div className="skill-grid">{skills.map((skill) => <article className="skill-card" key={skill.id} onClick={() => openDetail(skill.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") void openDetail(skill.id); }}>
            <div className="card-top"><span className={`format-icon ${skill.sourceType}`}>{skill.sourceType === "github" ? "GH" : "S"}</span><div className="status-cluster"><span className="rule-ready"><i/>规则就绪</span><button className={`favorite ${skill.isFavorite ? "on" : ""}`} onClick={(event) => { event.stopPropagation(); void toggleFavorite(skill); }} aria-label="收藏">☆</button></div></div>
            <h2>{skill.name}</h2><p className="skill-description">{skill.description}</p>
            <div className="chip-row">{skill.category && <span className="chip category">{skill.category}</span>}{skill.tags.slice(0, 3).map((tag) => <span className="chip" key={tag}>#{tag}</span>)}</div>
            <footer><span>{skill.sourceType === "github" ? "GitHub" : "本场目录"} · {skill.sourceDisplay}</span><span>{skill.fileCount} 文件</span></footer>
            <div className="card-progress"><span className={skill.analysisStatus === "succeeded" ? "complete" : ""}/><small>{skill.analysisStatus === "succeeded" ? "AI 深度拆解已完成" : "可选：AI 深度拆解"}</small></div>
          </article>)}</div> : <div className="empty-state"><span className="empty-graphic"><i/><b>S</b><em/></span><span className="eyebrow">3 分钟内看懂陌生 Skill</span><h2>{search || query.favoritesOnly ? "没有匹配的 Skill" : "从导入第一个 Skill 开始"}</h2><p>{search || query.favoritesOnly ? "试试清空搜索或调整筛选条件。" : "本地规则先完成基础拆解，不联网、不使用 API，也不修改原文件。"}</p>{search || query.favoritesOnly ? <button className="button secondary" onClick={() => { setSearch(""); setQuery({ sourceType: "all", aiStatus: "all" }); }}>清除条件</button> : <button className="button primary" onClick={() => setImportOpen(true)}>+ 导入 Skill</button>}</div>}
        </section>
      </> : <>
        <header className="detail-header drag-region"><button className="back-button no-drag" onClick={() => { setCurrent(null); setPreview(null); }} aria-label="返回">←</button><div className="detail-identity"><div className={`format-icon ${current.sourceType}`}>{current.sourceType === "github" ? "GH" : "S"}</div><div><div className="title-line"><h1>{current.name}</h1><span>{current.format === "codex" ? "Codex Skill" : "自定义格式"}</span></div><p>{current.sourceDisplay} · 导入于 {formatDate(current.importedAt)}</p></div></div><div className="detail-actions no-drag"><button className={`favorite standalone ${current.isFavorite ? "on" : ""}`} onClick={() => toggleFavorite(current)} aria-label="收藏">☆</button><button className="button secondary" onClick={() => setTaxonomyOpen(true)}># 分类与标签</button><button className="button primary ai-button" onClick={() => setAiOpen(true)}><span>✦</span> AI 深度拆解</button><div className="more-wrap"><button className="icon-button bordered" onClick={() => setMoreOpen(!moreOpen)} aria-label="更多">…</button>{moreOpen && <div className="more-menu"><button onClick={rerunRules}>↻ 重新规则拆解</button><button onClick={resetPaneWidths}>↔ 重置三栏宽度</button><button className="danger" onClick={removeCurrent}>⊘ 从资料库移除</button></div>}</div></div></header>
        <div className="mobile-tabs"><button className={mobilePane === "files" ? "active" : ""} onClick={() => setMobilePane("files")}>文件</button><button className={mobilePane === "preview" ? "active" : ""} onClick={() => setMobilePane("preview")}>预览</button><button className={mobilePane === "analysis" ? "active" : ""} onClick={() => setMobilePane("analysis")}>拆解</button></div>
        <section className={`detail-grid ${isResizing ? "is-resizing" : ""} ${collapsedPanes.files ? "files-collapsed" : ""} ${collapsedPanes.analysis ? "analysis-collapsed" : ""}`} ref={detailGridRef} style={{ "--file-pane-width": collapsedPanes.files ? "34px" : `${paneWidths.files}px`, "--analysis-pane-width": collapsedPanes.analysis ? "34px" : `${paneWidths.analysis}px`, "--left-resizer-width": collapsedPanes.files ? "0px" : "8px", "--right-resizer-width": collapsedPanes.analysis ? "0px" : "8px" } as CSSProperties} onWheelCapture={forwardDetailWheel}>
          <aside className={`file-pane mobile-${mobilePane === "files" ? "show" : "hide"} ${collapsedPanes.files ? "pane-collapsed" : ""}`}><button className="pane-reopen" onClick={() => togglePane("files")} aria-label="展开目录" title="展开目录">›</button><div className="pane-title"><div><span>目录</span><em>{current.files.length}</em></div><div className="pane-title-actions"><button title="文件只读">⌘</button><button className="pane-collapse-button" onClick={() => togglePane("files")} aria-label="收起目录" title="收起目录">‹</button></div></div><label className="file-search"><span>⌕</span><input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="搜索文件…" /></label><div className="file-list">{filteredFiles.map((file) => <button key={file.id} className={selectedFile?.id === file.id ? "selected" : ""} style={{ paddingLeft: `${18 + Math.min(3, file.relativePath.split("/").length - 1) * 14}px` }} onClick={() => chooseFile(file)}><span className={`file-type ${file.type}`}>{fileIcon(file)}</span><span><strong>{file.name}</strong>{file.relativePath.includes("/") && <small>{file.relativePath.slice(0, -file.name.length - 1)}</small>}</span>{file.isEntryFile && <em>入口</em>}</button>)}</div><footer><span>●</span>只读副本 · 不执行脚本</footer></aside>
          <div className="pane-resizer left-resizer" role="separator" aria-orientation="vertical" aria-label="调整目录栏宽度；双击恢复默认" tabIndex={0} onPointerDown={(event) => startPaneResize("files", event)} onDoubleClick={resetPaneWidths} onKeyDown={(event) => handleResizerKeyDown("files", event)}><span/></div>
          <section className={`preview-pane mobile-${mobilePane === "preview" ? "show" : "hide"}`}><div className="pane-title preview-title"><div className="breadcrumbs"><span>{current.name}</span><b>/</b><strong>{selectedFile?.relativePath || "未选文件"}</strong></div>{selectedFile?.type === "markdown" && <div className="segmented"><button className={renderMarkdown ? "active" : ""} onClick={() => { setRenderMarkdown(true); setFocusLine(null); }}>阅读</button><button className={!renderMarkdown ? "active" : ""} onClick={() => setRenderMarkdown(false)}>原文</button></div>}</div>
            <div className="preview-body" ref={previewBodyRef} tabIndex={0} aria-label="文件正文，可使用触控板、鼠标滚轮或方向键滚动" onKeyDown={scrollPreviewFromKeyboard}>{!selectedFile ? <div className="mini-empty">从左侧选择文件</div> : !preview ? <div className="working-state compact"><span className="spinner"/><p>读取中…</p></div> : preview.dataUrl ? <div className="image-preview"><img src={preview.dataUrl} alt={preview.relativePath}/></div> : preview.content !== null ? (preview.type === "markdown" && renderMarkdown ? <MarkdownPreview content={preview.content} focusLine={focusLine} onHeadingClick={revealAnalysisForHeading}/> : <SourcePreview content={preview.content} focusLine={focusLine}/>) : <div className="unsupported"><span>{fileIcon(selectedFile)}</span><h3>MVP 暂不预览此格式</h3><p>{selectedFile.extension.toUpperCase() || "未知格式"} · {formatBytes(selectedFile.size)}</p></div>}{preview?.truncated && <div className="truncated-note">文件较大，当前仅展示前 {formatBytes(512 * 1024)}。</div>}</div>
            {selectedFile && <footer className="file-meta"><span>{selectedFile.type}</span><span>{formatBytes(selectedFile.size)}</span><span>SHA-256 {selectedFile.hash.slice(0, 9)}…</span></footer>}
          </section>
          <div className="pane-resizer right-resizer" role="separator" aria-orientation="vertical" aria-label="调整规则拆解栏宽度；双击恢复默认" tabIndex={0} onPointerDown={(event) => startPaneResize("analysis", event)} onDoubleClick={resetPaneWidths} onKeyDown={(event) => handleResizerKeyDown("analysis", event)}><span/></div>
          <aside className={`analysis-pane mobile-${mobilePane === "analysis" ? "show" : "hide"} ${collapsedPanes.analysis ? "pane-collapsed" : ""}`}><button className="pane-reopen" onClick={() => togglePane("analysis")} aria-label="展开规则拆解" title="展开规则拆解">‹</button><div className="analysis-tabs"><button className={analysisTab === "rule" ? "active" : ""} onClick={() => setAnalysisTab("rule")}>规则拆解 <span>本地</span></button><button className={analysisTab === "ai" ? "active" : ""} onClick={() => setAnalysisTab("ai")}>AI 深度拆解 {current.aiAnalysis && <i/>}</button><button className="analysis-collapse-button" onClick={() => togglePane("analysis")} aria-label="收起规则拆解" title="收起规则拆解">›</button></div>
            {analysisTab === "rule" ? <div className="analysis-scroll"><div className="analysis-intro"><div><span>✓</span><strong>规则解析已完成</strong></div><p>点击右侧内容可定位左侧原文；点击左侧标题可回到对应拆解。</p></div><RuleQuickView skill={current} items={current.ruleAnalysis.items} onSelect={openEvidence}/><WorkflowSection items={current.ruleAnalysis.items.filter((item) => item.section === "workflow")} onSelect={openEvidence} onEvidence={openEvidence} activeItemId={activeAnalysisItemId} registerAnchor={registerAnalysisAnchor}/>{shownSections.filter((section) => section !== "basic" && section !== "workflow" && current.ruleAnalysis.items.some((item) => item.section === section)).map((section) => <AnalysisSectionCard key={section} section={section} items={current.ruleAnalysis.items.filter((item) => item.section === section)} onSelect={openEvidence} onEvidence={openEvidence} activeItemId={activeAnalysisItemId} registerAnchor={registerAnalysisAnchor}/>) }
              {current.ruleAnalysis.references.length > 0 && <div className="analysis-section references-section"><div className="section-heading"><span className="section-icon">↗</span><div><strong>文件引用关系</strong><small>{current.ruleAnalysis.references.length} 条</small></div></div>{current.ruleAnalysis.references.map((reference, index) => <button className="reference-row" key={`${reference.line}-${index}`} onClick={() => { if (reference.resolvedPath) { const file = current.files.find((item) => item.relativePath === reference.resolvedPath); if (file) void chooseFile(file, 1); } }}><span className={`reference-status ${reference.status}`}>{reference.status === "resolved" ? "✓" : reference.status === "external" ? "↗" : "!"}</span><span><strong>{reference.targetText}</strong><small>{reference.status === "resolved" ? "已解析" : reference.status === "missing" ? "未找到" : reference.status === "outside" ? "越界引用·已拦截" : "外部链接·未请求"}</small></span></button>)}</div>}
              {current.ruleAnalysis.warnings.map((warning) => <p className="analysis-warning" key={warning}>! {warning}</p>)}
            </div> : <div className="analysis-scroll ai-results">{current.aiAnalysis ? <><div className="ai-result-head"><span>✦</span><div><strong>{current.aiAnalysis.model}</strong><small>{formatDate(current.aiAnalysis.createdAt)} · {current.aiAnalysis.sourceFiles.length} 个文件</small></div></div><JsonSection value={current.aiAnalysis.content}/><button className="button secondary full" onClick={() => setAiOpen(true)}>重新分析</button></> : <div className="ai-empty"><span>✦</span><h3>需要更深的理解？</h3><p>AI 可补充建议场景、不适用情形、模糊点和值得学习的设计方法。</p><ul><li>你选择要发送的文件</li><li>发送前展示字符量和模型</li><li>AI 结果不覆盖规则事实</li></ul><button className="button primary" onClick={() => setAiOpen(true)}>开始 AI 深度拆解</button></div>}</div>}
          </aside>
        </section>
      </>}
    </main>

    {busy && <div className="busy-overlay"><span className="spinner"/></div>}
    {importOpen && <ImportModal onClose={() => setImportOpen(false)} setToast={setToast} onImported={(skill) => { setImportOpen(false); void loadLibrary({ ...query, search }); void openDetail(skill); }}/>}
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} setToast={setToast}/>}
    {aiOpen && current && <AiConfirmModal skill={current} onClose={() => setAiOpen(false)} openSettings={() => { setAiOpen(false); setSettingsOpen(true); }} onComplete={(detail) => { setCurrent(detail); setAiOpen(false); setAnalysisTab("ai"); setToast("AI 深度拆解已完成"); }}/>}
    {taxonomyOpen && current && <TaxonomyModal skill={current} existing={taxonomy} onClose={() => setTaxonomyOpen(false)} onSave={saveTaxonomy}/>}
    {toast && <button className="toast" onClick={removedSkill ? undoToast : undefined}>{toast}</button>}
  </div>;
}

function uniqueSummaries(items: AnalysisItem[]): string[] {
  return [...new Set(items.map((item) => item.summary.trim()).filter(Boolean))];
}

function EvidenceDetails({ items, onEvidence }: { items: AnalysisItem[]; onEvidence: (item: AnalysisItem) => void }) {
  const evidence = items.flatMap((item) => item.evidence).filter((item, index, all) => all.findIndex((candidate) => candidate.relativePath === item.relativePath && candidate.startLine === item.startLine) === index);
  if (!evidence.length) return null;
  return <details className="evidence-details" onClick={(event) => event.stopPropagation()}><summary>依据与原文（{evidence.length}）</summary><div>{evidence.map((evidenceItem, index) => { const owner = items.find((item) => item.evidence.some((candidate) => candidate.relativePath === evidenceItem.relativePath && candidate.startLine === evidenceItem.startLine)); return <button key={`${evidenceItem.relativePath}-${evidenceItem.startLine}-${index}`} onClick={() => owner && onEvidence(owner)}>查看 {evidenceItem.relativePath}{evidenceItem.startLine ? `:${evidenceItem.startLine}` : ""}</button>; })}</div></details>;
}

function QuickViewItem({ label, content, onSelect }: { label: string; content: string; onSelect: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = content.length > 110;

  return <article className={`quick-view-item${expanded ? " expanded" : ""}`}>
    <button type="button" className="quick-view-content" onClick={onSelect}>
      <span>{label}</span><p>{content}</p>
    </button>
    {canExpand && <button type="button" className="quick-view-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开全文"}</button>}
  </article>;
}

function RuleQuickView({ skill, items, onSelect }: { skill: SkillDetail; items: AnalysisItem[]; onSelect: (item: AnalysisItem) => void }) {
  const basic = items.filter((item) => item.section === "basic");
  const triggers = items.filter((item) => item.section === "triggers");
  const workflow = items.filter((item) => item.section === "workflow");
  const outputs = items.filter((item) => item.section === "inputs_outputs");
  const workflowTitles = [...new Set(workflow.map((item) => item.title).filter(Boolean))];
  const stripPrefix = (value: string) => value.replace(/^[^：:]{1,80}[：:]\s*/, "");
  const purpose = stripPrefix(uniqueSummaries(basic)[0] || "");
  const trigger = uniqueSummaries(triggers).map(stripPrefix).find((summary) => summary !== purpose && !purpose.includes(summary) && !summary.includes(purpose));
  const workflowPath = workflowTitles.length > 3 ? `${workflowTitles.slice(0, 3).join(" → ")} → …（共 ${workflowTitles.length} 步）` : workflowTitles.join(" → ");
  return <section className="rule-quick-view" aria-label="30 秒看懂"><div className="quick-view-heading"><span>⌁</span><div><strong>30 秒看懂</strong><small>先抓住用途、起点和路径</small></div></div><div className="quick-view-list"><QuickViewItem label="它解决什么" content={purpose || `${skill.name} 的基础用途尚未从原文中识别。`} onSelect={() => basic[0] && onSelect(basic[0])} /><QuickViewItem label="何时使用" content={trigger || "原文未提供独立的触发条件，可从下方流程的第一步开始判断。"} onSelect={() => triggers[0] && onSelect(triggers[0])} /><QuickViewItem label="怎么推进" content={workflowPath || "原文未识别到可复用的执行步骤。"} onSelect={() => workflow[0] && onSelect(workflow[0])} />{outputs.length > 0 && <QuickViewItem label="会得到什么" content={stripPrefix(uniqueSummaries(outputs)[0])} onSelect={() => onSelect(outputs[0])} />}</div></section>;
}

function WorkflowSection({ items, onSelect, onEvidence, activeItemId, registerAnchor }: { items: AnalysisItem[]; onSelect: (item: AnalysisItem) => void; onEvidence: (item: AnalysisItem) => void; activeItemId: string | null; registerAnchor: (itemIds: string[], element: HTMLElement | null) => void }) {
  const [expanded, setExpanded] = useState(true);
  const steps = [...items.reduce((groups, item) => {
    const key = item.title || "未命名步骤";
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
    return groups;
  }, new Map<string, AnalysisItem[]>())];
  const containsActiveItem = Boolean(activeItemId && items.some((item) => item.id === activeItemId));
  const visible = expanded || containsActiveItem;
  if (!items.length) return null;
  return <section className={`analysis-section workflow-section ${visible ? "expanded" : ""}`}><button className="section-heading" onClick={() => setExpanded(!visible)}><span className="section-icon">{SECTION_ICONS.workflow}</span><div><strong>执行流程</strong><small>{steps.length} 个步骤 · 已合并 {items.length} 条原文提取</small></div><em>{visible ? "−" : "+"}</em></button>{visible && <div className="workflow-list">{steps.map(([title, stepItems], index) => { const summaries = uniqueSummaries(stepItems); const active = stepItems.some((item) => item.id === activeItemId); return <article className={`workflow-step ${active ? "linked-active" : ""}`} key={title} ref={(element) => registerAnchor(stepItems.map((item) => item.id), element)} onClick={() => onSelect(stepItems[0])} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(stepItems[0]); } }}><span className="step-number">{index + 1}</span><div><h4>{title}</h4><p>{summaries[0]}</p>{summaries.length > 1 && <ul>{summaries.slice(1).map((summary) => <li key={summary}>{summary}</li>)}</ul>}<EvidenceDetails items={stepItems} onEvidence={onEvidence}/></div></article>; })}</div>}</section>;
}

function AnalysisSectionCard({ section, items, onSelect, onEvidence, activeItemId, registerAnchor }: { section: AnalysisSection; items: AnalysisItem[]; onSelect: (item: AnalysisItem) => void; onEvidence: (item: AnalysisItem) => void; activeItemId: string | null; registerAnchor: (itemIds: string[], element: HTMLElement | null) => void }) {
  const [expanded, setExpanded] = useState(section === "triggers");
  const active = items.some((item) => item.id === activeItemId);
  const visible = expanded || active;
  return <section className={`analysis-section compact-section ${visible ? "expanded" : ""} ${active ? "linked-active" : ""}`} ref={(element) => registerAnchor(items.map((item) => item.id), element)}><button className="section-heading" onClick={() => setExpanded(!visible)}><span className="section-icon">{SECTION_ICONS[section]}</span><div><strong>{SECTION_LABELS[section]}</strong><small>{items.length} 条已识别信息</small></div><em>{visible ? "−" : "+"}</em></button>{visible && <div className="section-content compact-content" onClick={() => onSelect(items[0])} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(items[0]); } }}><ul>{uniqueSummaries(items).map((summary) => <li key={summary}>{summary}</li>)}</ul><EvidenceDetails items={items} onEvidence={onEvidence}/></div>}</section>;
}

function TaxonomyModal({ skill, existing, onClose, onSave }: { skill: SkillDetail; existing: TaxonomySnapshot; onClose: () => void; onSave: (category: string | null, tags: string[]) => void }) {
  const [category, setCategory] = useState(skill.category || "");
  const [tags, setTags] = useState(skill.tags.join("，"));
  return <Modal title="分类与标签" eyebrow={skill.name} onClose={onClose}>
    <div className="form-stack"><label><span>分类</span><input className="text-input" list="category-list" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="例如：开发工具"/><datalist id="category-list">{existing.categories.map((item) => <option value={item} key={item}/>)}</datalist></label><label><span>标签</span><input className="text-input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，例如：Codex，写作，本地优先"/><small>标签会进入全局搜索，最多保存 20 个。</small></label></div>
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" onClick={() => onSave(category.trim() || null, tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))}>保存</button></div>
  </Modal>;
}
