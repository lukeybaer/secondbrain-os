import { describe, expect, it } from 'vitest';
import { dateText, noteText, textValue } from '../contentPipelineText';

describe('ContentPipeline rejection text normalization', () => {
  const rejectionObject = {
    id: 'short009_aitakes',
    title: 'The One Skill AI Is Quietly Stealing From You',
    channel: 'AILifeHacksByExampleCoyExampleCo',
    target: 'video',
    note: 'I cannot hear "AI" at the beginning.',
    rejectedAt: '2026-05-07T06:35:05.976Z',
  };

  it('renders rejection payload objects as the human note', () => {
    expect(noteText(rejectionObject)).toBe('I cannot hear "AI" at the beginning.');
  });

  it('keeps primitive notes renderable', () => {
    expect(noteText('Fix the intro audio.')).toBe('Fix the intro audio.');
    expect(textValue(3)).toBe('3');
  });

  it('normalizes dates from payload fields', () => {
    expect(dateText(rejectionObject.rejectedAt)).toBe('2026-05-07');
  });
});
