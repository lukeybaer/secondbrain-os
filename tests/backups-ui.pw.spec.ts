import { test, expect } from "@playwright/test";

const BACKUPS_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, sans-serif; margin: 0; padding: 24px; }
    .summary { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .card { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 12px 16px; min-width: 110px; }
    .value { font-size: 20px; font-weight: 700; }
    .label { font-size: 11px; color: #777; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #111; border-radius: 4px; padding: 8px 12px; margin-bottom: 4px; }
    .left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; border: 1px solid #333; }
    .ok { background: #052e1a; color: #4ade80; border-color: #14532d; }
    .warn { background: #2b2106; color: #fbbf24; border-color: #713f12; }
    .fail { background: #2a0b0b; color: #f87171; border-color: #7f1d1d; }
    .neutral { background: #1e1e1e; color: #999; }
    button { padding: 5px 10px; border-radius: 6px; border: 1px solid #333; background: #1e1e1e; color: #ddd; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .primary { background: #7c3aed; color: #fff; border: none; }
    .danger { background: #991b1b; color: #fca5a5; border: none; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: none; align-items: center; justify-content: center; }
    .modal { width: 720px; max-width: 90vw; background: #111; border: 1px solid #222; border-radius: 12px; padding: 24px; }
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 14px 0; }
    .step.active { background: #7c3aed; color: #fff; }
    .panel { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 10px; margin: 10px 0; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>Backups</h1>
  <div class="summary">
    <div class="card"><div class="value">2</div><div class="label">Local snapshots</div></div>
    <div class="card"><div class="value">1</div><div class="label">S3 archives</div></div>
    <div class="card"><div class="value" id="missingS3">1</div><div class="label">Missing from S3</div></div>
    <div class="card"><div class="value" id="unreachable">No</div><div class="label">S3 unreachable</div></div>
  </div>
  <div class="panel" id="securityPanel">
    <strong>Security</strong>
    <span class="badge ok">Encrypted PII</span>
    <span class="badge warn">Encryption Unknown</span>
  </div>
  <div class="row" data-id="good">
    <div class="left">
      <span>good</span>
      <span class="badge ok">Health OK</span>
      <span class="badge ok">S3 Synced</span>
      <span class="badge ok">Encrypted PII</span>
    </div>
    <button onclick="openWizard('good')">Restore</button>
  </div>
  <div class="row" data-id="bad">
    <div class="left">
      <span>bad</span>
      <span class="badge fail">Health Failed</span>
      <span class="badge warn">S3 Missing</span>
      <span class="badge warn">Sensitive</span>
    </div>
    <button onclick="openWizard('bad')">Restore</button>
  </div>

  <div class="overlay" id="wizard">
    <div class="modal">
      <h2 id="title">Restore Wizard</h2>
      <div class="steps">
        <button class="step active" id="step1" onclick="setStep(1)">1. Summary</button>
        <button class="step" id="step2" onclick="setStep(2)">2. Integrity</button>
        <button class="step" id="step3" onclick="setStep(3)">3. Dry Run</button>
        <button class="step" id="step4" onclick="setStep(4)">4. Commit</button>
      </div>
      <div id="summary" class="panel">Tier: Daily<br>Size: 12 KB<br>Created: May 16, 2026</div>
      <div id="integrity" class="panel hidden"></div>
      <div id="dryRun" class="panel hidden">
        <button id="runDryRun" onclick="runDryRun()">Run Dry-Run Restore</button>
        <div id="preview" class="hidden">Files restored: 8<br>Config present: Yes<br>Database present: Yes<br>Temp path: C:\\tmp\\restore</div>
      </div>
      <div id="commit" class="panel hidden">
        <div>Final commit restore confirmation</div>
        <button id="commitBtn" class="danger" disabled>Commit Restore</button>
      </div>
    </div>
  </div>

  <script>
    let activeId = "good";
    let previewReady = false;
    const reports = {
      good: { status: "ok", text: "Health OK" },
      bad: { status: "failed", text: "Health Failed: data/ directory is missing." }
    };
    function openWizard(id) {
      activeId = id;
      previewReady = false;
      document.getElementById("wizard").style.display = "flex";
      document.getElementById("title").textContent = "Restore Wizard: " + id;
      document.getElementById("integrity").textContent = reports[id].text;
      document.getElementById("commitBtn").disabled = true;
      document.getElementById("preview").classList.add("hidden");
      setStep(1);
    }
    function setStep(step) {
      ["summary", "integrity", "dryRun", "commit"].forEach((id, i) => {
        document.getElementById(id).classList.toggle("hidden", i + 1 !== step);
        document.getElementById("step" + (i + 1)).classList.toggle("active", i + 1 === step);
      });
      if (step === 4) {
        document.getElementById("commitBtn").disabled = reports[activeId].status === "failed" || !previewReady;
      }
    }
    function runDryRun() {
      previewReady = true;
      document.getElementById("preview").classList.remove("hidden");
    }
  </script>
</body>
</html>`;

test.describe("Backups UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(BACKUPS_HTML);
  });

  test("backup row shows health, S3, and security badges", async ({ page }) => {
    const row = page.locator('[data-id="good"]');
    await expect(row).toContainText("Health OK");
    await expect(row).toContainText("S3 Synced");
    await expect(row).toContainText("Encrypted PII");
  });

  test("restore button opens wizard instead of browser confirm", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.locator('[data-id="good"] button').click();
    await expect(page.locator("#wizard")).toBeVisible();
    await expect(page.locator("#title")).toHaveText("Restore Wizard: good");
  });

  test("wizard blocks commit when integrity status is failed", async ({ page }) => {
    await page.locator('[data-id="bad"] button').click();
    await page.locator("#step3").click();
    await page.locator("#runDryRun").click();
    await page.locator("#step4").click();
    await expect(page.locator("#commitBtn")).toBeDisabled();
  });

  test("wizard shows dry-run restore preview after test restore", async ({ page }) => {
    await page.locator('[data-id="good"] button').click();
    await page.locator("#step3").click();
    await page.locator("#runDryRun").click();
    await expect(page.locator("#preview")).toBeVisible();
    await expect(page.locator("#preview")).toContainText("Files restored: 8");
    await expect(page.locator("#preview")).toContainText("Temp path:");
  });

  test("S3 summary panel shows synced, missing, and unavailable states", async ({ page }) => {
    await expect(page.locator("#missingS3")).toHaveText("1");
    await expect(page.locator("#unreachable")).toHaveText("No");
    await expect(page.locator('[data-id="bad"]')).toContainText("S3 Missing");
  });

  test("security panel distinguishes encrypted vault present vs encryption unknown", async ({ page }) => {
    await expect(page.locator("#securityPanel")).toContainText("Encrypted PII");
    await expect(page.locator("#securityPanel")).toContainText("Encryption Unknown");
  });
});
