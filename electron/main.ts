import { app, BrowserWindow, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "./services/ai";
import { SkillDatabase } from "./services/database";
import { ImportService } from "./services/importer";
import { WorkspaceService } from "./services/workspace";
import type { ImportProgress, LibraryQuery } from "./shared";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let database: SkillDatabase;
let importer: ImportService;
let ai: AiService;
let workspace: WorkspaceService;

function safeHandler<T extends unknown[]>(handler: (...args: T) => unknown | Promise<unknown>) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: T) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "操作失败，请稍后重试。");
    }
  };
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 620,
    title: "Skill 拆解器",
    backgroundColor: "#f5f3ed",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(currentDir, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() || "";
    if (url !== currentUrl) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(currentDir, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("library:list", safeHandler((query?: LibraryQuery) => database.listSkills(query)));
  ipcMain.handle("library:get", safeHandler((id: string) => database.getSkill(id)));
  ipcMain.handle("import:choose-local", safeHandler(() => {
    if (!mainWindow) throw new Error("应用窗口未就绪。");
    return importer.chooseLocalDirectory(mainWindow);
  }));
  ipcMain.handle("import:confirm-local", safeHandler((token: string) => importer.confirmLocalImport(token)));
  ipcMain.handle("import:inspect-github", safeHandler((url: string) => importer.inspectGithub(url)));
  ipcMain.handle("import:confirm-github", safeHandler((token: string, candidatePath: string) => importer.confirmGithubImport(token, candidatePath)));
  ipcMain.handle("file:preview", safeHandler((skillId: string, fileId: string) => importer.getFilePreview(skillId, fileId)));
  ipcMain.handle("library:set-favorite", safeHandler((skillId: string, value: boolean) => database.setFavorite(skillId, value)));
  ipcMain.handle("library:update-taxonomy", safeHandler((skillId: string, category: string | null, tags: string[]) => database.updateTaxonomy(skillId, category, tags)));
  ipcMain.handle("library:taxonomy", safeHandler(() => database.getTaxonomy()));
  ipcMain.handle("analysis:rerun-rules", safeHandler((skillId: string) => importer.rerunRules(skillId)));
  ipcMain.handle("source:link-local", safeHandler((skillId: string) => {
    if (!mainWindow) throw new Error("应用窗口未就绪。");
    return workspace.linkLocalSource(mainWindow, skillId);
  }));
  ipcMain.handle("source:check", safeHandler((skillId: string) => workspace.checkSourceUpdate(skillId)));
  ipcMain.handle("source:apply", safeHandler((token: string) => workspace.applySourceUpdate(token)));
  ipcMain.handle("source:discard", safeHandler((token: string) => workspace.discardSourceUpdate(token)));
  ipcMain.handle("source:diff-lines", safeHandler((token: string, relativePath: string) => workspace.getChangeLines(token, relativePath)));
  ipcMain.handle("compare:skills", safeHandler((leftId: string, rightId: string) => workspace.compareSkills(leftId, rightId)));
  ipcMain.handle("editor:get", safeHandler((skillId: string, fileId: string) => workspace.getEditableFile(skillId, fileId)));
  ipcMain.handle("editor:prepare", safeHandler((skillId: string, fileId: string, content: string) => workspace.prepareFileEdit(skillId, fileId, content)));
  ipcMain.handle("editor:apply", safeHandler((token: string) => workspace.applyFileEdit(token)));
  ipcMain.handle("history:list", safeHandler((skillId: string) => workspace.listVersions(skillId)));
  ipcMain.handle("history:diff", safeHandler((skillId: string, versionId: string) => workspace.diffVersion(skillId, versionId)));
  ipcMain.handle("history:restore", safeHandler((skillId: string, versionId: string) => workspace.restoreVersion(skillId, versionId)));
  ipcMain.handle("transfer:prepare", safeHandler((skillId: string, mode: "install" | "export") => {
    if (!mainWindow) throw new Error("应用窗口未就绪。");
    return workspace.prepareTransfer(mainWindow, skillId, mode);
  }));
  ipcMain.handle("transfer:apply", safeHandler((token: string, strategy: "overwrite" | "rename") => workspace.applyTransfer(token, strategy)));
  ipcMain.handle("library:remove", safeHandler(async (skillId: string) => {
    const { libraryPath } = database.getInternalPaths(skillId);
    const trashDir = path.join(app.getPath("userData"), "app-data", "trash");
    const trashedPath = path.join(trashDir, `${skillId}-${Date.now()}`);
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(libraryPath, trashedPath);
    database.markRemoved(skillId, trashedPath);
  }));
  ipcMain.handle("library:undo-remove", safeHandler(async (skillId: string) => {
    const { libraryPath, trashedPath } = database.getInternalPaths(skillId);
    if (!trashedPath) throw new Error("没有可恢复的移除记录。");
    await fs.mkdir(path.dirname(libraryPath), { recursive: true });
    await fs.rename(trashedPath, libraryPath);
    database.restore(skillId);
  }));
  ipcMain.handle("ai:get-settings", safeHandler(() => ai.getSettings()));
  ipcMain.handle("ai:save-settings", safeHandler((settings: { baseUrl: string; model: string; apiKey?: string; allowLocalHttp: boolean }) => ai.saveSettings(settings)));
  ipcMain.handle("ai:test", safeHandler(() => ai.testConnection()));
  ipcMain.handle("ai:prepare", safeHandler((skillId: string) => ai.prepare(skillId)));
  ipcMain.handle("ai:run", safeHandler((skillId: string, fileIds: string[]) => ai.run(skillId, fileIds)));
}

app.whenReady().then(async () => {
  app.setName("Skill 拆解器");
  const dataRoot = path.join(app.getPath("userData"), "app-data");
  await Promise.all(["library", "temp", "trash", "repositories", "logs", "installation-backups"].map((directory) => fs.mkdir(path.join(dataRoot, directory), { recursive: true })));
  database = new SkillDatabase(dataRoot);
  importer = new ImportService(dataRoot, database, (progress: ImportProgress) => mainWindow?.webContents.send("import:progress", progress));
  ai = new AiService(dataRoot, database);
  workspace = new WorkspaceService(dataRoot, database);
  registerIpc();
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
