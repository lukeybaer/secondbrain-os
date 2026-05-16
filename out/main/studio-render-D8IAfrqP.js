"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const index = require("./index.js");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
async function renderFromEDL(recording, edl, onProgress) {
  const config = index.loadStudioConfig();
  const recDir = path__namespace.dirname(
    recording.files["front"] || recording.files["main"] || Object.values(recording.files)[0]
  );
  const outputs = {};
  let srtPath;
  if (recording.transcript) {
    srtPath = path__namespace.join(recDir, "subtitles.srt");
    generateSRT(recording.transcript, srtPath);
  }
  if (config.defaultFormat === "linkedin" || config.defaultFormat === "both") {
    onProgress?.(10);
    const linkedinPath = path__namespace.join(recDir, "output_linkedin.mp4");
    await renderVideo(recording, edl, linkedinPath, {
      width: 1080,
      height: 1350,
      srtPath,
      lowerThirdName: config.lowerThirdName,
      lowerThirdTitle: config.lowerThirdTitle
    });
    outputs.linkedin = linkedinPath;
    onProgress?.(55);
  }
  if (config.defaultFormat === "youtube" || config.defaultFormat === "both") {
    onProgress?.(60);
    const youtubePath = path__namespace.join(recDir, "output_youtube.mp4");
    await renderVideo(recording, edl, youtubePath, {
      width: 1920,
      height: 1080,
      srtPath,
      lowerThirdName: config.lowerThirdName,
      lowerThirdTitle: config.lowerThirdTitle
    });
    outputs.youtube = youtubePath;
    onProgress?.(95);
  }
  onProgress?.(100);
  return outputs;
}
async function renderVideo(recording, edl, outputPath, options) {
  const cameraFiles = {};
  for (const cam of recording.cameras) {
    const file = recording.files[cam.position];
    if (file) cameraFiles[cam.position] = file;
  }
  if (recording.screenFile) cameraFiles["screen"] = recording.screenFile;
  if (recording.files["screen"]) cameraFiles["screen"] = recording.files["screen"];
  if (recording.files["main"]) cameraFiles["main"] = recording.files["main"];
  let audioFileHint;
  const audioCandidates = [];
  for (const cam of recording.cameras) {
    if (cam.audioDevice && recording.files[cam.position]) {
      const mp4 = recording.files[cam.position].replace(/\.mkv$/, ".mp4");
      audioCandidates.push(fs__namespace.existsSync(mp4) ? mp4 : recording.files[cam.position]);
    }
  }
  for (const f of Object.values(recording.files)) {
    if (f && !audioCandidates.includes(f)) audioCandidates.push(f);
  }
  if (recording.audioFile) audioCandidates.push(recording.audioFile);
  if (recording.screenFile) audioCandidates.push(recording.screenFile);
  for (const candidate of audioCandidates) {
    if (!fs__namespace.existsSync(candidate)) continue;
    if (await probeHasAudio(candidate)) {
      audioFileHint = candidate;
      console.log(`[studio-render] Using audio from: ${path__namespace.basename(candidate)}`);
      break;
    }
  }
  if (!audioFileHint) {
    console.warn("[studio-render] No file has audio , rendering video-only");
  }
  const { filterComplex, inputs, outputMaps } = buildFilterComplex(
    edl,
    cameraFiles,
    options,
    audioFileHint
  );
  const args = [];
  for (const inputPath of inputs) {
    args.push("-i", inputPath);
  }
  args.push("-filter_complex", filterComplex);
  for (const map of outputMaps) {
    args.push("-map", map);
  }
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  if (audioFileHint) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart", "-y", outputPath);
  await runFFmpeg(args);
}
async function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const proc = cp.spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      filePath
    ]);
    let stdout = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("close", () => resolve(stdout.trim().includes("audio")));
    proc.on("error", () => resolve(false));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
      }
      resolve(false);
    }, 5e3);
  });
}
function buildFilterComplex(edl, cameraFiles, options, audioFileHint) {
  const uniqueFiles = [];
  const fileIndex = {};
  for (const decision of edl) {
    const camera = decision.camera;
    const file = cameraFiles[camera] || cameraFiles["main"] || Object.values(cameraFiles)[0];
    if (file && !(file in fileIndex)) {
      fileIndex[file] = uniqueFiles.length;
      uniqueFiles.push(file);
    }
  }
  let audioInputIdx = -1;
  if (audioFileHint && fs__namespace.existsSync(audioFileHint)) {
    if (audioFileHint in fileIndex) {
      audioInputIdx = fileIndex[audioFileHint];
    } else {
      audioInputIdx = uniqueFiles.length;
      fileIndex[audioFileHint] = audioInputIdx;
      uniqueFiles.push(audioFileHint);
    }
  }
  if (uniqueFiles.length === 0) {
    throw new Error("No input files available for rendering");
  }
  const hasAudio = audioInputIdx >= 0;
  const audioSrcIdx = audioInputIdx >= 0 ? audioInputIdx : 0;
  const filterParts = [];
  for (let i = 0; i < edl.length; i++) {
    const d = edl[i];
    const file = cameraFiles[d.camera] || cameraFiles["main"] || Object.values(cameraFiles)[0];
    const srcIdx = fileIndex[file];
    let videoFilter = `[${srcIdx}:v]trim=start=${d.start}:end=${d.end},setpts=PTS-STARTPTS`;
    if (d.zoom && d.zoom > 1) {
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
    if (hasAudio) {
      const audioFilter = `[${audioSrcIdx}:a]atrim=start=${d.start}:end=${d.end},asetpts=PTS-STARTPTS[a${i}]`;
      filterParts.push(audioFilter);
    }
  }
  if (hasAudio) {
    const concatInput = edl.map((_, i) => `[v${i}][a${i}]`).join("");
    filterParts.push(`${concatInput}concat=n=${edl.length}:v=1:a=1[outv][outa]`);
  } else {
    const concatInput = edl.map((_, i) => `[v${i}]`).join("");
    filterParts.push(`${concatInput}concat=n=${edl.length}:v=1:a=0[outv]`);
  }
  let finalVideoLabel = "[outv]";
  if (options.srtPath && fs__namespace.existsSync(options.srtPath)) {
    const escapedSrtPath = options.srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    filterParts.push(
      `[outv]subtitles='${escapedSrtPath}':force_style='FontName=DejaVu Sans Bold,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=40'[subv]`
    );
    finalVideoLabel = "[subv]";
  }
  if (options.lowerThirdName) {
    const name = options.lowerThirdName.replace(/'/g, "\\'");
    const title = (options.lowerThirdTitle || "").replace(/'/g, "\\'");
    filterParts.push(
      `${finalVideoLabel}drawtext=text='${name}':fontfile=DejaVuSans-Bold.ttf:fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=40:y=h-120:enable='between(t,0.5,4)'` + (title ? `,drawtext=text='${title}':fontfile=DejaVuSans.ttf:fontsize=24:fontcolor=white@0.8:borderw=1:bordercolor=black:x=40:y=h-80:enable='between(t,0.5,4)'` : "") + "[finalv]"
    );
    finalVideoLabel = "[finalv]";
  }
  if (hasAudio) {
    filterParts.push(`[outa]loudnorm=I=-16:TP=-1.5:LRA=11[finala]`);
  }
  return {
    filterComplex: filterParts.join("; "),
    inputs: uniqueFiles,
    outputMaps: hasAudio ? [finalVideoLabel, "[finala]"] : [finalVideoLabel]
  };
}
function generateSRT(transcript, outputPath) {
  const words = transcript.words;
  if (words.length === 0) return;
  const entries = [];
  let index2 = 1;
  let lineWords = [];
  let lineStart = words[0].start;
  for (const word of words) {
    lineWords.push(word);
    const lineText = lineWords.map((w) => w.word).join(" ");
    const lineDuration = word.end - lineStart;
    if (lineWords.length >= 8 || lineText.length >= 42 || lineDuration >= 3.5) {
      entries.push({
        index: index2++,
        start: formatSRTTime(lineStart),
        end: formatSRTTime(word.end),
        text: lineText
      });
      lineWords = [];
      lineStart = word.end;
    }
  }
  if (lineWords.length > 0) {
    entries.push({
      index: index2++,
      start: formatSRTTime(lineStart),
      end: formatSRTTime(lineWords[lineWords.length - 1].end),
      text: lineWords.map((w) => w.word).join(" ")
    });
  }
  const srt = entries.map((e) => `${e.index}
${e.start} --> ${e.end}
${e.text}
`).join("\n");
  fs__namespace.writeFileSync(outputPath, srt, "utf-8");
}
function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round(seconds % 1 * 1e3);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn("ffmpeg", args, {
      env: { ...process.env }
    });
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => {
      reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
    });
  });
}
exports.renderFromEDL = renderFromEDL;
