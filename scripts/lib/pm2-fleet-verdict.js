'use strict';
function evaluatePm2FleetHealth({ procs, guardHeartbeat, recentIncidents, now } = {}) {
  const t = Number(now) || Date.now();
  if (!Array.isArray(procs)) {
    return { glyph: 'unknown', text: 'pm2 not available on this host.' };
  }
  if (!procs.length) {
    return { glyph: 'unknown', text: 'pm2 returned no processes on this host.' };
  }

  const stateOf = (p) => (p && p.pm2_env && p.pm2_env.status) || '';
  const uptimeMsOf = (p) => {
    const up = p && p.pm2_env && Number(p.pm2_env.pm_uptime);
    return Number.isFinite(up) && up > 0 ? t - up : 0;
  };
  const unstableOf = (p) => {
    const u = p && p.pm2_env && Number(p.pm2_env.unstable_restarts);
    return Number.isFinite(u) ? u : 0;
  };
  const nameOf = (p) => (p && p.name) || '';

  const down = procs.filter((p) => stateOf(p) !== 'online');
  // Actively unstable NOW: online but PM2 is still counting fast restarts
  // (unstable_restarts > 0). PM2 increments unstable_restarts on a restart faster
  // than min_uptime and RESETS it to 0 once the process settles, so it is the
  // live crash-loop signal by itself. A low uptime with unstable_restarts=0 is a
  // clean recent start (a deploy restart, a manual pm2 restart), NOT instability
  // -- flagging it would make every deploy paint the fleet non-green for the
  // whole stability window and block card publishes (ExampleCo 2026-07-07). The
  // uptime floor only sharpens the case of a process that is BOTH churning
  // (unstable_restarts > 0) AND still too young to have settled; it never
  // independently makes a clean-but-young process non-green. Lifetime
  // restart_time is not consulted at all.
  const unstable = procs.filter((p) => stateOf(p) === 'online' && unstableOf(p) > 0);
  const liveByName = new Map(procs.map((p) => [nameOf(p), p]));

  // Scope storm incidents to processes that are still present AND still unstable.
  const incidentStrings = (recentIncidents || []).flatMap((e) =>
    Array.isArray(e.incidents) ? e.incidents : [],
  );
  const incidentProcName = (s) => {
    let m = /^STOPPED ([^:]+):/.exec(s);
    if (m) return m[1].trim();
    m = /^STOP FAILED ([^:]+):/.exec(s);
    if (m) return m[1].trim();
    m = /^PROTECTED (.+?) is storming/.exec(s);
    if (m) return m[1].trim();
    m = /^WATCH ENABLED on ([^:]+):/.exec(s);
    if (m) return m[1].trim();
    return '';
  };
  const activeIncidents = incidentStrings.filter((s) => {
    const name = incidentProcName(s);
    if (!name) return false;
    const live = liveByName.get(name);
    if (!live) return false; // process no longer in the fleet -> stale history
    // WATCH ENABLED is a live misconfig as long as the process still runs with
    // file-watch on; the others are live only while the process is unstable now.
    if (/^WATCH ENABLED/.test(s)) return true;
    return stateOf(live) !== 'online' || unstableOf(live) > 0;
  });

  const bad =
    down.length > 0 ||
    unstable.length > 0 ||
    activeIncidents.length > 0 ||
    (guardHeartbeat && guardHeartbeat.ok === false);

  const online = procs.length - down.length;
  if (bad) {
    const bits = [];
    if (down.length) bits.push(`down: ${down.map(nameOf).join(', ')}`);
    if (unstable.length) {
      bits.push(
        `unstable now: ${unstable
          .map(
            (p) =>
              `${nameOf(p)} (${unstableOf(p)} unstable restart(s), up ${Math.round(uptimeMsOf(p) / 60000)}m)`,
          )
          .join(', ')}`,
      );
    }
    if (activeIncidents.length) {
      bits.push(`${activeIncidents.length} active storm incident(s) in 24h`);
    }
    const note = (guardHeartbeat && guardHeartbeat.note) || '';
    return {
      glyph: 'bad',
      text: `${online}/${procs.length} online${bits.length ? `; ${bits.join('; ')}` : ''}.${note}`,
    };
  }

  // Green: everything online and stable now. Mention any stale (non-active) halt
  // so the row stays honest without being blocked by history.
  const staleHalts = incidentStrings.filter((s) => /^STOPPED /.test(s)).length;
  const staleNote = staleHalts
    ? ` Storm guard: ${staleHalts} halt(s) in 24h, all since recovered (no live impact).`
    : ' Storm guard: no incidents in 24h.';
  return {
    glyph: 'ok',
    text: `${procs.length}/${procs.length} services online.${staleNote}`,
  };
}

module.exports = { evaluatePm2FleetHealth };
