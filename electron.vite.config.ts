import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  main: { build: { commonjsOptions: { include: [/node_modules/, /scripts/] }, rollupOptions: { external: ['electron', /^node:/, 'better-sqlite3', 'whatsapp-web.js', 'puppeteer', 'puppeteer-core', 'bufferutil', 'utf-8-validate'] } } },
  preload: { build: { commonjsOptions: { include: [/node_modules/, /scripts/] }, rollupOptions: { external: ['electron', /^node:/, 'better-sqlite3', 'whatsapp-web.js'] } } },
  renderer: { resolve: { alias: { '@renderer': resolve('src/renderer/src') } }, plugins: [react()] },
});
