import { contextBridge, ipcRenderer } from "electron";
import type { ImportProgress, LibraryQuery, SkillExplorerApi } from "./shared";

const api: SkillExplorerApi = {
  listSkills: (query?: LibraryQuery) => ipcRenderer.invoke("library:list", query),
  getSkill: (id) => ipcRenderer.invoke("library:get", id),
  chooseLocalDirectory: () => ipcRenderer.invoke("import:choose-local"),
  confirmLocalImport: (token) => ipcRenderer.invoke("import:confirm-local", token),
  inspectGithub: (url) => ipcRenderer.invoke("import:inspect-github", url),
  confirmGithubImport: (token, candidatePath) => ipcRenderer.invoke("import:confirm-github", token, candidatePath),
  getFilePreview: (skillId, fileId) => ipcRenderer.invoke("file:preview", skillId, fileId),
  setFavorite: (skillId, value) => ipcRenderer.invoke("library:set-favorite", skillId, value),
  updateTaxonomy: (skillId, category, tags) => ipcRenderer.invoke("library:update-taxonomy", skillId, category, tags),
  getTaxonomy: () => ipcRenderer.invoke("library:taxonomy"),
  removeSkill: (skillId) => ipcRenderer.invoke("library:remove", skillId),
  undoRemove: (skillId) => ipcRenderer.invoke("library:undo-remove", skillId),
  rerunRules: (skillId) => ipcRenderer.invoke("analysis:rerun-rules", skillId),
  linkLocalSource: (skillId) => ipcRenderer.invoke("source:link-local", skillId),
  checkSourceUpdate: (skillId) => ipcRenderer.invoke("source:check", skillId),
  applySourceUpdate: (token) => ipcRenderer.invoke("source:apply", token),
  discardSourceUpdate: (token) => ipcRenderer.invoke("source:discard", token),
  getChangeLines: (token, relativePath) => ipcRenderer.invoke("source:diff-lines", token, relativePath),
  compareSkills: (leftId, rightId) => ipcRenderer.invoke("compare:skills", leftId, rightId),
  getEditableFile: (skillId, fileId) => ipcRenderer.invoke("editor:get", skillId, fileId),
  prepareFileEdit: (skillId, fileId, content) => ipcRenderer.invoke("editor:prepare", skillId, fileId, content),
  applyFileEdit: (token) => ipcRenderer.invoke("editor:apply", token),
  listVersions: (skillId) => ipcRenderer.invoke("history:list", skillId),
  diffVersion: (skillId, versionId) => ipcRenderer.invoke("history:diff", skillId, versionId),
  restoreVersion: (skillId, versionId) => ipcRenderer.invoke("history:restore", skillId, versionId),
  prepareTransfer: (skillId, mode) => ipcRenderer.invoke("transfer:prepare", skillId, mode),
  applyTransfer: (token, strategy) => ipcRenderer.invoke("transfer:apply", token, strategy),
  getAiSettings: () => ipcRenderer.invoke("ai:get-settings"),
  saveAiSettings: (settings) => ipcRenderer.invoke("ai:save-settings", settings),
  testAiConnection: () => ipcRenderer.invoke("ai:test"),
  prepareAiAnalysis: (skillId) => ipcRenderer.invoke("ai:prepare", skillId),
  runAiAnalysis: (skillId, fileIds) => ipcRenderer.invoke("ai:run", skillId, fileIds),
  onImportProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress) => callback(progress);
    ipcRenderer.on("import:progress", listener);
    return () => ipcRenderer.removeListener("import:progress", listener);
  },
};

contextBridge.exposeInMainWorld("skillExplorer", api);
