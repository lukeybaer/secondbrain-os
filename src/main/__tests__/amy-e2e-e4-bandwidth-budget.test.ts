import { describe, it, expect } from 'vitest';
import { formatLabel, planPRIVATE_NAMEeraFormats } from '../studio-policy';

function cams(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: 'PRIVATE_NAME ' + (i + 1),
    position: ['front', 'side', 'overhead', 'extra'][i] || 'extra',
  }));
}

describe('E4-K2 camera bandwidth budget', () => {
  it('keeps one or two cameras on the proven raw-default-first path', () => {
    const plans = planPRIVATE_NAMEeraFormats(cams(2));
    expect(plans[0].formats.map(formatLabel)).toEqual([
      'default',
      'mjpeg:1280x720',
      'mjpeg:640x480',
    ]);
    expect(plans[1].formats.map(formatLabel)).toEqual([
      'default',
      'mjpeg:1280x720',
      'mjpeg:640x480',
    ]);
  });

  it('forces cameras three and beyond to lighter MJPEG formats with no raw default', () => {
    const plans = planPRIVATE_NAMEeraFormats(cams(4));
    expect(plans[2].formats.map(formatLabel)).toEqual(['mjpeg:1280x720', 'mjpeg:640x480']);
    expect(plans[3].formats.map(formatLabel)).toEqual(['mjpeg:1280x720', 'mjpeg:640x480']);
    expect(plans[2].formats.map(formatLabel)).not.toContain('default');
    expect(plans[3].formats.map(formatLabel)).not.toContain('default');
  });
});
