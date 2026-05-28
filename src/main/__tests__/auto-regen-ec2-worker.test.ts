import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..', '..');

describe('EC2 auto-regen worker contract', () => {
  const regen = fs.readFileSync(path.join(REPO, 'scripts', 'auto-regen-rejected-videos.js'), 'utf8');
  const installer = fs.readFileSync(path.join(REPO, 'scripts', 'install-ec2-auto-regen-cron.sh'), 'utf8');

  it('auto-regen can run directly on /opt/secondbrain without SSHing to itself', () => {
    expect(regen).toContain('isEc2LocalRuntime');
    expect(regen).toContain('regenVideoOnLocalEc2Build');
    expect(regen).toContain("path.resolve(REPO) === '/opt/secondbrain'");
    expect(regen).toContain("cwd: '/opt/secondbrain'");
    expect(regen).toContain("FORCE_REBUILD: '1'");
    expect(regen).toContain("path.join(buildDir, 'final.mp4')");
    expect(regen).toContain('builtCandidates.find');
    expect(regen).toContain('ec2BuildFailureReason');
    expect(regen).toContain('ElevenLabs TTS auth failed');
    expect(regen).not.toContain("v.regen_status = errorCode === 'auth' ? 'hard_blocked' : 'failed'");
    expect(regen).not.toContain("maxRetries: errorCode === 'auth' ? 1 : undefined");
  });

  it('EC2 has an installer for a locked recurring auto-regen cron', () => {
    expect(installer).toContain('auto-regen-rejected-videos.js');
    expect(installer).toContain('*/15 * * * *');
    expect(installer).toContain('flock -n');
    expect(installer).toContain('auto-regen-rejected-videos.log');
  });
});
