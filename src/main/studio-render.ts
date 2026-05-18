// studio-render.ts
// FFmpeg-based video rendering from an Edit Decision List.
// Composites multi-camera recordings into professional LinkedIn/YouTube videos.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import type { StudioRecording, EditDecision, StudioTranscript } from './studio';
import { loadStudioConfig } from './studio';

// ─── Types ──────────────────────────────────────────────────────────────

interface RenderOutputs {
  linkedin?: string;
  youtube?: string;
}

interface SubtitleEntry {
  index: number;
  start: string; // SRT timestamp format
  end: string;
  text: string;
}

// ─── Main Render Pipeline ───────────────────────────────────────────────

export async function renderFromEDL(
  recording: StudioRecording,
  edl: EditDecision[],
  onProgress?: (pct: number) => void,
): Promise<RenderOutputs> {
  const config = loadStudioConfig();
  const recDir = path.dirname(
    recording.files['front'] || recording.files['main'] || Object.values(recording.files)[0],
  );
  const outputs: RenderOutputs = {};

  // Generate SRT subtitles from transcript
  let srtPath: string | undefined;
  if (recording.transcript) {
    srtPath = path.join(recDir, 'subtitles.srt');
    generateSRT(recording.transcript, srtPath);
  }

  // Render LinkedIn version (4:5 vertical, 1080x1350)
  if (config.defaultFormat === 'linkedin' || config.defaultFormat === 'both') {
    onProgress?.(10);
    const linkedinPath = path.join(recDir, 'output_linkedin.mp4');
    await renderVideo(recording, edl, linkedinPath, {
      width: 1080,
      height: 1350,
      srtPath,
      lowerThirdName: config.lowerThirdName,
      lowerThirdTitle: config.lowerThirdTitle,
    });
    outputs.linkedin = linkedinPath;
    onProgress?.(55);
  }

  // Render YouTube version (16:9 horizontal, 1920x1080)
  if (config.defaultFormat === 'youtube' || config.defaultFormat === 'both') {
    onProgress?.(60);
    const youtubePath = path.join(recDir, 'output_youtube.mp4');
    await renderVideo(recording, edl, youtubePath, {
      width: 1920,
      height: 1080,
      srtPath,
      lowerThirdName: config.lowerThirdName,
      lowerThirdTitle: config.lowerThirdTitle,
    });
    outputs.youtube = youtubePath;
    onProgress?.(95);
  }

  onProgress?.(100);
  return outputs;
}

// ─── FFmpeg Video Render ────────────────────────────────────────────────

interface RenderOptions {
  width: number;
  height: number;
  srtPath?: string;
  lowerThirdName?: string;
  lowerThirdTitle?: string;
}

async function renderVideo(
  recording: StudioRecording,
  edl: EditDecision[],
  outputPath: string,
  options: RenderOptions,
): Promise<void> {
  // Map camera positions to file paths
  const cameraFiles: Record<string, string> = {};
  for (const cam of recording.cameras) {
    const file = recording.files[cam.position];
    if (file) cameraFiles[cam.position] = file;
  }
  if (recording.screenFile) cameraFiles['screen'] = recording.screenFile;
  if (recording.files['screen']) cameraFiles['screen'] = recording.files['screen'];
  if (recording.files['main']) cameraFiles['main'] = recording.files['main'];

  // Find a file that actually has an audio stream by probing
  let audioFileHint: string | undefined;
  const audioCandidates: string[] = [];

  // Prefer camera with audioDevice configured
  for (const cam of recording.cameras) {
    if (cam.audioDevice && recording.files[cam.position]) {
      const mp4 = recording.files[cam.position].replace(/\.mkv$/, '.mp4');
      audioCandidates.push(fs.existsSync(mp4) ? mp4 : recording.files[cam.position]);
    }
  }
  // Then try all other files
  for (const f of Object.values(recording.files)) {
    if (f && !audioCandidates.includes(f)) audioCandidates.push(f);
  }
  if (recording.audioFile) audioCandidates.push(recording.audioFile);
  if (recording.screenFile) audioCandidates.push(recording.screenFile);

  for (const candidate of audioCandidates) {
    if (!fs.existsSync(candidate)) continue;
    if (await probeHasAudio(candidate)) {
      audioFileHint = candidate;
      console.log(`[studio-render] Using audio from: ${path.basename(candidate)}`);
      break;
    }
  }
  if (!audioFileHint) {
    console.warn('[studio-render] No file has audio — rendering video-only');
  }

  // Build FFmpeg filter_complex from EDL
  const { filterComplex, inputs, outputMaps } = buildFilterComplex(
    edl,
    cameraFiles,
    options,
    audioFileHint,
  );

  // Build FFmpeg command
  const args: string[] = [];

  // Add input files
  for (const inputPath of inputs) {
    args.push('-i', inputPath);
  }

  // Add filter complex
  args.push('-filter_complex', filterComplex);

  // Output mapping
  for (const map of outputMaps) {
    args.push('-map', map);
  }

  // Encoding settings
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
  if (audioFileHint) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-movflags', '+faststart', '-y', outputPath);

  await runFFmpeg(args);
}

/** Probe whether a file has an audio stream. */
async function probeHasAudio(filePath: string): Promise<boolean> {
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

function buildFilterComplex(
  edl: EditDecision[],
  cameraFiles: Record<string, string>,
  options: RenderOptions,
  audioFileHint?: string,
): { filterComplex: string; inputs: string[]; outputMaps: string[] } {
  // Deduplicate input files and create index mapping
  const uniqueFiles: string[] = [];
  const fileIndex: Record<string, number> = {};

  for (const decision of edl) {
    const camera = decision.camera;
    const file = cameraFiles[camera] || cameraFiles['main'] || Object.values(cameraFiles)[0];
    if (file && !(file in fileIndex)) {
      fileIndex[file] = uniqueFiles.length;
      uniqueFiles.push(file);
    }
  }

  // Ensure the audio source file is included as an input even if not referenced by EDL cameras
  let audioInputIdx = -1;
  if (audioFileHint && fs.existsSync(audioFileHint)) {
    if (audioFileHint in fileIndex) {
      audioInputIdx = fileIndex[audioFileHint];
    } else {
      audioInputIdx = uniqueFiles.length;
      fileIndex[audioFileHint] = audioInputIdx;
      uniqueFiles.push(audioFileHint);
    }
  }

  if (uniqueFiles.length === 0) {
    throw new Error('No input files available for rendering');
  }

  // Determine which input has audio (if any)
  const hasAudio = audioInputIdx >= 0;
  const audioSrcIdx = audioInputIdx >= 0 ? audioInputIdx : 0;

  // Build filter segments
  const filterParts: string[] = [];

  for (let i = 0; i < edl.length; i++) {
    const d = edl[i];
    const file = cameraFiles[d.camera] || cameraFiles['main'] || Object.values(cameraFiles)[0];
    const srcIdx = fileIndex[file!];

    // Video: trim + scale + optional zoom
    let videoFilter = `[${srcIdx}:v]trim=start=${d.start}:end=${d.end},setpts=PTS-STARTPTS`;

    // Apply digital zoom if specified
    if (d.zoom && d.zoom > 1.0) {
      const zoomFactor = d.zoom;
      const cropW = Math.round(options.width / zoomFactor);
      const cropH = Math.round(options.height / zoomFactor);
      const cropX = Math.round((options.width - cropW) / 2);
      const cropY = Math.round((options.height - cropH) / 2);
      videoFilter += `,crop=${cropW}:${cropH}:${cropX}:${cropY}`;
    }

    videoFilter += `,scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`;
    videoFilter += `[v${i}]`;
    filterParts.push(videoFilter);

    // Audio: only include if we have an audio source
    if (hasAudio) {
      const audioFilter = `[${audioSrcIdx}:a]atrim=start=${d.start}:end=${d.end},asetpts=PTS-STARTPTS[a${i}]`;
      filterParts.push(audioFilter);
    }
  }

  // Concatenate all segments
  if (hasAudio) {
    const concatInput = edl.map((_, i) => `[v${i}][a${i}]`).join('');
    filterParts.push(`${concatInput}concat=n=${edl.length}:v=1:a=1[outv][outa]`);
  } else {
    const concatInput = edl.map((_, i) => `[v${i}]`).join('');
    filterParts.push(`${concatInput}concat=n=${edl.length}:v=1:a=0[outv]`);
  }

  // Add subtitles if available
  let finalVideoLabel = '[outv]';
  if (options.srtPath && fs.existsSync(options.srtPath)) {
    const escapedSrtPath = options.srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filterParts.push(
      `[outv]subtitles='${escapedSrtPath}':force_style='FontName=DejaVu Sans Bold,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=40'[subv]`,
    );
    finalVideoLabel = '[subv]';
  }

  // Add lower third name card (first 4 seconds)
  if (options.lowerThirdName) {
    const name = options.lowerThirdName.replace(/'/g, "\\'");
    const title = (options.lowerThirdTitle || '').replace(/'/g, "\\'");
    filterParts.push(
      `${finalVideoLabel}drawtext=text='${name}':fontfile=DejaVuSans-Bold.ttf:fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=40:y=h-120:enable='between(t,0.5,4)'` +
        (title
          ? `,drawtext=text='${title}':fontfile=DejaVuSans.ttf:fontsize=24:fontcolor=white@0.8:borderw=1:bordercolor=black:x=40:y=h-80:enable='between(t,0.5,4)'`
          : '') +
        '[finalv]',
    );
    finalVideoLabel = '[finalv]';
  }

  // Audio normalization (only if audio exists)
  if (hasAudio) {
    filterParts.push(`[outa]loudnorm=I=-16:TP=-1.5:LRA=11[finala]`);
  }

  return {
    filterComplex: filterParts.join('; '),
    inputs: uniqueFiles,
    outputMaps: hasAudio ? [finalVideoLabel, '[finala]'] : [finalVideoLabel],
  };
}

// ─── SRT Subtitle Generation ────────────────────────────────────────────

function generateSRT(transcript: StudioTranscript, outputPath: string): void {
  const words = transcript.words;
  if (words.length === 0) return;

  const entries: SubtitleEntry[] = [];
  let index = 1;

  // Group words into subtitle lines (max 8 words or 42 chars per line, 2-4 seconds)
  let lineWords: typeof words = [];
  let lineStart = words[0].start;

  for (const word of words) {
    lineWords.push(word);
    const lineText = lineWords.map((w) => w.word).join(' ');
    const lineDuration = word.end - lineStart;

    if (lineWords.length >= 8 || lineText.length >= 42 || lineDuration >= 3.5) {
      entries.push({
        index: index++,
        start: formatSRTTime(lineStart),
        end: formatSRTTime(word.end),
        text: lineText,
      });
      lineWords = [];
      lineStart = word.end;
    }
  }

  // Flush remaining words
  if (lineWords.length > 0) {
    entries.push({
      index: index++,
      start: formatSRTTime(lineStart),
      end: formatSRTTime(lineWords[lineWords.length - 1].end),
      text: lineWords.map((w) => w.word).join(' '),
    });
  }

  // Write SRT file
  const srt = entries.map((e) => `${e.index}\n${e.start} --> ${e.end}\n${e.text}\n`).join('\n');

  fs.writeFileSync(outputPath, srt, 'utf-8');
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ─── FFmpeg Execution ───────────────────────────────────────────────────

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      env: { ...process.env },
    });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
    });
  });
}
