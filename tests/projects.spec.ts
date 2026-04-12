import path from "path";
import fs from "fs";
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

const MAIN_JS = "out/main/index.js";
const ELECTRON_PROJECTS_DIR = path.join(
  process.env.APPDATA ?? "",
  "Electron",
  "data",
  "projects"
);
const SEED_PROJECT_ID = "dentist-mckinney";
const SEED_PROJECT_PATH = path.join(
  process.env.APPDATA ?? "",
  "secondbrain",
  "data",
  "projects",
  "dentist-mckinney.json"
);

function ensureSeedData(): void {
  fs.mkdirSync(ELECTRON_PROJECTS_DIR, { recursive: true });
  const dest = path.join(ELECTRON_PROJECTS_DIR, `${SEED_PROJECT_ID}.json`);
  if (fs.existsSync(SEED_PROJECT_PATH)) {
    fs.copyFileSync(SEED_PROJECT_PATH, dest);
  }
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  ensureSeedData();
  const app = await electron.launch({ args: [MAIN_JS] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function navigateToProjects(page: Page): Promise<void> {
  await page.locator("nav button", { hasText: "Projects" }).click();
  // Wait for the project list to load
  await page.waitForTimeout(1500);
}

/** Scoped to the 280px project list sidebar */
function projectListSidebar(page: Page) {
  return page.locator("div[style*='width: 280px']");
}

test("Projects tab appears in sidebar nav", async () => {
  const { app, page } = await launchApp();
  try {
    await expect(
      page.locator("nav button", { hasText: "Projects" })
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("Dentist project loads when Projects tab is clicked", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await expect(
      projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first()
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("Dentist project tasks are listed after selecting project", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first().click();
    // Starlite Dental task title should appear in the detail panel
    await expect(
      page.locator("div", { hasText: "Starlite Dental — Dr. Nidhi Jaiswal" }).first()
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("Starlite Dental task shows phone number", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first().click();
    // The phone number is rendered as a clickable copy button
    await expect(
      page.locator("button", { hasText: "+12145040500" })
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("Task status chip cycles when clicked", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first().click();
    await page.waitForTimeout(500);

    // Status chips are buttons with title "Click to change to: <next>"
    const statusChip = page.locator("button[title*='Click to change']").first();
    await expect(statusChip).toBeVisible({ timeout: 10000 });
    const before = (await statusChip.textContent()) ?? "";

    await statusChip.click();
    await expect(statusChip).not.toHaveText(before, { timeout: 5000 });
  } finally {
    // Restore seed data since status was mutated
    ensureSeedData();
    await app.close();
  }
});

test("Call Now button is present on a task with phone number", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first().click();
    await expect(
      page.locator("button", { hasText: "Call Now" }).first()
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("Add new project — appears in sidebar after creation", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);

    // Click "+ New" inside the project list sidebar
    await projectListSidebar(page).locator("button", { hasText: "+ New" }).click();

    const nameInput = page.locator('input[placeholder="Project name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill("E2E Test Project");

    const descInput = page.locator('textarea[placeholder="What is this project about?"]');
    await descInput.fill("Created by Playwright E2E test");

    await page.locator("button", { hasText: "Create" }).click();

    // New project should appear in the sidebar
    await expect(
      projectListSidebar(page).locator("button", { hasText: "E2E Test Project" })
    ).toBeVisible({ timeout: 8000 });
  } finally {
    // Cleanup: remove any project files that aren't the seed
    if (fs.existsSync(ELECTRON_PROJECTS_DIR)) {
      for (const f of fs.readdirSync(ELECTRON_PROJECTS_DIR)) {
        if (f === `${SEED_PROJECT_ID}.json`) continue;
        try { fs.unlinkSync(path.join(ELECTRON_PROJECTS_DIR, f)); } catch {}
      }
    }
    await app.close();
  }
});

test("Add task to project — task appears in project detail", async () => {
  const { app, page } = await launchApp();
  try {
    await navigateToProjects(page);
    await projectListSidebar(page).locator("button", { hasText: "Find Dentist" }).first().click();
    await page.waitForTimeout(500);

    await page.locator("button", { hasText: "+ Add Task" }).click();

    const taskForm = page.locator("form", { hasText: "New Task" });
    const titleInput = taskForm.locator('input[placeholder="Task title"]');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill("E2E Test Task");

    // Scope phone input to task form to avoid collision with Calls page inputs
    const phoneInput = taskForm.locator('input[type="tel"]');
    await phoneInput.fill("+15555550123");

    await taskForm.locator("button[type='submit']").click();

    // Task should appear in the detail panel
    await expect(
      page.locator("div", { hasText: "E2E Test Task" }).first()
    ).toBeVisible({ timeout: 8000 });
  } finally {
    // Restore seed data since task was written to project file
    ensureSeedData();
    await app.close();
  }
});
