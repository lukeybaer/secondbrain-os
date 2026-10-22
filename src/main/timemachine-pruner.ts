// timemachine-pruner.ts
// Auto-cleanup for Time Machine data. Deletes old local files,
// keeps SQLite text data forever. S3 lifecycle handles cloud archival.

import * as fs from 'fs';
import { loadTimeMachineConfig } from './timemachine';
import {
  getExpiredFramePaths,
  nullifyFrameFiles,
  getExpiredAudioPaths,
  nullifyAudioFiles,
} from './timemachine-db';

export async function pruneTimeMachineData(): Promise<{
  deletedScreenshots: number;
  deletedAudio: number;
}> {
  const config = loadTimeMachineConfig();
  let deletedScreenshots = 0;
  let deletedAudio = 0;

  // Prune screenshots older than retention period
  const screenshotCutoff = new Date();
  screenshotCutoff.setDate(screenshotCutoff.getDate() - config.retentionScreenshotDays);
  const cutoffStr = screenshotCutoff.toISOString();

  const expiredFrames = getExpiredFramePaths(cutoffStr);
  const frameIds: number[] = [];

  for (const frame of expiredFrames) {
    try {
      if (fs.existsSync(frame.local_path)) {
        fs.unlinkSync(frame.local_path);
        deletedScreenshots++;
      }
      frameIds.push(frame.id);
    } catch {
      /* ignore individual failures */
    }
  }

  if (frameIds.length > 0) {
    nullifyFrameFiles(frameIds);
  }

  // Prune audio older than retention period
  const audioCutoff = new Date();
  audioCutoff.setDate(audioCutoff.getDate() - config.retentionAudioDays);
  const audioCutoffStr = audioCutoff.toISOString();

  const expiredAudio = getExpiredAudioPaths(audioCutoffStr);
  const audioIds: number[] = [];

  for (const audio of expiredAudio) {
    try {
      if (fs.existsSync(audio.local_path)) {
        fs.unlinkSync(audio.local_path);
        deletedAudio++;
      }
      audioIds.push(audio.id);
    } catch {
      /* ignore */
    }
  }

  if (audioIds.length > 0) {
    nullifyAudioFiles(audioIds);
  }

  console.log(
    `[timemachine] pruned ${deletedScreenshots} screenshots, ${deletedAudio} audio files`,
  );
  return { deletedScreenshots, deletedAudio };
}
