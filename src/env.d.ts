/// <reference types="vite/client" />

import type { SkillExplorerApi } from "../electron/shared";

declare global {
  interface Window {
    skillExplorer: SkillExplorerApi;
  }
}

export {};
