/**
 * Playwright e2e tests for the Tasks tab (the Task Spine UI).
 *
 * Strategy: page.setContent() with a self-contained JS sim of the Tasks tab
 * render logic, mirroring src/renderer/src/pages/Tasks.tsx (STATUS_ORDER
 * grouping, dispatch, cancel). No React/Electron required.
 */

import { test, expect } from '@playwright/test';

const TASKS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#0f0f0f;color:#e0e0e0;font-family:monospace">

<input id="composer" data-testid="task-composer" placeholder="Dispatch a task" />
<button id="run" data-testid="task-run">Run</button>
<div id="list"></div>

<script>
  // Mirrors Tasks.tsx: STATUS_ORDER puts live work first, finished work last.
  var STATUS_ORDER = ['running','queued','awaiting-review','failed','done','cancelled'];
  var tasks = [];
  var idSeq = 0;

  function render() {
    var list = document.getElementById('list');
    list.innerHTML = '';
    if (tasks.length === 0) {
      var empty = document.createElement('div');
      empty.id = 'empty';
      empty.textContent = 'No tasks yet.';
      list.appendChild(empty);
      return;
    }
    STATUS_ORDER.forEach(function (status) {
      var items = tasks.filter(function (t) { return t.status === status; });
      if (items.length === 0) return;
      var group = document.createElement('div');
      group.className = 'group';
      group.setAttribute('data-group', status);
      var header = document.createElement('div');
      header.className = 'group-header';
      header.textContent = status + ' (' + items.length + ')';
      group.appendChild(header);
      items.forEach(function (t) {
        var card = document.createElement('div');
        card.className = 'task-card';
        card.setAttribute('data-testid', 'task-card');
        card.setAttribute('data-status', t.status);
        card.setAttribute('data-id', t.id);
        card.textContent = t.title;
        var cancel = document.createElement('button');
        cancel.className = 'cancel';
        cancel.textContent = 'Cancel';
        cancel.onclick = function () {
          t.status = 'cancelled';
          render();
        };
        if (t.status === 'running' || t.status === 'queued') card.appendChild(cancel);
        group.appendChild(card);
      });
      list.appendChild(group);
    });
  }

  function dispatch() {
    var input = document.getElementById('composer');
    var text = input.value.trim();
    if (!text) return;
    tasks.unshift({ id: 't' + (++idSeq), title: text, status: 'running' });
    input.value = '';
    render();
  }

  document.getElementById('run').onclick = dispatch;
  render();
</script>
</body>
</html>`;

test.beforeEach(async ({ page }) => {
  await page.setContent(TASKS_HTML);
});

test('shows an empty state when there are no tasks', async ({ page }) => {
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('[data-testid="task-card"]')).toHaveCount(0);
});

test('dispatching a task adds a running card', async ({ page }) => {
  await page.fill('[data-testid="task-composer"]', 'add a healthz endpoint');
  await page.click('[data-testid="task-run"]');
  const card = page.locator('[data-testid="task-card"]');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card).toContainText('add a healthz endpoint');
});

test('groups live work above finished work', async ({ page }) => {
  await page.fill('[data-testid="task-composer"]', 'first task');
  await page.click('[data-testid="task-run"]');
  await page.fill('[data-testid="task-composer"]', 'second task');
  await page.click('[data-testid="task-run"]');
  // Cancel the first card; it should drop into the Cancelled group.
  await page.locator('[data-testid="task-card"][data-status="running"]').first().locator('.cancel').click();
  const groups = page.locator('.group');
  await expect(groups.first()).toHaveAttribute('data-group', 'running');
  await expect(groups.last()).toHaveAttribute('data-group', 'cancelled');
});

test('cancel moves a running task to cancelled', async ({ page }) => {
  await page.fill('[data-testid="task-composer"]', 'cancel me');
  await page.click('[data-testid="task-run"]');
  await page.locator('[data-testid="task-card"] .cancel').click();
  await expect(page.locator('[data-testid="task-card"]')).toHaveAttribute('data-status', 'cancelled');
});
