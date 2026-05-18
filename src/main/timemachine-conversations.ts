// timemachine-conversations.ts
// Detects conversation boundaries from audio and processes them through
// the existing SecondBrain tagger pipeline.

import * as path from 'path';
import { spawn } from 'child_process';
import {
  insertConversation,
  updateConversationStatus,
  getPendingConversations,
} from './timemachine-db';
import { tagConversation } from './tagger';
import { saveConversation } from './storage';
import { upsertConversation } from './database';

// ─── Conversation Detection ─────────────────────────────────────────────

export interface ConversationBoundary {
  startTime: string; // ISO 8601
  endTime: string;
  audioFilePath: string;
}

export function registerConversation(boundary: ConversationBoundary): void {
  const start = new Date(boundary.startTime);
  const end = new Date(boundary.endTime);
  const durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);

  // Skip very short segments (< 10 seconds)
  if (durationSeconds < 10) return;

  const id = `tm_${start.toISOString().slice(0, 10).replace(/-/g, '')}_${start.toISOString().slice(11, 19).replace(/:/g, '')}`;
  insertConversation(id, boundary.startTime, boundary.endTime, durationSeconds, '');
}

// ─── Background Processor ───────────────────────────────────────────────

let processingActive = false;

export async function processDetectedConversations(): Promise<void> {
  if (processingActive) return;
  processingActive = true;

  try {
    const pending = getPendingConversations();

    for (const conv of pending) {
      try {
        // Transcribe the audio segment
        updateConversationStatus(conv.id, 'transcribing');

        const transcript = await transcribeSegment(conv.start_time, conv.end_time);
        if (!transcript || transcript.split(/\s+/).length < 50) {
          // Too short to be a meaningful conversation
          updateConversationStatus(conv.id, 'complete');
          continue;
        }

        // Tag via AI
        updateConversationStatus(conv.id, 'tagging');

        const meta = await tagConversation(
          conv.id,
          `Ambient Recording ${new Date(conv.start_time).toLocaleString()}`,
          conv.start_time,
          conv.duration_seconds / 60,
          transcript,
        );

        // Override meeting type
        meta.meetingType = 'ambient_capture';

        // Save to existing conversation store
        saveConversation(meta, transcript);
        upsertConversation(meta);

        updateConversationStatus(conv.id, 'complete', conv.id);
      } catch (err: any) {
        console.error(`[timemachine] Failed to process conversation ${conv.id}:`, err.message);
        updateConversationStatus(conv.id, 'error');
      }
    }
  } finally {
    processingActive = false;
  }
}

// ─── Audio Transcription ────────────────────────────────────────────────

async function transcribeSegment(startTime: string, endTime: string): Promise<string> {
  // For now, we extract and transcribe using the existing transcribe.py script
  // In the future, this could use streaming Whisper

  // Find the audio files that cover this time range
  // Audio files are stored as hourly segments in the buffer dir
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'transcribe.py');

  // TODO: Extract the specific time range from hourly Opus files
  // For MVP, transcribe the full hourly file that contains this segment

  return new Promise((resolve, reject) => {
    // Placeholder — will be wired to actual audio file extraction
    resolve('');
  });
}
