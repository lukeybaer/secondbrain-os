#!/usr/bin/env node
/**
 * 2026-05-25 probe: confirm Playwright + Chromium on EC2 can play a
 * YouTube embed AND capture the audio track. This is the riskiest
 * ExampleCo in the headless-record pivot. If audio is silent, we need a
 * different audio capture path (xvfb + pulseaudio, or CDP screencast +
 * separate audio extraction).
 *
 * Run: node scripts/lib/youtube-clip-record-probe.js
 * Output: /tmp/youtube-record-probe.{webm,mp4}
 * Success criteria: ffprobe reports both video AND audio streams,
 * audio_stream.duration > 8s, audio is not constant silence.
 */
'use strict';

const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIDEO_ID = process.argv[2] || 'jNQXAC9IVRw'; // "Me at the zoo" (19s, oldest YT video)
const CLIP_SEC = Number(process.argv[3] || 12); // record 12s
const OUT_DIR = process.argv[4] || path.join(os.tmpdir(), 'yt-record-probe-' + Date.now());

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('[probe] launching chromium (new headless w/ stealth), out=' + OUT_DIR);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
  });
  // Load cookies if present (auth helps YouTube trust the session, may
  // matter for the data-feed even if we exported them earlier).
  const cookiesPath = '/opt/secondbrain/.yt-dlp-cookies.txt';
  try {
    const raw = fs.readFileSync(cookiesPath, 'utf8');
    const cookies = raw.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const parts = l.split('\t');
      if (parts.length < 7) return null;
      return {
        domain: parts[0],
        path: parts[2],
        secure: parts[3] === 'TRUE',
        expires: Number(parts[4]) || -1,
        name: parts[5],
        value: parts[6],
      };
    }).filter(Boolean);
    await context.addCookies(cookies);
    console.log('[probe] loaded ' + cookies.length + ' cookies');
  } catch (e) {
    console.log('[probe] no cookies loaded: ' + e.message);
  }
  // Stealth: hide navigator.webdriver and a couple of headless tells YouTube
  // fingerprints. Without these, YouTube's player refuses to set video.src.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake plugins array length (real browsers have >= 3)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Hide chrome.runtime presence checks (some sites probe for it)
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  // Watch URL (first-party). Embed URLs have cross-origin restrictions
  // that prevent reliable autoplay in headless. Watch URL is what real
  // viewers hit and lets us script video.play() directly.
  const url = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
  console.log('[probe] navigating to ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Diagnostic screenshot.
  try { await page.screenshot({ path: path.join(OUT_DIR, 'after_load.png'), fullPage: false }); } catch {}
  // Wait for the <video> element to be in the DOM.
  await page.waitForSelector('video', { timeout: 30000 });
  // Force-play via the DOM video element. autoplay-policy=no-user-gesture
  // -required + .play() bypasses YouTube's autoplay gate.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = false; v.play().catch(() => {}); }
  });
  console.log('[probe] forced video.play(); waiting for playing state...');
  // Wait for actual playback (currentTime advancing).
  try {
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 3 && !v.paused && v.currentTime > 0.5;
    }, { timeout: 25000 });
  } catch (e) {
    // Diagnostic: dump video element state + page title + URL on failure.
    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        title: document.title,
        url: location.href,
        videoExists: !!v,
        readyState: v && v.readyState,
        paused: v && v.paused,
        currentTime: v && v.currentTime,
        duration: v && v.duration,
        muted: v && v.muted,
        error: v && v.error && { code: v.error.code, message: v.error.message },
        src: v && v.src ? v.src.slice(0, 200) : null,
        srcType: v && v.src ? (v.src.startsWith('blob:') ? 'blob' : 'url') : null,
        ytErrorMsg: document.querySelector('.ytp-error')?.textContent?.slice(0, 200) || null,
      };
    });
    try { await page.screenshot({ path: path.join(OUT_DIR, 'play_timeout.png'), fullPage: false }); } catch {}
    console.error('[probe] play timeout. state:', JSON.stringify(state, null, 2));
    throw e;
  }
  console.log('[probe] video playing; recording ' + CLIP_SEC + 's');
  await page.waitForTimeout(CLIP_SEC * 1000);
  await page.close();
  await context.close();
  await browser.close();
  // Playwright saves <random-id>.webm in OUT_DIR. Find it.
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
  if (!files.length) { console.error('[probe] FAIL: no .webm produced'); process.exit(1); }
  const webm = path.join(OUT_DIR, files[0]);
  console.log('[probe] recorded ' + webm + ' (' + fs.statSync(webm).size + ' bytes)');
  // ffprobe to confirm streams.
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', webm,
  ], { encoding: 'utf8' }));
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  console.log('[probe] streams: video=' + (video ? video.codec_name : 'NONE') + ', audio=' + (audio ? audio.codec_name : 'NONE'));
  if (!video) { console.error('[probe] FAIL: no video stream'); process.exit(2); }
  if (!audio) { console.error('[probe] FAIL: no audio stream'); process.exit(3); }
  // Audio loudness check: silent audio means recording captured a track but no sound.
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  execFileSync('ffmpeg', ['-y', '-i', webm, '-c:v', 'libx264', '-c:a', 'aac', mp4], { stdio: 'inherit' });
  const loudness = spawnSync('ffmpeg', [
    '-i', mp4, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const lm = (loudness.stderr || '').match(/I:\s+(-?[\d.]+)\s+LUFS/);
  const lufs = lm ? Number(lm[1]) : NaN;
  console.log('[probe] integrated loudness: ' + (Number.isFinite(lufs) ? lufs + ' LUFS' : 'unmeasurable'));
  // Silent audio is around -70 LUFS or below; real speech/music typically -23 to -14.
  if (!Number.isFinite(lufs) || lufs < -55) {
    console.error('[probe] FAIL: audio track present but appears silent (' + lufs + ' LUFS).');
    console.error('[probe]   Headless Chromium audio likely not wired. Need PulseAudio sink or xvfb-run.');
    process.exit(4);
  }
  console.log('[probe] PASS: video+audio recorded, audio is real (loudness ' + lufs + ' LUFS).');
  console.log('[probe] artifacts: ' + webm + ', ' + mp4);
}

main().catch((e) => { console.error('[probe] FAIL:', e.message); process.exit(1); });
