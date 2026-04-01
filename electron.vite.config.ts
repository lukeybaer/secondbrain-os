import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // Bundle all dependencies into the output file.
    // Native modules (better-sqlite3) MUST stay external — Vite cannot bundle .node files.
    build: {
      rollupOptions: {
        external: ["electron", /^node:/, "better-sqlite3"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron", /^node:/, "better-sqlite3"],
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
