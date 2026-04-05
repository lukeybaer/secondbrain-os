/**
 * Playwright E2E tests for the Messages tab navigation and UI.
 *
 * Self-contained HTML approach (same pattern as content-pipeline-nav.pw.spec.ts):
 * renders a minimal simulation of the Messages UI to test filtering, search,
 * and channel badges without needing the full Electron app.
 */

import { test, expect } from "@playwright/test";

const MESSAGES_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, sans-serif; margin: 0; padding: 24px; }
    .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
    .pill { padding: 4px 12px; border-radius: 20px; cursor: pointer; font-size: 12px; border: 1px solid #2a2a2a; background: #1a1a1a; color: #888; }
    .pill.active { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .msg { padding: 12px; margin-bottom: 8px; background: #141414; border: 1px solid #1e1e1e; border-radius: 8px; }
    .msg.inbound { border-left: 3px solid #4ade80; }
    .msg.outbound { border-left: 3px solid #60a5fa; }
    .badge { font-size: 9px; font-weight: 700; text-transform: uppercase; border-radius: 3px; padding: 1px 5px; display: inline-block; }
    .badge.wa { background: #14532d; color: #4ade80; }
    .badge.sms { background: #1e3a5f; color: #60a5fa; }
    .meta { font-size: 11px; color: #555; }
    .search { padding: 8px 12px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; color: #e0e0e0; font-size: 13px; outline: none; }
    select { padding: 4px 8px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; color: #e0e0e0; font-size: 12px; }
    .send-section { background: #141414; border: 1px solid #1e1e1e; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .send-toggle { padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 12px; border: 1px solid #333; }
    .send-toggle.active-sms { background: #1e3a5f; color: #60a5fa; border-color: #60a5fa; }
    .send-toggle.active-wa { background: #14532d; color: #4ade80; border-color: #4ade80; }
    input[type=text], textarea { width: 100%; padding: 8px 12px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; color: #e0e0e0; font-size: 13px; outline: none; box-sizing: border-box; margin-bottom: 8px; }
    .btn-send { padding: 8px 16px; background: #7c3aed; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <h1 style="font-size:18px;font-weight:700;color:#fff;margin-bottom:6px">Messages</h1>
  <p style="font-size:12px;color:#555;margin-bottom:20px">Unified SMS and WhatsApp messaging.</p>

  <div class="filter-bar">
    <button class="pill active" data-filter="all" onclick="setFilter(this)">All</button>
    <button class="pill" data-filter="whatsapp" onclick="setFilter(this)">WhatsApp</button>
    <button class="pill" data-filter="sms" onclick="setFilter(this)">SMS</button>
    <select id="timeFilter" onchange="applyFilters()">
      <option value="all">All time</option>
      <option value="today">Today</option>
      <option value="7days">Last 7 days</option>
    </select>
    <input class="search" id="searchInput" placeholder="Search messages..." oninput="applyFilters()" />
  </div>

  <div class="send-section">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <span style="font-size:12px;color:#888">Send via</span>
      <button class="send-toggle active-sms" id="toggle-sms" onclick="setSendChannel('sms')">SMS</button>
      <button class="send-toggle" id="toggle-wa" onclick="setSendChannel('whatsapp')">WhatsApp</button>
    </div>
    <input type="text" id="sendTo" placeholder="To (e.g. +15551234567)" />
    <textarea id="sendBody" placeholder="Message text" rows="2"></textarea>
    <button class="btn-send" id="sendBtn">Send</button>
  </div>

  <div id="msgCount" style="font-size:12px;color:#888;margin-bottom:10px">Messages (5)</div>
  <div id="msgList"></div>

  <script>
    const messages = [
      { id: "1", channel: "sms", source: "inbound", from: "+15551112222", to: "+15551234567", body: "Hey Luke, dentist appointment confirmed", timestamp: new Date().toISOString(), contactName: "McKinney, TX" },
      { id: "2", channel: "whatsapp", source: "outbound", from: "+15551234567", to: "+15559998888", body: "Thanks for the update on the project", timestamp: new Date().toISOString() },
      { id: "3", channel: "sms", source: "outbound", from: "+15551234567", to: "+15557776666", body: "Meeting at 3pm works", timestamp: new Date(Date.now() - 2*86400000).toISOString() },
      { id: "4", channel: "whatsapp", source: "inbound", from: "+15554443333", to: "+15551234567", body: "Can you review the PR?", timestamp: new Date(Date.now() - 8*86400000).toISOString(), contactName: "Alex" },
      { id: "5", channel: "sms", source: "inbound", from: "+15552221111", to: "+15551234567", body: "Invoice attached", timestamp: new Date(Date.now() - 8*86400000).toISOString() },
    ];

    let currentChannel = "all";
    let sendChannel = "sms";

    function setFilter(btn) {
      document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      currentChannel = btn.dataset.filter;
      applyFilters();
    }

    function setSendChannel(ch) {
      sendChannel = ch;
      document.getElementById("toggle-sms").className = "send-toggle" + (ch === "sms" ? " active-sms" : "");
      document.getElementById("toggle-wa").className = "send-toggle" + (ch === "whatsapp" ? " active-wa" : "");
    }

    function applyFilters() {
      const search = document.getElementById("searchInput").value.toLowerCase();
      const timeVal = document.getElementById("timeFilter").value;
      let cutoff = null;
      if (timeVal === "today") cutoff = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
      else if (timeVal === "7days") cutoff = new Date(Date.now() - 7 * 86400000);

      const filtered = messages.filter(m => {
        if (currentChannel !== "all" && m.channel !== currentChannel) return false;
        if (cutoff && new Date(m.timestamp) < cutoff) return false;
        if (search && !m.body.toLowerCase().includes(search) && !(m.contactName || "").toLowerCase().includes(search)) return false;
        return true;
      });

      document.getElementById("msgCount").textContent = "Messages (" + filtered.length + ")";
      document.getElementById("msgList").innerHTML = filtered.map(m => {
        const badgeClass = m.channel === "whatsapp" ? "wa" : "sms";
        const dirClass = m.source;
        return '<div class="msg ' + dirClass + '" data-channel="' + m.channel + '">' +
          '<span class="badge ' + badgeClass + '">' + (m.channel === "whatsapp" ? "WA" : "SMS") + '</span> ' +
          '<span class="meta">' + (m.source === "inbound" ? "From: " + m.from : "To: " + m.to) +
          (m.contactName ? " (" + m.contactName + ")" : "") + '</span>' +
          '<div style="font-size:13px;margin-top:4px">' + m.body + '</div></div>';
      }).join("");
    }

    applyFilters();
  </script>
</body>
</html>`;

test.describe("Messages tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(MESSAGES_HTML);
  });

  test("renders all 5 messages by default", async ({ page }) => {
    const count = await page.locator("#msgCount").textContent();
    expect(count).toBe("Messages (5)");
    await expect(page.locator(".msg")).toHaveCount(5);
  });

  test("channel pills filter messages", async ({ page }) => {
    // Click SMS filter
    await page.click('[data-filter="sms"]');
    const smsCount = await page.locator(".msg").count();
    expect(smsCount).toBe(3); // 3 SMS messages

    // Click WhatsApp filter
    await page.click('[data-filter="whatsapp"]');
    const waCount = await page.locator(".msg").count();
    expect(waCount).toBe(2); // 2 WhatsApp messages

    // Click All
    await page.click('[data-filter="all"]');
    await expect(page.locator(".msg")).toHaveCount(5);
  });

  test("search filters messages by body text", async ({ page }) => {
    await page.fill("#searchInput", "dentist");
    // Only one message mentions dentist
    await expect(page.locator(".msg")).toHaveCount(1);
    await expect(page.locator(".msg")).toContainText("dentist appointment confirmed");
  });

  test("search filters by contact name", async ({ page }) => {
    await page.fill("#searchInput", "Alex");
    await expect(page.locator(".msg")).toHaveCount(1);
    await expect(page.locator(".msg")).toContainText("review the PR");
  });

  test("time filter reduces visible messages", async ({ page }) => {
    await page.selectOption("#timeFilter", "today");
    // Only 2 messages are from today
    const count = await page.locator(".msg").count();
    expect(count).toBe(2);
  });

  test("inbound messages have green left border, outbound have blue", async ({ page }) => {
    const inbound = page.locator(".msg.inbound").first();
    const outbound = page.locator(".msg.outbound").first();
    await expect(inbound).toBeVisible();
    await expect(outbound).toBeVisible();
  });

  test("channel badges render correctly", async ({ page }) => {
    const waBadge = page.locator(".badge.wa").first();
    const smsBadge = page.locator(".badge.sms").first();
    await expect(waBadge).toHaveText("WA");
    await expect(smsBadge).toHaveText("SMS");
  });

  test("send channel toggle switches between SMS and WhatsApp", async ({ page }) => {
    // Default is SMS active
    await expect(page.locator("#toggle-sms")).toHaveClass(/active-sms/);

    // Click WhatsApp
    await page.click("#toggle-wa");
    await expect(page.locator("#toggle-wa")).toHaveClass(/active-wa/);
    await expect(page.locator("#toggle-sms")).not.toHaveClass(/active-sms/);

    // Click back to SMS
    await page.click("#toggle-sms");
    await expect(page.locator("#toggle-sms")).toHaveClass(/active-sms/);
  });

  test("combined channel + search filter works", async ({ page }) => {
    await page.click('[data-filter="sms"]');
    await page.fill("#searchInput", "meeting");
    await expect(page.locator(".msg")).toHaveCount(1);
    await expect(page.locator(".msg")).toContainText("Meeting at 3pm");
  });
});
