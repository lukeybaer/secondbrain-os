// studio-director.ts
// AI-powered transcription and edit decision list generation.
// Uses faster-whisper (Python) for transcription and Claude API for intelligent editing.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getConfig } from './config';
import type {
  StudioRecording,
  StudioTranscript,
  TranscriptWord,
  TranscriptSection,
  EditDecision,
  StudioMarker,
} from './studio';

// ─── Retake Detection Phrases ───────────────────────────────────────────

const RETAKE_PHRASES = [
  'let me do that again',
  'let me start over',
  'sorry let me',
  'actually let me redo',
  'one more time',
  'take two',
  'hold on let me',
  'wait let me',
  'scratch that',
  'from the top',
  'let me try that again',
  'let me redo that',
  "i'll start over",
  "i'm going to start over",
  'let me rephrase',
];

// ─── Transcription ──────────────────────────────────────────────────────

export async function transcribeRecording(recording: StudioRecording): Promise<StudioTranscript> {
  // Find the first file that exists AND has an audio stream
  const candidates = [
    recording.audioFile,
    recording.files['front'],
    recording.files['main'],
    ...Object.values(recording.files),
    recording.screenFile,
  ].filter(Boolean) as string[];

  // Deduplicate and filter to existing files
  const existing = [...new Set(candidates)].filter((f) => fs.existsSync(f));

  if (existing.length === 0) {
    throw new Error(
      `No audio source found. Expected files: ${candidates.join(', ')} — none exist on disk.`,
    );
  }

  // Find the first file with an actual audio stream
  let audioSource: string | null = null;
  for (const f of existing) {
    const has = await checkForAudioStream(f);
    if (has) {
      audioSource = f;
      break;
    }
    console.log(`[studio-director] Skipping ${path.basename(f)} — no audio stream`);
  }

  if (!audioSource) {
    throw new Error(
      `No files have an audio stream. Checked: ${existing.map((f) => path.basename(f)).join(', ')}. Ensure the microphone is recording.`,
    );
  }

  // Try local faster-whisper first, fall back to OpenAI Whisper API
  let words: TranscriptWord[];
  try {
    words = await runWhisperTranscription(audioSource);
  } catch (localErr) {
    console.warn('[studio-director] Local whisper failed, trying OpenAI API fallback:', localErr);
    const config = getConfig();
    if (!config.openaiApiKey) {
      throw new Error(
        `Local Whisper failed (${localErr instanceof Error ? localErr.message : localErr}) and no OpenAI API key configured for fallback.`,
      );
    }
    words = await runOpenAIWhisperTranscription(audioSource, config.openaiApiKey);
  }

  // Build full text
  const fullText = words.map((w) => w.word).join(' ');

  // Detect sections from natural pauses and topic shifts
  const sections = detectSections(words);

  return { words, fullText, sections };
}

async function runWhisperTranscription(audioPath: string): Promise<TranscriptWord[]> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'transcribe.py');

    const proc = spawn('python', [scriptPath, audioPath, '--output-format', 'json'], {
      cwd: path.dirname(audioPath),
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper transcription failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        const words: TranscriptWord[] = (result.words || []).map(
          (w: { word: string; start: number; end: number; probability?: number }) => ({
            word: w.word.trim(),
            start: w.start,
            end: w.end,
            confidence: w.probability ?? 1.0,
          }),
        );
        resolve(words);
      } catch (err: any) {
        reject(new Error(`Failed to parse transcription output: ${err.message}`));
      }
    });
  });
}

/** Check if a media file contains an audio stream. */
async function checkForAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      filePath,
    ]);
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('close', () => resolve(stdout.trim().includes('audio')));
    proc.on('error', () => resolve(false));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve(false);
    }, 5000);
  });
}

/**
 * Fallback: use OpenAI Whisper API when local faster-whisper is unavailable.
 * Uses the gpt-4o-mini transcription model for cost efficiency.
 */
async function runOpenAIWhisperTranscription(
  audioPath: string,
  apiKey: string,
): Promise<TranscriptWord[]> {
  console.log('[studio-director] Using OpenAI Whisper API for transcription');

  // Extract audio to a temp WAV file for the API (MKV may not be directly supported)
  const tempWav = audioPath.replace(/\.[^.]+$/, '_audio.wav');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i',
      audioPath,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      tempWav,
    ]);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg audio extract failed (code ${code})`)),
    );
    proc.on('error', reject);
  });

  try {
    const fileData = fs.readFileSync(tempWav);
    const blob = new Blob([fileData], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, path.basename(tempWav));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI Whisper API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const words: TranscriptWord[] = (data.words || []).map(
      (w: { word: string; start: number; end: number }) => ({
        word: w.word.trim(),
        start: w.start,
        end: w.end,
        confidence: 1.0,
      }),
    );

    console.log(`[studio-director] OpenAI Whisper transcribed ${words.length} words`);
    return words;
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempWav);
    } catch {
      /* ok */
    }
  }
}

function detectSections(words: TranscriptWord[]): TranscriptSection[] {
  if (words.length === 0) return [];

  const sections: TranscriptSection[] = [];
  let sectionStart = words[0].start;
  let sectionWords: string[] = [];

  for (let i = 0; i < words.length; i++) {
    sectionWords.push(words[i].word);

    // Detect section boundary: pause > 2 seconds between words
    const nextWord = words[i + 1];
    const isLastWord = !nextWord;
    const hasLongPause = nextWord && nextWord.start - words[i].end > 2.0;

    if (isLastWord || hasLongPause) {
      sections.push({
        start: sectionStart,
        end: words[i].end,
        text: sectionWords.join(' '),
      });
      sectionWords = [];
      if (nextWord) sectionStart = nextWord.start;
    }
  }

  return sections;
}

// ─── Edit Decision List Generation ──────────────────────────────────────

export async function generateEDL(
  recording: StudioRecording,
  transcript: StudioTranscript,
): Promise<EditDecision[]> {
  const config = getConfig();
  const anthropicKey = config.anthropicApiKey;

  if (!anthropicKey) {
    // Fallback: generate a simple EDL without AI
    return generateSimpleEDL(recording, transcript);
  }

  try {
    return await generateAIEDL(recording, transcript, anthropicKey);
  } catch (err: any) {
    console.error('AI EDL generation failed, using simple EDL:', err.message);
    return generateSimpleEDL(recording, transcript);
  }
}

async function generateAIEDL(
  recording: StudioRecording,
  transcript: StudioTranscript,
  apiKey: string,
): Promise<EditDecision[]> {
  const availableCameras = recording.cameras.map((c) => c.position);
  const hasScreen = recording.screenFile || recording.files['screen'];

  // Build timestamped transcript for LLM
  const timestampedText = transcript.words
    .map((w) => `[${w.start.toFixed(1)}s] ${w.word}`)
    .join(' ');

  // Include markers (retakes, highlights)
  const markerInfo =
    recording.markers.length > 0
      ? '\n\nUser markers during recording:\n' +
        recording.markers
          .map((m) => `- ${m.type} at ${m.timestamp.toFixed(1)}s${m.label ? `: ${m.label}` : ''}`)
          .join('\n')
      : '';

  const prompt = `You are an expert video editor creating an Edit Decision List (EDL) for a talking-head video.

Available camera angles: ${availableCameras.join(', ')}${hasScreen ? ', screen' : ''}

Camera positions:
- front: Main talking head (use for emphasis, intro, conclusion)
- side: 45-degree angle (use for visual variety when changing topics)
- overhead: Top-down desk shot (use when speaker references physical items)
- screen: Screen capture (use when speaker talks about something on screen)

Editing rules:
1. Start with "front" camera for the intro (first 5-8 seconds)
2. Cut between angles every 8-15 seconds for visual interest
3. Never hold a shot less than 3 seconds
4. Cut on breath pauses between sentences
5. Use "side" when transitioning between topics
6. Zoom to 1.15x on the most quotable/impactful statements (max 2-3 per video)
7. End on "front" camera for conclusion

RETAKE HANDLING:
- If you detect retakes (speaker says "let me do that again" or repeats similar content), ONLY include the final/best take
- Remove all earlier takes and the retake cue phrase

${markerInfo}

Timestamped transcript:
${timestampedText}

Return ONLY a JSON array of edit decisions. Each decision:
{
  "camera": "front|side|overhead|screen",
  "start": <seconds>,
  "end": <seconds>,
  "type": "intro|key_point|screen_demo|transition|conclusion|b_roll",
  "zoom": <optional number, e.g. 1.15>,
  "transition": "cut|crossfade"
}

Remove dead air, filler, and retakes. Keep only the best content. Return valid JSON only.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('No valid JSON array found in AI response');
  }

  const edl: EditDecision[] = JSON.parse(jsonMatch[0]);

  // Validate EDL
  return edl.filter(
    (d) =>
      typeof d.camera === 'string' &&
      typeof d.start === 'number' &&
      typeof d.end === 'number' &&
      d.end > d.start,
  );
}

function generateSimpleEDL(
  recording: StudioRecording,
  transcript: StudioTranscript,
): EditDecision[] {
  const edl: EditDecision[] = [];
  const cameras = recording.cameras.filter((c) => c.enabled).map((c) => c.position);

  if (cameras.length === 0) return [];

  // Detect retakes in transcript and get clean segments
  const cleanSegments = removeRetakes(transcript);

  if (cleanSegments.length === 0 && transcript.words.length > 0) {
    // No retakes detected, use full transcript
    const totalDuration = transcript.words[transcript.words.length - 1].end;
    return generateAlternatingEDL(cameras, 0, totalDuration);
  }

  // Generate EDL from clean segments, alternating cameras
  let cameraIdx = 0;
  for (const segment of cleanSegments) {
    const segDuration = segment.end - segment.start;
    const cutInterval = 10; // Cut every ~10 seconds

    let t = segment.start;
    while (t < segment.end) {
      const cutEnd = Math.min(t + cutInterval, segment.end);
      edl.push({
        camera: cameras[cameraIdx % cameras.length],
        start: t,
        end: cutEnd,
        type: t === segment.start && edl.length === 0 ? 'intro' : 'key_point',
        transition: 'cut',
      });
      cameraIdx++;
      t = cutEnd;
    }
  }

  return edl;
}

function generateAlternatingEDL(cameras: string[], start: number, end: number): EditDecision[] {
  const edl: EditDecision[] = [];
  const cutInterval = 10;
  let cameraIdx = 0;
  let t = start;

  while (t < end) {
    const cutEnd = Math.min(t + cutInterval, end);
    edl.push({
      camera: cameras[cameraIdx % cameras.length],
      start: t,
      end: cutEnd,
      type: t === start ? 'intro' : 'key_point',
      transition: 'cut',
    });
    cameraIdx++;
    t = cutEnd;
  }

  return edl;
}

// ─── Retake Detection ───────────────────────────────────────────────────

interface CleanSegment {
  start: number;
  end: number;
}

function removeRetakes(transcript: StudioTranscript): CleanSegment[] {
  const words = transcript.words;
  if (words.length === 0) return [];

  // Find retake cue phrases in the transcript
  const fullText = words.map((w) => w.word.toLowerCase()).join(' ');
  const retakePoints: number[] = []; // timestamps where retakes begin

  for (const phrase of RETAKE_PHRASES) {
    let searchFrom = 0;
    while (true) {
      const idx = fullText.indexOf(phrase, searchFrom);
      if (idx === -1) break;

      // Find the word at this character position
      let charCount = 0;
      for (const word of words) {
        charCount += word.word.length + 1;
        if (charCount > idx) {
          retakePoints.push(word.start);
          break;
        }
      }
      searchFrom = idx + phrase.length;
    }
  }

  // Also check user-placed retake markers
  // (markers are on the recording, not transcript, but we include them)

  if (retakePoints.length === 0) return [];

  // Sort retake points
  retakePoints.sort((a, b) => a - b);

  // For each retake point, find the similar content that follows
  // Simple approach: skip from retake cue to the next sentence start
  const segments: CleanSegment[] = [];
  let lastEnd = words[0].start;

  for (const retakeTime of retakePoints) {
    // Include everything before the retake
    if (retakeTime > lastEnd) {
      // Find the sentence start before the retake (go back to previous pause)
      let sentenceStart = retakeTime;
      for (let i = words.length - 1; i >= 0; i--) {
        if (words[i].end <= retakeTime) {
          // Look for a pause > 0.5s indicating sentence boundary
          if (i > 0 && words[i].start - words[i - 1].end > 0.5) {
            sentenceStart = words[i].start;
            break;
          }
          if (i === 0) sentenceStart = words[0].start;
        }
      }

      if (sentenceStart > lastEnd) {
        segments.push({ start: lastEnd, end: sentenceStart });
      }
    }

    // Skip past the retake cue phrase — find the next sentence start after it
    let nextStart = retakeTime;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start >= retakeTime + 2.0) {
        // Look for a pause indicating new content
        if (i > 0 && words[i].start - words[i - 1].end > 0.3) {
          nextStart = words[i].start;
          break;
        }
      }
    }
    lastEnd = nextStart;
  }

  // Include everything after the last retake
  const finalWord = words[words.length - 1];
  if (lastEnd < finalWord.end) {
    segments.push({ start: lastEnd, end: finalWord.end });
  }

  return segments;
}
