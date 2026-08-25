import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve("electron/main.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("electron/preload.ts"),
        output: { format: "cjs", entryFileNames: "preload.cjs" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    resolve: { alias: { "@": resolve("src") } },
    build: { rollupOptions: { input: resolve("index.html") } },
  },
});
