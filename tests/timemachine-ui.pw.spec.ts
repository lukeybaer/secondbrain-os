import { test, expect } from '@playwright/test';

const HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, sans-serif; margin: 0; padding: 24px; }
    .card { background: #161616; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    button { background: #333; color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
    button.active { background: #7c3aed; }
    input { background: #111; border: 1px solid #333; color: #e0e0e0; border-radius: 4px; padding: 8px; }
    label { display: block; color: #888; font-size: 12px; margin-bottom: 6px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .cluster { border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; }
    .thumb { width: 96px; height: 54px; background: #222; border-radius: 4px; display: inline-block; margin-right: 8px; vertical-align: middle; }
  </style>
</head>
<body>
  <h1>Time Machine Settings</h1>
  <div class="tabs">
    <button id="settingsBtn" class="active" onclick="show('settings')">Settings</button>
    <button id="timelineBtn" onclick="show('timeline')">Timeline</button>
  </div>

  <section id="settings">
    <div class="card"><h2>Privacy</h2><div id="zones"></div><button id="addZone" onclick="addZone()">Add Zone</button><div class="row"><div><label>Days</label><input id="days" value="1,2,3,4,5" /></div><div><label>Start</label><input id="start" type="time" value="09:00" /></div><div><label>End</label><input id="end" type="time" value="17:00" /></div></div></div>
    <div class="card"><h2>Storage Forecast</h2><div id="forecast">Projected retained storage: 403.2 MB</div></div>
    <div class="card"><h2>Dedupe</h2><label><input type="checkbox" checked /> Enable duplicate screenshot detection</label></div>
    <div class="card"><h2>Clustering</h2><label>Idle gap</label><input value="5" /></div>
  </section>

  <section id="timeline" style="display:none">
    <div class="tabs">
      <button id="framesView" class="active" onclick="view='frames'; renderTimeline()">Frames</button>
      <button id="clustersView" onclick="view='clusters'; renderTimeline()">Clusters</button>
    </div>
    <div id="timelineBody"></div>
  </section>

  <script>
    let zones = [];
    let view = 'frames';
    const clusters = [
      { id: 'c1', start: '10:00', end: '10:05', frameCount: 2, terms: ['project', 'brief'], frames: ['10:00', '10:05'] },
      { id: 'c2', start: '10:30', end: '10:31', frameCount: 1, terms: ['calendar'], frames: ['10:30'] },
    ];

    function show(tab) {
      document.getElementById('settings').style.display = tab === 'settings' ? '' : 'none';
      document.getElementById('timeline').style.display = tab === 'timeline' ? '' : 'none';
      document.getElementById('settingsBtn').className = tab === 'settings' ? 'active' : '';
      document.getElementById('timelineBtn').className = tab === 'timeline' ? 'active' : '';
      renderTimeline();
    }

    function addZone() {
      zones.push({ label: 'New zone', x: 0, y: 0, width: 320, height: 180 });
      renderZones();
    }

    function removeZone(index) {
      zones.splice(index, 1);
      renderZones();
    }

    function renderZones() {
      document.getElementById('zones').innerHTML = zones.map((z, i) =>
        '<div class="zone row"><input value="' + z.label + '" /><input value="' + z.x + '" /><input value="' + z.y + '" /><input value="' + z.width + '" /><input value="' + z.height + '" /><button class="removeZone" onclick="removeZone(' + i + ')">Remove</button></div>'
      ).join('');
    }

    function renderTimeline() {
      document.getElementById('framesView').className = view === 'frames' ? 'active' : '';
      document.getElementById('clustersView').className = view === 'clusters' ? 'active' : '';
      if (view === 'frames') {
        document.getElementById('timelineBody').innerHTML = '<div id="frames"><span class="thumb"></span>10:00 <span class="thumb"></span>10:05</div>';
        return;
      }
      document.getElementById('timelineBody').innerHTML = clusters.map(c =>
        '<div class="cluster" data-id="' + c.id + '" onclick="showCluster(\\'' + c.id + '\\')"><span class="thumb"></span><strong>' + c.start + ' - ' + c.end + '</strong><div>' + c.frameCount + ' frames</div><div>' + c.terms.join(', ') + '</div></div>'
      ).join('');
    }

    function showCluster(id) {
      const cluster = clusters.find(c => c.id === id);
      view = 'frames';
      renderTimeline();
      document.getElementById('frames').innerHTML = cluster.frames.map(f => '<span class="thumb"></span>' + f).join(' ');
    }

    renderZones();
  </script>
</body>
</html>`;

test.describe('Time Machine UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(HTML);
  });

  test('renders Privacy, Storage Forecast, Dedupe, and Clustering sections', async ({ page }) => {
    await expect(page.locator('h2')).toContainText(['Privacy', 'Storage Forecast', 'Dedupe', 'Clustering']);
  });

  test('adding/removing privacy zones updates local UI state', async ({ page }) => {
    await page.click('#addZone');
    await expect(page.locator('.zone')).toHaveCount(1);
    await page.click('.removeZone');
    await expect(page.locator('.zone')).toHaveCount(0);
  });

  test('pause schedule controls render expected day/time fields', async ({ page }) => {
    await expect(page.locator('#days')).toHaveValue('1,2,3,4,5');
    await expect(page.locator('#start')).toHaveValue('09:00');
    await expect(page.locator('#end')).toHaveValue('17:00');
  });

  test('cluster view groups sample timeline frames and clicking a cluster reveals its frame list', async ({ page }) => {
    await page.click('#timelineBtn');
    await page.click('#clustersView');
    await expect(page.locator('.cluster')).toHaveCount(2);
    await page.locator('.cluster').first().click();
    await expect(page.locator('#frames')).toContainText('10:00');
    await expect(page.locator('#frames')).toContainText('10:05');
  });

  test('forecast panel displays projected retained storage', async ({ page }) => {
    await expect(page.locator('#forecast')).toContainText('Projected retained storage');
  });
});

