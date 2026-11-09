'use strict';

const { spawnSync } = require('node:child_process');

function curl(args, spawn = spawnSync) {
  const result = spawn('curl', ['-fsS', '--max-time', '5', ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `curl exited ${result.status}`).trim());
  }
  return String(result.stdout || '').trim();
}

// Reads the live EC2 instance type from the IMDSv2 metadata endpoint. Shared
// by scripts/ec2-nightly-resize-health.js (the health classifier) and
// scripts/ec2-resize-drain.js (the prepare-drain no-op fast path) so both
// agree on exactly the same observed value.
function observedInstanceType(spawn = spawnSync) {
  const token = curl(
    [
      '-X',
      'PUT',
      '-H',
      'X-aws-ec2-metadata-token-ttl-seconds: 60',
      'http://169.254.169.254/latest/api/token',
    ],
    spawn,
  );
  return curl(
    [
      '-H',
      `X-aws-ec2-metadata-token: ${token}`,
      'http://169.254.169.254/latest/meta-data/instance-type',
    ],
    spawn,
  );
}

module.exports = { curl, observedInstanceType };
