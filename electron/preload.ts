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
