import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression lock for the 2026-05-31 half-open-tunnel incident (a recurrence
// of the 2026-04-11 paid-OpenAI fallback). The Claude Max proxy watchdog used
// to restart the proxy+tunnel ONLY when one of the two processes exited. But a
// reverse SSH tunnel can stay alive as a process while its channel is dead:
// EC2 keeps the :3456 listener bound, yet data never reaches the local proxy,
// so the backend silently falls back to paid OpenAI. That state burned ~2 days
// undetected because nothing actively probed end-to-end reachability.
//
// The category this guards: "supervisor must verify the tunnel is carrying
// TRAFFIC, not merely that the ssh process is alive." We assert the watchdog
// keeps an active backend health probe and force-restarts on a confirmed
// half-open tunnel. Pinning to behavior shape (not a literal log string) keeps
// it from going stale on wording tweaks.
const WATCHDOG = path.join(__dirname, '..', '..', '..', 'scripts', 'claude-proxy-watchdog.ps1');
const VBS_LAUNCHER = path.join(__dirname, '..', '..', '..', 'start-claude-proxy.vbs');

describe('claude-proxy-watchdog half-open tunnel guard', () => {
  const src = fs.readFileSync(WATCHDOG, 'utf8');
  const launcherSrc = fs.readFileSync(VBS_LAUNCHER, 'utf8');

  it('actively probes the backend /health maxPlanProxy field', () => {
    expect(src).toMatch(/Invoke-RestMethod[^\n]*\/health/);
    expect(src).toMatch(/maxPlanProxy/);
  });

  it('treats a backend outage as ExampleCo, not a tunnel restart trigger', () => {
    // The probe must distinguish "tunnel half-open" from "backend itself down"
    // so a backend outage never thrashes a healthy tunnel.
    expect(src).toMatch(/'ExampleCo'|"ExampleCo"/);
  });

  it('kills stale tunnels via a CommandLine-bearing query matching the real forward', () => {
    // Get-Process ssh never populates .CommandLine, so the old matcher silently
    // killed nothing -- stale tunnels (incl. half-open ones) lingered. Cleanup
    // must use Win32_Process and match the actual 127.0.0.1 forward form.
    expect(src).toMatch(/Win32_Process[^\n]*ssh\.exe/);
    expect(src).toMatch(/3456:\(localhost\|127\\\.0\\\.0\\\.1\):3456/);
  });

  it('restarts the pair when the proxy is disconnected while processes are alive', () => {
    // The restart must live inside the watch loop (alongside the process-death
    // path), and clean EC2 forwards so the fresh tunnel binds cleanly.
    expect(src).toMatch(/disconnected/);
    expect(src).toMatch(/Clean-EC2-StaleForwards/);
    // The probe-driven restart must not depend solely on HasExited.
    const watchLoop = src.slice(src.indexOf('Watching.'));
    expect(watchLoop).toMatch(/Test-MaxProxyConnected/);
  });

  it('does not restart the tunnel when the local proxy is auth-degraded', () => {
    // A dead Claude refresh token makes the local proxy return 503 with
    // "claude auth failing". Restarting SSH cannot fix that and only creates
    // a churn loop. The watchdog must distinguish that case from a half-open
    // reverse tunnel.
    expect(src).toMatch(/Test-LocalProxyHealthState/);
    expect(src).toMatch(/127\.0\.0\.1:3456\/health/);
    expect(src).toMatch(/auth-degraded/);

    const disconnectedBranch = src.slice(src.indexOf("$state -eq 'disconnected'"));
    expect(disconnectedBranch).toMatch(/Test-LocalProxyHealthState/);
    expect(disconnectedBranch).toMatch(/auth-degraded/);
    expect(disconnectedBranch).toMatch(/disconnectedStreak\s*=\s*0/);
  });

  it('uses a singleton guard so duplicate watchdog instances do not kill each other', () => {
    expect(src).toMatch(/SecondBrainClaudeProxyWatchdog/);
    expect(src).toMatch(/WaitOne\(0/);
    expect(src).toMatch(/Another watchdog instance is already running/);
  });

  it('keeps the VBS launcher delegated to the watchdog instead of starting a second proxy and tunnel', () => {
    expect(launcherSrc).toMatch(/claude-proxy-watchdog\.ps1/);
    expect(launcherSrc).not.toMatch(/claude-proxy-supervisor\.js/);
    expect(launcherSrc).not.toMatch(/-R 3456:localhost:3456/);
  });
});
