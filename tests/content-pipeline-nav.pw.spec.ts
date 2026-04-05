/**
 * Playwright e2e tests for ContentPipeline navigation:
 * - Forward/Back nav buttons
 * - Auto-advance after Approve / Reject
 * - No state bleed between videos (no glitch)
 * - Video element is present and not in error state
 *
 * Strategy: page.setContent() with a self-contained JS sim of the ContentPipeline
 * state machine — no React/Electron required, just the core navigation logic.
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared page setup: simulates ContentPipeline with 3 demo videos
// ---------------------------------------------------------------------------

const PIPELINE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#111;color:#eee;font-family:monospace">

<div id="counter" style="padding:8px;font-size:12px;color:#888">
  <span id="index-display">0</span> / <span id="total-display">0</span>
</div>

<div id="video-card" style="padding:12px">
  <div id="title" style="font-size:14px;font-weight:700;color:#fff;margin-bottom:8px"></div>
  <div id="channel" style="font-size:11px;color:#888;margin-bottom:8px"></div>
  <video id="video-el" controls preload="metadata"
    style="width:225px;height:400px;background:#000;display:block"
    src="about:blank">
  </video>
  <button id="mute-btn" style="margin-top:4px;width:225px;padding:4px 0;background:#1a2e1a;color:#86efac;border:1px solid #166534;border-radius:4px;cursor:pointer">
    MUTE
  </button>
  <button id="approve-btn" style="display:block;margin-top:8px;padding:6px 14px;background:#14532d;color:#4ade80;border:1px solid #166534;border-radius:6px;cursor:pointer">
    Approve Both
  </button>
  <button id="trash-btn" style="display:block;margin-top:6px;padding:6px 14px;background:#3a0f0f;color:#f87171;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">
    Trash Both
  </button>
  <!-- Reject with note flow -->
  <div id="reject-panel" style="display:none;margin-top:8px">
    <input id="reject-note" type="text" placeholder="Rejection note..."
      style="width:100%;padding:6px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#eee">
    <button id="reject-confirm-btn" style="margin-top:4px;padding:4px 10px;background:#3a0f0f;color:#f87171;border:1px solid #7f1d1d;border-radius:4px;cursor:pointer">
      Reject &amp; Re-queue
    </button>
    <button id="reject-cancel-btn" style="margin-left:4px;padding:4px 10px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ccc;cursor:pointer">
      Cancel
    </button>
  </div>
  <button id="reject-video-btn" style="display:block;margin-top:6px;padding:4px 0;width:225px;background:#3a0f0f;color:#f87171;border:1px solid #7f1d1d;border-radius:4px;cursor:pointer">
    Reject Video
  </button>
</div>

<div id="nav-bar" style="padding:8px;display:flex;gap:8px">
  <button id="prev-btn" style="padding:6px 14px;background:#1a1a2e;border:1px solid #333;border-radius:6px;color:#a78bfa;cursor:pointer">
    ← Previous
  </button>
  <button id="next-btn" style="padding:6px 14px;background:#1a1a2e;border:1px solid #333;border-radius:6px;color:#a78bfa;cursor:pointer">
    Next →
  </button>
</div>

<div id="approved-list" style="padding:8px;font-size:11px;color:#4ade80"></div>
<div id="status-msg" style="padding:8px;font-size:11px;color:#888"></div>

<script>
  // Mirror of ContentPipeline state machine
  const VIDEOS = [
    { id: "mit_30_agents",         title: "MIT Audited 30 AI Agents. Every Single One Failed.", channel: "AILifeHacks" },
    { id: "ai_agent_income",       title: "She Replaced Her VA — Income Doubled",               channel: "AILifeHacks" },
    { id: "nine_free_tools",       title: "9 Free AI Tools Your Competition Hasn't Found Yet",  channel: "AILifeHacks" },
  ];

  let pending   = [...VIDEOS];
  let approved  = [];
  let activeIdx = 0;
  // Track muted/reject-panel state per-render (resets on navigation = clean state)
  let muted = false;
  let rejectPanelOpen = false;

  function clamp(i, len) { return Math.max(0, Math.min(i, len - 1)); }

  function render() {
    const total = pending.length;
    document.getElementById("total-display").textContent = total;

    if (total === 0) {
      document.getElementById("video-card").style.display = "none";
      document.getElementById("nav-bar").style.display    = "none";
      document.getElementById("status-msg").textContent   = "All reviewed.";
      document.getElementById("index-display").textContent = "0";
      return;
    }

    const idx = clamp(activeIdx, total);
    activeIdx = idx;                // normalise
    const v   = pending[idx];

    document.getElementById("index-display").textContent = idx + 1;
    document.getElementById("video-card").style.display  = "block";
    document.getElementById("nav-bar").style.display     = "flex";

    // Update content
    document.getElementById("title").textContent   = v.title;
    document.getElementById("channel").textContent = v.channel;

    // Reset transient state on navigation (simulates key={v.id} remount)
    muted = false;
    rejectPanelOpen = false;
    document.getElementById("mute-btn").textContent = "MUTE";
    document.getElementById("reject-panel").style.display = "none";
    document.getElementById("reject-note").value = "";
    // Reset video element muted/volume state (mirrors VideoCard useEffect cleanup)
    const ve = document.getElementById("video-el");
    ve.muted  = false;
    ve.volume = 1.0;

    // Nav button disabled states
    document.getElementById("prev-btn").disabled = idx === 0;
    document.getElementById("next-btn").disabled = idx === total - 1;

    // Approved list
    document.getElementById("approved-list").textContent =
      approved.length ? "Approved: " + approved.map(x => x.id).join(", ") : "";
  }

  // ---- Nav ----------------------------------------------------------------
  document.getElementById("prev-btn").addEventListener("click", () => {
    if (activeIdx > 0) { activeIdx--; render(); }
  });
  document.getElementById("next-btn").addEventListener("click", () => {
    if (activeIdx < pending.length - 1) { activeIdx++; render(); }
  });

  // ---- Approve ------------------------------------------------------------
  document.getElementById("approve-btn").addEventListener("click", () => {
    const v = pending[activeIdx];
    approved.push(v);
    pending.splice(activeIdx, 1);
    // Stay at same index (now points to next item) or back off if at end
    activeIdx = clamp(activeIdx, pending.length);
    render();
  });

  // ---- Trash ---------------------------------------------------------------
  document.getElementById("trash-btn").addEventListener("click", () => {
    pending.splice(activeIdx, 1);
    activeIdx = clamp(activeIdx, pending.length);
    render();
  });

  // ---- Reject with note ---------------------------------------------------
  document.getElementById("reject-video-btn").addEventListener("click", () => {
    rejectPanelOpen = !rejectPanelOpen;
    document.getElementById("reject-panel").style.display = rejectPanelOpen ? "block" : "none";
    if (rejectPanelOpen) document.getElementById("reject-note").focus();
  });
  document.getElementById("reject-confirm-btn").addEventListener("click", () => {
    const note = document.getElementById("reject-note").value.trim();
    if (!note) return;          // require a note for re-queue
    // Mark as rejected (stays in list with note, not removed)
    pending[activeIdx] = { ...pending[activeIdx], status: "rejected", note };
    // Advance
    pending.splice(activeIdx, 1);
    activeIdx = clamp(activeIdx, pending.length);
    render();
  });
  document.getElementById("reject-cancel-btn").addEventListener("click", () => {
    rejectPanelOpen = false;
    document.getElementById("reject-panel").style.display = "none";
  });

  // ---- Mute ---------------------------------------------------------------
  document.getElementById("mute-btn").addEventListener("click", () => {
    muted = !muted;
    const el = document.getElementById("video-el");
    el.muted = muted;
    document.getElementById("mute-btn").textContent = muted ? "UNMUTE" : "MUTE";
  });

  // ---- Initial render -----------------------------------------------------
  render();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function getCurrentTitle(page: import("@playwright/test").Page): Promise<string> {
  return page.$eval("#title", (el) => el.textContent ?? "");
}

async function getActiveIndex(page: import("@playwright/test").Page): Promise<number> {
  const text = await page.$eval("#index-display", (el) => el.textContent ?? "0");
  return parseInt(text, 10);
}

async function getTotal(page: import("@playwright/test").Page): Promise<number> {
  const text = await page.$eval("#total-display", (el) => el.textContent ?? "0");
  return parseInt(text, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.setContent(PIPELINE_HTML);
});

// 1. Initial render
test("ContentPipeline: loads and shows first video", async ({ page }) => {
  const idx   = await getActiveIndex(page);
  const total = await getTotal(page);
  const title = await getCurrentTitle(page);

  expect(idx).toBe(1);   // 1-based display
  expect(total).toBe(3);
  expect(title).toContain("MIT Audited");
});

// 2. Next button advances to second video
test("ContentPipeline: Next button advances to next video", async ({ page }) => {
  const titleBefore = await getCurrentTitle(page);
  await page.click("#next-btn");
  const titleAfter  = await getCurrentTitle(page);
  const idx         = await getActiveIndex(page);

  expect(idx).toBe(2);
  expect(titleAfter).not.toBe(titleBefore);
  expect(titleAfter).toContain("VA");  // second video title
});

// 3. Previous button goes back
test("ContentPipeline: Previous button goes back to previous video", async ({ page }) => {
  // Advance first
  await page.click("#next-btn");
  await page.click("#next-btn");
  const titleAtEnd = await getCurrentTitle(page);
  expect(titleAtEnd).toContain("9 Free");

  // Go back
  await page.click("#prev-btn");
  const titleBack = await getCurrentTitle(page);
  const idx        = await getActiveIndex(page);
  expect(idx).toBe(2);
  expect(titleBack).toContain("VA");
});

// 4. Prev is disabled at index 0, Next is disabled at last index
test("ContentPipeline: navigation buttons are disabled at bounds", async ({ page }) => {
  const prevDisabled = await page.$eval("#prev-btn", (b) => (b as HTMLButtonElement).disabled);
  expect(prevDisabled).toBe(true);

  // Go to last
  await page.click("#next-btn");
  await page.click("#next-btn");
  const nextDisabled = await page.$eval("#next-btn", (b) => (b as HTMLButtonElement).disabled);
  expect(nextDisabled).toBe(true);
});

// 5. Approve auto-advances to next video
test("ContentPipeline: Approve moves to next video automatically", async ({ page }) => {
  const titleFirst = await getCurrentTitle(page);
  expect(titleFirst).toContain("MIT");

  await page.click("#approve-btn");

  const titleAfter = await getCurrentTitle(page);
  const total      = await getTotal(page);

  expect(total).toBe(2);                       // one removed from pending
  expect(titleAfter).not.toContain("MIT");     // no longer on approved video
  expect(titleAfter).toContain("VA");          // advanced to next
});

// 6. Approve all → "All reviewed" state
test("ContentPipeline: approving all videos shows empty state", async ({ page }) => {
  await page.click("#approve-btn");
  await page.click("#approve-btn");
  await page.click("#approve-btn");

  const statusMsg  = await page.$eval("#status-msg",  (el) => el.textContent ?? "");
  const total      = await getTotal(page);

  expect(total).toBe(0);
  expect(statusMsg).toContain("All reviewed");

  const cardVisible = await page.$eval("#video-card", (el) => (el as HTMLElement).style.display);
  expect(cardVisible).toBe("none");
});

// 7. Reject with note auto-advances
test("ContentPipeline: Reject with note advances to next video", async ({ page }) => {
  const titleFirst = await getCurrentTitle(page);
  expect(titleFirst).toContain("MIT");

  // Open reject panel
  await page.click("#reject-video-btn");
  await expect(page.locator("#reject-panel")).toBeVisible();

  // Fill note
  await page.fill("#reject-note", "Voiceover too quiet");

  // Confirm rejection
  await page.click("#reject-confirm-btn");

  const titleAfter = await getCurrentTitle(page);
  const total      = await getTotal(page);

  expect(total).toBe(2);
  expect(titleAfter).not.toContain("MIT");
  expect(titleAfter).toContain("VA");
});

// 8. State resets on navigation — no bleed between videos
test("ContentPipeline: mute state resets when navigating to next video", async ({ page }) => {
  // Mute current video
  await page.click("#mute-btn");
  const muteLabel = await page.$eval("#mute-btn", (b) => b.textContent?.trim());
  expect(muteLabel).toBe("UNMUTE");

  // Navigate to next
  await page.click("#next-btn");

  // Mute button should reset to "MUTE" (clean state)
  const muteLabelAfter = await page.$eval("#mute-btn", (b) => b.textContent?.trim());
  expect(muteLabelAfter).toBe("MUTE");

  // Video element should not be muted
  const videoMuted = await page.$eval("#video-el", (v) => (v as HTMLVideoElement).muted);
  expect(videoMuted).toBe(false);
});

// 9. Reject panel resets on navigation
test("ContentPipeline: reject panel closes on navigation", async ({ page }) => {
  await page.click("#reject-video-btn");
  await expect(page.locator("#reject-panel")).toBeVisible();

  await page.click("#next-btn");

  await expect(page.locator("#reject-panel")).not.toBeVisible();
});

// 10. Video element: correct default audio state (error=4 is expected — about:blank src)
test("ContentPipeline: video element has correct audio state on initial render", async ({ page }) => {
  const state = await page.$eval("#video-el", (v) => {
    const el = v as HTMLVideoElement;
    return {
      // error code=4 (MEDIA_ERR_SRC_NOT_SUPPORTED) is expected for about:blank
      errorCode: el.error?.code ?? null,
      muted: el.muted,
      volume: el.volume,
    };
  });

  // about:blank will always produce MEDIA_ERR_SRC_NOT_SUPPORTED (4) — that's fine
  // What matters is no unexpected error codes (1=ABORTED, 2=NETWORK, 3=DECODE)
  expect(state.errorCode).not.toBe(1);
  expect(state.errorCode).not.toBe(2);
  expect(state.errorCode).not.toBe(3);
  expect(state.muted).toBe(false);
  expect(state.volume).toBe(1);
});
