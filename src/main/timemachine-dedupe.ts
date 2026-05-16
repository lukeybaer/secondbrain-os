import * as crypto from 'crypto';
import * as fs from 'fs';
import type { TimeMachineDedupeSettings } from './timemachine-types';

export interface FrameFingerprint {
  sizeBucket: number;
  hash: string;
  fileSize: number;
}

export class TimeMachineDedupe {
  private recent: FrameFingerprint[] = [];

  constructor(private settings: TimeMachineDedupeSettings) {}

  updateSettings(settings: TimeMachineDedupeSettings): void {
    this.settings = settings;
    this.recent = this.recent.slice(-settings.recentWindowSize);
  }

  reset(): void {
    this.recent = [];
  }

  check(filePath: string, fileSize: number): boolean {
    if (!this.settings.enabled) return false;
    const fingerprint = fingerprintFrame(filePath, fileSize, this.settings.chunkBytes);
    if (!fingerprint) return false;

    const duplicate = this.recent.some((candidate) =>
      fingerprintsMatch(candidate, fingerprint, this.settings.sizeDriftThreshold),
    );

    this.recent.push(fingerprint);
    this.recent = this.recent.slice(-this.settings.recentWindowSize);
    return duplicate;
  }
}

export function fingerprintFrame(
  filePath: string,
  fileSize: number,
  chunkBytes: number,
): FrameFingerprint | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const positions = Array.from(
        new Set([
          0,
          Math.max(0, Math.floor(fileSize / 2) - Math.floor(chunkBytes / 2)),
          Math.max(0, fileSize - chunkBytes),
        ]),
      );
      const hash = crypto.createHash('sha256');
      hash.update(String(fileSize));
      for (const position of positions) {
        const buf = Buffer.alloc(Math.min(chunkBytes, Math.max(fileSize - position, 0)));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
        hash.update(buf.subarray(0, bytesRead));
      }
      return {
        sizeBucket: Math.round(fileSize / Math.max(chunkBytes, 1)),
        hash: hash.digest('hex'),
        fileSize,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function fingerprintsMatch(
  previous: FrameFingerprint,
  current: FrameFingerprint,
  sizeDriftThreshold: number,
): boolean {
  const base = Math.max(previous.fileSize, 1);
  if (Math.abs(current.fileSize - previous.fileSize) / base > sizeDriftThreshold) return false;
  return previous.sizeBucket === current.sizeBucket && previous.hash === current.hash;
}

