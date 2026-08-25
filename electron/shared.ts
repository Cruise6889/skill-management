export type SourceType = "local" | "github";
export type SkillFormat = "codex" | "custom";
export type AnalysisStatus = "ready" | "not_started" | "running" | "succeeded" | "failed";
export type Confidence = "high" | "medium" | "low";

export type AnalysisSection =
  | "basic"
  | "use_cases"
  | "triggers"
  | "workflow"
  | "inputs_outputs"
  | "constraints"
  | "tools"
  | "file_roles";

export interface Evidence {
  relativePath: string;
  startLine: number | null;
  endLine: number | null;
  excerpt: string;
  ruleId: string;
}

export interface AnalysisItem {
  id: string;
  section: AnalysisSection;
  title?: string;
  summary: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface FileReference {
  sourcePath: string;
  targetText: string;
  resolvedPath: string | null;
  status: "resolved" | "missing" | "outside" | "external";
  line: number;
}

export interface RuleAnalysis {
  schemaVersion: "1.0";
  parserLabel: "规则解析";
  items: AnalysisItem[];
  references: FileReference[];
  warnings: string[];
}

export interface IndexedFile {
  id: string;
  relativePath: string;
  name: string;
  extension: string;
  type: "markdown" | "text" | "code" | "json" | "yaml" | "image" | "binary";
  size: number;
  hash: string;
  previewable: boolean;
  isEntryFile: boolean;
  hidden: boolean;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  format: SkillFormat;
  sourceType: SourceType;
  sourceDisplay: string;
  importedAt: string;
  updatedAt: string;
  category: string | null;
  tags: string[];
  isFavorite: boolean;
  analysisStatus: AnalysisStatus;
  fileCount: number;
}

export type ChangeKind = "added" | "modified" | "deleted" | "unchanged";

export interface FileChange {
  relativePath: string;
  kind: ChangeKind;
  oldHash: string | null;
  newHash: string | null;
  oldSize: number | null;
  newSize: number | null;
}

export interface LineChange {
  kind: "context" | "added" | "deleted";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface SourceStatus {
  kind: "local" | "github";
  state: "linked" | "missing" | "checking" | "up_to_date" | "changes";
  display: string;
  branch: string | null;
  revision: string | null;
  lastCheckedAt: string | null;
}

export interface UpdatePreview {
  token: string;
  source: SourceStatus;
  changes: FileChange[];
  summary: { added: number; modified: number; deleted: number; unchanged: number };
}

export interface VersionSummary {
  id: string;
  label: string;
  origin: "import" | "source_update" | "edit" | "restore";
  note: string;
  createdAt: string;
  fileCount: number;
}

export interface VersionDiff {
  version: VersionSummary;
  changes: FileChange[];
}

export interface EditPreview {
  token: string;
  relativePath: string;
  lines: LineChange[];
  oldHash: string;
  newHash: string;
}

export interface TransferPreview {
  token: string;
  mode: "install" | "export";
  targetDisplay: string;
  folderName: string;
  targetExists: boolean;
  changes: FileChange[];
  conflicts: number;
}

export interface CompareSection {
  section: AnalysisSection;
  left: string[];
  right: string[];
  shared: string[];
}

export interface SkillComparison {
  left: Pick<SkillSummary, "id" | "name" | "description" | "sourceType" | "fileCount">;
  right: Pick<SkillSummary, "id" | "name" | "description" | "sourceType" | "fileCount">;
  sections: CompareSection[];
}

export interface AiAnalysis {
  id: string;
  content: Record<string, unknown>;
  model: string;
  sourceFiles: string[];
  promptVersion: string;
  createdAt: string;
  status: "succeeded" | "failed";
}

export interface SkillDetail extends SkillSummary {
  files: IndexedFile[];
  ruleAnalysis: RuleAnalysis;
  aiAnalysis: AiAnalysis | null;
  sourceStatus: SourceStatus;
}

export interface LibraryQuery {
  search?: string;
  sourceType?: SourceType | "all";
  favoritesOnly?: boolean;
  aiStatus?: "all" | "analyzed" | "not_analyzed";
  category?: string | "all";
}

export interface LocalPreflight {
  token: string;
  directoryName: string;
  sourceDisplay: string;
  fileCount: number;
  totalBytes: number;
  hasSkillEntry: boolean;
  format: SkillFormat;
  warnings: string[];
}

export interface GithubCandidate {
  relativePath: string;
  label: string;
  confidence: "high" | "low";
}

export interface GithubPreflight {
  token: string;
  repositoryName: string;
  defaultBranch: string;
  candidates: GithubCandidate[];
  warnings: string[];
}

export interface ImportProgress {
  stage: "checking" | "copying" | "indexing" | "parsing" | "done" | "failed";
  message: string;
}

export interface FilePreview {
  relativePath: string;
  type: IndexedFile["type"];
  size: number;
  content: string | null;
  dataUrl: string | null;
  truncated: boolean;
}

export interface AiSettingsPublic {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyLast4: string;
  allowLocalHttp: boolean;
}

export interface AiFileSelection {
  id: string;
  relativePath: string;
  characters: number;
  estimatedTokens: number;
  selected: boolean;
  blocked: boolean;
  risk: string | null;
}

export interface AiConfirmation {
  providerHost: string;
  model: string;
  files: AiFileSelection[];
  estimatedRequests: number;
}

export interface TaxonomySnapshot {
  categories: string[];
  tags: string[];
}

export interface SkillExplorerApi {
  listSkills(query?: LibraryQuery): Promise<SkillSummary[]>;
  getSkill(id: string): Promise<SkillDetail>;
  chooseLocalDirectory(): Promise<LocalPreflight | null>;
  confirmLocalImport(token: string): Promise<SkillDetail>;
  inspectGithub(url: string): Promise<GithubPreflight>;
  confirmGithubImport(token: string, candidatePath: string): Promise<SkillDetail>;
  getFilePreview(skillId: string, fileId: string): Promise<FilePreview>;
  setFavorite(skillId: string, value: boolean): Promise<void>;
  updateTaxonomy(skillId: string, category: string | null, tags: string[]): Promise<void>;
  getTaxonomy(): Promise<TaxonomySnapshot>;
  removeSkill(skillId: string): Promise<void>;
  undoRemove(skillId: string): Promise<void>;
  rerunRules(skillId: string): Promise<SkillDetail>;
  linkLocalSource(skillId: string): Promise<UpdatePreview | null>;
  checkSourceUpdate(skillId: string): Promise<UpdatePreview>;
  applySourceUpdate(token: string): Promise<SkillDetail>;
  discardSourceUpdate(token: string): Promise<void>;
  getChangeLines(token: string, relativePath: string): Promise<LineChange[]>;
  compareSkills(leftId: string, rightId: string): Promise<SkillComparison>;
  getEditableFile(skillId: string, fileId: string): Promise<{ relativePath: string; content: string }>;
  prepareFileEdit(skillId: string, fileId: string, content: string): Promise<EditPreview>;
  applyFileEdit(token: string): Promise<SkillDetail>;
  listVersions(skillId: string): Promise<VersionSummary[]>;
  diffVersion(skillId: string, versionId: string): Promise<VersionDiff>;
  restoreVersion(skillId: string, versionId: string): Promise<SkillDetail>;
  prepareTransfer(skillId: string, mode: "install" | "export"): Promise<TransferPreview | null>;
  applyTransfer(token: string, strategy: "overwrite" | "rename"): Promise<{ destinationDisplay: string }>;
  getAiSettings(): Promise<AiSettingsPublic>;
  saveAiSettings(settings: { baseUrl: string; model: string; apiKey?: string; allowLocalHttp: boolean }): Promise<AiSettingsPublic>;
  testAiConnection(): Promise<void>;
  prepareAiAnalysis(skillId: string): Promise<AiConfirmation>;
  runAiAnalysis(skillId: string, fileIds: string[]): Promise<SkillDetail>;
  onImportProgress(callback: (progress: ImportProgress) => void): () => void;
}
