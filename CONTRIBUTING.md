# Contributing to SecondBrain

## Development Setup

### Prerequisites

- **Node.js 18+** (LTS recommended)
- **Windows 10/11** (primary dev platform)
- **Git**

### Install

```bash
git clone https://github.com/yourusername/secondbrain.git
cd secondbrain
npm install
```

The `postinstall` script automatically rebuilds `better-sqlite3` for Electron's Node.js version.

### Run

```bash
npm run dev
```

This starts Electron with hot reload via electron-vite. The app opens automatically.

### Configure

On first launch, open the **Settings** page and add your API keys. The app stores config at `%APPDATA%/secondbrain/config.json`. No API keys are hardcoded in the source — you bring your own.

---

## Code Standards

- **TypeScript strict** — No `any` except where truly unavoidable
- **Dark theme UI** — `#0f0f0f` background, `#111` sidebar, consistent throughout
- **File-based storage** — JSON files + SQLite. No external database.
- **IPC pattern** — All main/renderer communication through `ipc-handlers.ts` -> `preload/index.ts` -> renderer. Never call Node APIs directly from the renderer.

---

## Testing

```bash
npm test             # Vitest unit tests (*.spec.ts)
npm run test:e2e     # Playwright E2E tests (*.pw.spec.ts)
npx tsc --noEmit     # Type check (no emit)
```

- **Unit tests** go in `tests/` matching `*.spec.ts`
- **E2E tests** go in `tests/` matching `*.pw.spec.ts`
- New features should include tests

---

## Project Layout

```
src/main/          # Electron main process (Node.js backend)
src/preload/       # Context bridge (secure IPC)
src/renderer/      # React frontend
tests/             # Unit + E2E tests
```

### Adding a New Feature

1. **Main process handler** — Add logic in `src/main/yourfeature.ts`
2. **IPC handler** — Register in `src/main/ipc-handlers.ts`
3. **Preload bridge** — Expose in `src/preload/index.ts` under `window.api`
4. **Renderer page** — Add page in `src/renderer/src/pages/YourFeature.tsx`
5. **Navigation** — Add tab in `src/renderer/src/App.tsx`
6. **Tests** — Add unit test in `tests/yourfeature.spec.ts`

### Adding a New IPC Handler

```typescript
// 1. src/main/ipc-handlers.ts
ipcMain.handle("yourfeature:action", async (_event, arg1, arg2) => {
  return await yourFunction(arg1, arg2);
});

// 2. src/preload/index.ts
yourfeature: {
  action: (arg1: string, arg2: number) =>
    ipcRenderer.invoke("yourfeature:action", arg1, arg2),
}

// 3. Renderer
const result = await window.api.yourfeature.action("foo", 42);
```

---

## Build

```bash
npm run build        # Compile TypeScript to out/
npm run dist         # Build Windows installer (electron-packager)
```

The installer outputs to `dist-pkg/`.
