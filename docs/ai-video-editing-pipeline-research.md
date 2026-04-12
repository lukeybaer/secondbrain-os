# AI-Powered Video Editing Pipeline — Research Report

**Date:** 2026-04-04
**Purpose:** Technical research for building an automated multi-camera talking-head video editing pipeline

---

## 1. AI Video Editing for Talking-Head Content

### Current Landscape

The AI video editing space for talking-head content has matured significantly. Three categories of tools exist:

**NLE Plugin-Based (Premiere Pro / DaVinci Resolve)**

- **AutoPod** ($29/mo) — Plugin for Premiere Pro and DaVinci Resolve. Supports up to 10 cameras and 10 microphones. Uses audio-based speaker detection to automatically switch angles. Also includes jump cut editor (silence removal) and social clip creator for aspect ratio adjustments.
- **Phantom Editor / Wraith** — Newer AutoPod competitor. Claims more intelligent context-aware switching that analyzes conversation patterns rather than just volume levels. Supports up to 8 angles. Offers min/max shot duration controls per camera/speaker. One-time license available.
- **FireCut / AutoCut** — Additional Premiere Pro plugins with similar auto-switching capabilities.

**Standalone AI Editors**

- **Descript** — Pioneered text-based video editing. Edit video by editing transcript. Automatic multicam mode that shows multiple speakers during dialogue, inserts cutaways during monologues. Has built-in "Remove Retakes" feature. Exports to Premiere/Resolve/Final Cut.
- **Eddie (HeyEddie.ai)** — Positioned as "ChatGPT for video editing." Natural language editing commands. Supports multicam podcasts, interviews, YouTube content. Auto-detects and switches to multicam mode on import. Up to 3 video angles + 1 main audio track. Waveform-based syncing for overlapping audio.
- **Gling** — AI-powered multicam syncing, cutting, and refinement. Auto-transcribes, removes unwanted takes and silences. Exports preserved timelines to Final Cut Pro, DaVinci Resolve, Premiere.

**Cloud/API-Based**

- **Cutback/Selects** — AI podcast editors with cloud processing
- **Creatomate** — API-based video rendering with Node.js SDK

### How Professional Editors Choose When to Cut

Research into professional multicam editing reveals these principles:

1. **Never cut for the sake of cutting.** A cut must have a reason — shift in dialogue, emotion, or action.
2. **Open wide, go tight progressively.** Start with a wide/medium establishing shot. As the speaker gets into detailed points, cut to tighter angles.
3. **Cut on breaths.** The ideal cut point is when a speaker takes a breath between thoughts.
4. **Cut for emphasis.** Move to a closer angle during emotional or important statements.
5. **Cut to reactions.** In multi-person content, cut to the listener's reaction during key moments.
6. **Maintain the axis.** Never cross the 180-degree line — if the speaker faces screen-right, they must always face screen-right.
7. **Minimum shot duration.** Professional edits rarely hold a shot for less than 2-3 seconds.
8. **Use the "30-degree rule."** Successive shots should differ by at least 30 degrees to feel like intentional cuts rather than jump cuts.

### Signals Used by AI Tools

| Signal                           | Used By                          | How                                         |
| -------------------------------- | -------------------------------- | ------------------------------------------- |
| Audio level / who's speaking     | AutoPod, Descript, Wraith, Eddie | Primary signal — assign cameras to speakers |
| Conversation patterns            | Wraith                           | Analyzes dialogue flow, not just volume     |
| Transcript / speaker diarization | Descript, Gling                  | Maps words to speakers via transcript       |
| Waveform analysis                | TimeBolt, Eddie                  | Detects silence, emphasis, pauses           |
| Scene analysis                   | Eddie (v2)                       | Groups B-roll and interview footage         |

---

## 2. Automated Multi-Cam Editing Tools — Deep Dive

### AutoPod

- **Platform:** Adobe Premiere Pro, DaVinci Resolve (beta)
- **Price:** $29/month, 30-day free trial
- **Cameras:** Up to 10 cameras + 10 microphones
- **Core feature:** Multi-Camera Editor that detects who is speaking and switches to their assigned angle
- **Additional tools:** Social Clip Creator (auto-reframe for vertical), Jump Cut Editor (silence removal)
- **Limitations:** Premiere/Resolve only — no standalone or API access

### Descript

- **Platform:** Standalone desktop app (Mac/Windows)
- **Price:** Free tier available, Business $24/user/mo
- **Multicam modes:**
  - "Automatic" — shows multiple speakers during dialogue, inserts cutaways during monologues
  - "Show only active speaker" — cuts to whoever is talking
- **Key differentiator:** Text-based editing. Edit the transcript and the video follows.
- **Retake removal:** Built-in AI that scans video, identifies best takes, removes the rest
- **Export:** Premiere Pro, Final Cut Pro, DaVinci Resolve, direct publish

### Eddie (HeyEddie.ai)

- **Platform:** Desktop app (Mac/Windows)
- **Price:** Subscription-based
- **Approach:** Natural language commands ("make it more energetic," "cut the slow parts")
- **Multicam:** Auto-detects multicam on import, supports up to 3 angles + 1 main audio
- **Syncing:** Waveform-based for overlapping audio; timestamp-based for separate recordings
- **Best for:** Interview-driven and documentary-style content
- **Export:** Premiere Pro, Final Cut Pro, DaVinci Resolve

### Wraith (Phantom Editor)

- **Platform:** Adobe Premiere Pro plugin
- **Price:** One-time lifetime license OR subscription
- **Cameras:** Up to 8 angles
- **Key differentiator:** Exposes explicit controls for min/max shot duration per camera and per speaker. Claims to analyze conversation patterns, not just volume.
- **Positioning:** Direct AutoPod competitor with more granular control

### Gling

- **Platform:** Web + desktop
- **Price:** Subscription-based
- **Focus:** YouTube creators
- **Multicam:** Auto-sync, auto-switch, silence/retake removal
- **Export:** Final Cut Pro, DaVinci Resolve, Premiere Pro (preserved timelines)

### Open-Source Alternatives

- **OpenShot** — Python/C++ open-source editor with emerging AI features (github.com/KuzscoTech/openshot-ai-features). No dedicated multicam auto-switching yet.
- **MoviePy** — Python library for programmatic video editing. No multicam auto-switching built in, but compositing primitives exist to build it.
- **ffmpeg-automated-editor** — GitHub project using ffmpeg-python for automated cuts based on audio analysis.

**Bottom line:** There is no mature open-source tool for AI multicam auto-switching. Building a custom pipeline from Whisper + LLM + FFmpeg is the path for a fully open/controllable solution.

---

## 3. FFmpeg Multi-Stream Recording and Editing

### Recording Multiple Webcams on Windows

**Listing available devices:**

```bash
ffmpeg -list_devices true -f dshow -i dummy
```

**Recording two webcams simultaneously to separate files:**

```bash
ffmpeg -f dshow -rtbufsize 512M -framerate 30 -video_size 1920x1080 -i video="Camera A":audio="Mic A" \
       -f dshow -rtbufsize 512M -framerate 30 -video_size 1920x1080 -i video="Camera B" \
       -map 0 -c:v libx264 -crf 18 -preset fast cam_a.mp4 \
       -map 1 -c:v libx264 -crf 18 -preset fast cam_b.mp4
```

**Recording to a single side-by-side file:**

```bash
ffmpeg -f dshow -i video="Camera A":audio="Mic A" \
       -f dshow -i video="Camera B":audio="Mic B" \
       -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
       -map "[v]" -map 0:a -c:v libx264 -crf 18 output.mp4
```

### Key Options for Reliable Multi-Cam Recording

| Option                    | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `-rtbufsize 512M`         | Larger real-time buffer prevents dropped frames |
| `-framerate 30`           | Explicit frame rate for consistency             |
| `-video_size 1920x1080`   | Explicit resolution                             |
| `-copyts`                 | Preserve timestamps for cross-stream sync       |
| `-itsoffset X`            | Manual time offset adjustment if cameras drift  |
| `-thread_queue_size 1024` | Larger queue for input threads                  |

### Synchronization Strategy

1. Record each camera to its own file with `-copyts`
2. Use `ffprobe` to extract timestamps from each file
3. Compute delta between streams
4. Apply offset with `-itsoffset` when compositing

### Programmatic Cutting Between Streams

**Using trim + concat filter:**

```bash
ffmpeg -i cam_a.mp4 -i cam_b.mp4 \
  -filter_complex \
  "[0:v]trim=start=0:end=5,setpts=PTS-STARTPTS[v0]; \
   [1:v]trim=start=5:end=10,setpts=PTS-STARTPTS[v1]; \
   [0:v]trim=start=10:end=15,setpts=PTS-STARTPTS[v2]; \
   [v0][v1][v2]concat=n=3:v=1:a=0[outv]" \
  -map "[outv]" output.mp4
```

**Using timeline editing for overlays:**

```bash
# Show cam_b overlay between seconds 5-10
ffmpeg -i cam_a.mp4 -i cam_b.mp4 \
  -filter_complex "[0:v][1:v]overlay=enable='between(t,5,10)'[out]" \
  -map "[out]" output.mp4
```

**Generating an EDL (Edit Decision List) approach:**
The most practical method for a programmatic pipeline is to:

1. Generate a list of cuts: `[{camera: "A", start: 0, end: 5.2}, {camera: "B", start: 5.2, end: 8.7}, ...]`
2. Write each segment with `trim` + `setpts`
3. Concatenate with the `concat` filter
4. Render once

---

## 4. AI Script Extraction and Key Moment Detection

### Transcription Layer

**Whisper (OpenAI)**

- Best-in-class open-source speech recognition
- Base model provides ~1-second segment timestamps
- For word-level timestamps, use enhanced variants:

| Tool                    | Method                                          | Speed     | Accuracy        |
| ----------------------- | ----------------------------------------------- | --------- | --------------- |
| **whisper-timestamped** | Dynamic Time Warping on cross-attention weights | Moderate  | High            |
| **WhisperX**            | Forced alignment with wav2vec 2.0 phoneme model | Fast      | Very high       |
| **stable-ts**           | Modified Whisper with stabilized timestamps     | Moderate  | High            |
| **faster-whisper**      | CTranslate2 implementation, 4x faster           | Very fast | Same as Whisper |

**FFmpeg 8.0+ Native Whisper:**
FFmpeg 8.0 introduced native Whisper integration, allowing transcription directly in the FFmpeg pipeline without external tools.

**Production recommendation:** Use `faster-whisper` with `WhisperX` for word-level alignment. This gives you speed + accurate word boundaries.

### LLM Key Moment Detection

Once you have a timestamped transcript, feed it to an LLM with a structured prompt:

```
Given this timestamped transcript of a talking-head recording:
[transcript with timestamps]

Identify:
1. KEY_MOMENTS: Timestamps where the speaker makes their most compelling/quotable points
2. RETAKES: Instances where the speaker restarts a thought (phrases like "let me do that again", "sorry", "actually", repeated sentence openings)
3. BEST_TAKES: For each retake group, which take is the best (typically the last one)
4. FILLER: Segments with excessive "um", "uh", long pauses
5. SECTIONS: Natural topic boundaries for chapter markers

Return as JSON with start/end timestamps for each.
```

### Pipeline Architecture

```
Raw Video → FFmpeg extract audio → faster-whisper transcription
    → WhisperX word-level alignment
    → LLM analysis (retakes, key moments, sections)
    → Edit Decision List (JSON)
    → FFmpeg composite final video
```

---

## 5. Retake Detection

### The Problem

In talking-head recordings, speakers frequently restart sentences, do full retakes of paragraphs, or have false starts. The goal is to automatically detect these and keep only the best take.

### Existing Solutions

**TimeBolt** — Most sophisticated retake detection:

- **Two modes:** "False Start Detection" (unscripted — catches stutters/aborted sentences) and "Retake Detection" (scripted — compares against teleprompter script, keeps last take)
- **How it works:** Uses Amazon AWS Transcribe for word-level tokens, then compares repeated sentences with configurable similarity tolerance ("Look Ahead Lines" setting)
- **Hybrid approach:** Waveform analysis determines WHERE to cut; AI transcription identifies WHAT to cut
- **Accuracy:** Claims 90-98% cut automation accuracy

**Descript** — Built-in "Remove Retakes" that scans video, identifies best take, lets you pick alternatives from the transcript

**Gling** — Auto-removes unwanted takes and silences during transcription analysis

### Building Custom Retake Detection

A custom retake detection pipeline would work as follows:

**Step 1: Transcribe with word-level timestamps**

```python
# Using faster-whisper + WhisperX
segments = whisper_model.transcribe(audio_path)
aligned = whisperx.align(segments, alignment_model, audio)
```

**Step 2: Detect retake cues via keyword matching**

```python
RETAKE_PHRASES = [
    "let me do that again",
    "let me start over",
    "sorry, let me",
    "actually, let me redo",
    "one more time",
    "take two",
    "hold on",
    "wait, let me",
    "scratch that",
    "from the top",
]
```

**Step 3: Detect retakes via sentence similarity**

```python
from difflib import SequenceMatcher

def find_retakes(sentences):
    retake_groups = []
    for i, sent_a in enumerate(sentences):
        for j, sent_b in enumerate(sentences[i+1:], i+1):
            ratio = SequenceMatcher(None, sent_a.text, sent_b.text).ratio()
            if ratio > 0.6:  # Configurable threshold
                retake_groups.append((sent_a, sent_b))
    return retake_groups
```

**Step 4: LLM-based retake analysis (for complex cases)**
Feed the full transcript to an LLM and ask it to identify retake groups, selecting the best take from each group. The LLM can catch semantic retakes that keyword/similarity matching would miss.

**Step 5: Generate edit points**
For each retake group, keep the last take (or LLM-selected best take), mark earlier takes for removal, and generate trim points.

---

## 6. Professional LinkedIn Video Style Guide

### Format Specifications (2026)

| Spec              | Recommended       | Notes                                                |
| ----------------- | ----------------- | ---------------------------------------------------- |
| **Aspect ratio**  | 4:5 (1080x1350)   | Mobile-first; dominates feed on phones               |
| **Alternative**   | 9:16 (1080x1920)  | Full vertical; getting distribution boost in 2026    |
| **Horizontal**    | 16:9 (1920x1080)  | Good for desktop; repurposed YouTube/webinar content |
| **Max file size** | 5 GB              |                                                      |
| **Max duration**  | 15 minutes (feed) | Short-form (< 2 min) performs best                   |
| **Frame rate**    | 30 fps            |                                                      |
| **Codec**         | H.264 / MP4       |                                                      |

**Key insight:** Vertical video (4:5 or 9:16) is currently getting a distribution boost on LinkedIn. Horizontal is being slightly deprioritized in the feed algorithm.

### Subtitles / Captions

- **Always add subtitles** — most LinkedIn users watch without sound
- **Format:** 1-2 lines per frame, max 42 characters per line, 2-4 seconds display time
- **Style:** Bold, high-contrast text (white with dark outline or background box)
- **File format:** SRT for upload; burned-in captions for maximum compatibility
- **LinkedIn auto-captions exist but are not editable and not customizable**

### Production Elements That Make LinkedIn Video Look Professional

1. **Hook in first 3 seconds** — text overlay or bold statement; viewers scroll fast
2. **Burned-in subtitles** — large, readable, high contrast
3. **Subtle zoom effects** — slow Ken Burns-style zoom in during key points creates visual movement on otherwise static talking-head shots. Zoom should accelerate smoothly and decelerate smoothly.
4. **B-roll cutaways** — break up talking head with relevant visuals, screen recordings, or graphics every 10-15 seconds
5. **Multi-angle cuts** — even 2 angles (medium + close-up) dramatically increases production value
6. **Lower thirds** — name/title graphic in first few seconds
7. **Consistent color grade** — warm, slightly lifted shadows, clean skin tones
8. **End card** — call to action, follow prompt, or question to drive comments
9. **Progress bar or chapter markers** — helps retention on longer videos

### Transitions Between Angles

- **Hard cuts** on speaker breaths (most common, cleanest)
- **Subtle cross-dissolve** (0.1-0.2s) for softer feel
- **Zoom punch-in** — digitally zoom into the same angle for a "virtual second camera" effect
- **L-cuts / J-cuts** — audio from next segment starts before or after the visual cut

---

## 7. Programmatic Video Editing with Node.js

### Library Comparison

| Library           | Language    | Best For                              | Multicam?          | Active?       |
| ----------------- | ----------- | ------------------------------------- | ------------------ | ------------- |
| **Remotion**      | React/TS    | Data-driven video generation at scale | Manual composition | Very active   |
| **fluent-ffmpeg** | Node.js     | FFmpeg wrapper, any video operation   | Via FFmpeg filters | Active        |
| **editly**        | Node.js     | Declarative slideshow/clip assembly   | Basic              | Moderate      |
| **ffmpeg-concat** | Node.js     | Concatenating with GL transitions     | No                 | Low activity  |
| **MoviePy**       | Python      | General programmatic editing          | Manual composition | Active        |
| **Creatomate**    | API/Node.js | Cloud rendering with templates        | Template-based     | Active (paid) |

### Remotion (Best for React/TypeScript teams)

Remotion lets you define video compositions as React components. Each frame is rendered as a React render, then encoded to video.

```tsx
// Example: switching between two camera angles
const MultiCamVideo: React.FC<{ cuts: Cut[] }> = ({ cuts }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const activeCut = cuts.find((c) => currentTime >= c.start && currentTime < c.end);

  return (
    <AbsoluteFill>
      {activeCut?.camera === 'A' ? (
        <OffthreadVideo src={camA} startFrom={activeCut.start * fps} />
      ) : (
        <OffthreadVideo src={camB} startFrom={activeCut.start * fps} />
      )}
      {/* Burn-in subtitles */}
      <Subtitles currentTime={currentTime} />
    </AbsoluteFill>
  );
};
```

**Pros:** Full React ecosystem, version-controllable video projects, server-side rendering, bundled FFmpeg since v4.0, excellent for generating many video variations.

**Cons:** Renders frame-by-frame (slower than direct FFmpeg for simple cuts), heavier toolchain.

### fluent-ffmpeg (Best for direct FFmpeg control)

```javascript
const ffmpeg = require('fluent-ffmpeg');

// Generate a multi-cam edit from an EDL
function renderMulticamEdit(edl, sources, outputPath) {
  let filterParts = [];
  let concatInputs = [];

  edl.forEach((cut, i) => {
    const srcIdx = cut.camera === 'A' ? 0 : 1;
    filterParts.push(
      `[${srcIdx}:v]trim=start=${cut.start}:end=${cut.end},setpts=PTS-STARTPTS[v${i}]`,
    );
    filterParts.push(
      `[${srcIdx}:a]atrim=start=${cut.start}:end=${cut.end},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });

  const concatFilter = `${concatInputs.join('')}concat=n=${edl.length}:v=1:a=1[outv][outa]`;
  filterParts.push(concatFilter);

  ffmpeg()
    .input(sources.camA)
    .input(sources.camB)
    .complexFilter(filterParts.join('; '))
    .outputOptions(['-map', '[outv]', '-map', '[outa]'])
    .output(outputPath)
    .on('end', () => console.log('Render complete'))
    .run();
}
```

**Pros:** Direct FFmpeg power, fast (no frame-by-frame rendering for cuts), lightweight.

**Cons:** Complex filter strings, less visual/debuggable than Remotion.

### editly (Best for quick slideshow/clip assembly)

```javascript
const editly = require('editly');

await editly({
  outPath: './output.mp4',
  clips: [
    { layers: [{ type: 'video', path: './cam_a.mp4', cutFrom: 0, cutTo: 5 }] },
    { layers: [{ type: 'video', path: './cam_b.mp4', cutFrom: 5, cutTo: 10 }] },
    { layers: [{ type: 'video', path: './cam_a.mp4', cutFrom: 10, cutTo: 15 }] },
  ],
  defaults: { transition: { name: 'crosswarp', duration: 0.2 } },
});
```

**Pros:** Declarative JSON/JS API, built-in transitions, simple.

**Cons:** Streaming-based (re-encodes everything), limited filter options, not designed for complex multicam.

### Recommendation for Automated Multi-Cam Pipeline

**Use fluent-ffmpeg** for the actual rendering — it gives you direct FFmpeg control with the performance of native stream processing. Use Remotion only if you need complex overlays, animated subtitles, or data-driven graphics burned into the video.

The pipeline would be:

1. **Record** with FFmpeg (or OBS) to separate files
2. **Transcribe** with faster-whisper + WhisperX (Python subprocess)
3. **Analyze** with LLM (Claude API) to generate edit decision list
4. **Render** with fluent-ffmpeg using the EDL

---

## 8. Screen Recording on Windows from Node.js/Electron

### Option 1: Electron desktopCapturer API (Built-in)

Electron's `desktopCapturer` provides access to screen and window capture via the Chromium Content API.

```javascript
// In renderer process
const { desktopCapturer } = require('electron');

async function startScreenRecording() {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sources[0].id,
        minWidth: 1920,
        minHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });

  const recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9',
  });

  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    // Save blob to file
  };

  recorder.start();
  return recorder;
}
```

**Pros:** No external dependencies, built into Electron, captures any window or full screen.

**Cons:** WebM output only (needs FFmpeg transcode to MP4), limited audio capture options, MediaRecorder quality can vary, no hardware encoding control.

### Option 2: OBS WebSocket API (Most Powerful)

OBS Studio ships with obs-websocket built-in (v28+), running on port 4455 by default.

```javascript
const OBSWebSocket = require('obs-websocket-js').default;

const obs = new OBSWebSocket();

async function setupOBSRecording() {
  await obs.connect('ws://127.0.0.1:4455', 'your-password');

  // Set recording output settings
  await obs.call('SetRecordDirectory', {
    recordDirectory: 'C:/recordings',
  });

  // Create scene with multiple sources
  await obs.call('CreateScene', { sceneName: 'MultiCam' });

  // Add webcam source
  await obs.call('CreateInput', {
    sceneName: 'MultiCam',
    inputName: 'Webcam',
    inputKind: 'dshow_input',
    inputSettings: { video_device_id: 'your-device-id' },
  });

  // Add screen capture source
  await obs.call('CreateInput', {
    sceneName: 'MultiCam',
    inputName: 'Screen',
    inputKind: 'monitor_capture',
    inputSettings: { monitor: 0 },
  });

  // Start recording
  await obs.call('StartRecord');

  // Switch scenes programmatically
  await obs.call('SetCurrentProgramScene', {
    sceneName: 'CloseUp',
  });
}
```

**Pros:** Professional-grade encoding (NVENC, x264, etc.), hardware acceleration, multiple sources, scenes, audio mixing, mature and battle-tested, programmatic control over everything.

**Cons:** Requires OBS installed, separate process, more complex setup.

### Option 3: FFmpeg Direct Capture (Lightweight)

```javascript
const { spawn } = require('child_process');

function startFFmpegScreenCapture(outputPath) {
  // Windows: use gdigrab for screen, dshow for webcam
  const ffmpeg = spawn('ffmpeg', [
    '-f',
    'gdigrab', // Windows screen capture
    '-framerate',
    '30',
    '-i',
    'desktop', // Full desktop
    '-f',
    'dshow', // Webcam
    '-i',
    'video=Integrated Webcam',
    '-filter_complex',
    '[0:v]scale=1920:1080[screen];[1:v]scale=320:240[cam];[screen][cam]overlay=W-w-10:H-h-10[out]',
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    outputPath,
  ]);

  return ffmpeg;
}
```

**Pros:** No GUI needed, lightweight, direct encoding control, can record screen + webcam simultaneously.

**Cons:** Windows `gdigrab` doesn't capture hardware-accelerated content well, no audio capture built into gdigrab (need separate audio input).

### Option 4: obs-studio-node (OBS as Library)

The `obs-studio-node` package (used by Streamlabs) embeds OBS as a Node.js native module. This gives OBS's full recording capabilities without launching the OBS GUI.

**Pros:** Full OBS power embedded in your Electron app.

**Cons:** Complex native module, large binary, Streamlabs-maintained (not official OBS), can be brittle across Node versions.

### Recommendation

For a SecondBrain integration:

| Use Case                                         | Best Option                       |
| ------------------------------------------------ | --------------------------------- |
| Quick screen grab for content                    | Electron desktopCapturer          |
| Multi-source recording (webcam + screen + audio) | OBS WebSocket API                 |
| Headless/automated recording                     | FFmpeg direct capture             |
| Full embedded recording suite                    | obs-studio-node (high complexity) |

**Best overall approach:** Use **OBS WebSocket** for recording (it handles multi-source, encoding, audio mixing perfectly) and **FFmpeg via fluent-ffmpeg** for post-recording editing/compositing. OBS records the raw material; your Node.js pipeline processes it.

---

## Recommended Architecture: End-to-End Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    RECORDING PHASE                          │
│                                                             │
│  OBS Studio (via WebSocket API from Electron)               │
│  ├── Scene 1: Wide shot (webcam A)                          │
│  ├── Scene 2: Close-up (webcam B or digital zoom)           │
│  ├── Scene 3: Screen capture                                │
│  └── Audio: Microphone input                                │
│                                                             │
│  Output: Separate files per source OR single multi-track    │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                  TRANSCRIPTION PHASE                         │
│                                                             │
│  faster-whisper → WhisperX alignment                        │
│  ├── Word-level timestamps                                  │
│  ├── Speaker diarization                                    │
│  └── Confidence scores                                      │
│                                                             │
│  Output: Timestamped transcript JSON                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                   ANALYSIS PHASE (LLM)                      │
│                                                             │
│  Claude API with structured prompt:                         │
│  ├── Identify retakes / false starts                        │
│  ├── Select best takes                                      │
│  ├── Mark key moments / quotable lines                      │
│  ├── Detect topic sections                                  │
│  ├── Suggest camera angle changes                           │
│  └── Flag filler words / dead air                           │
│                                                             │
│  Output: Edit Decision List (JSON)                          │
│  [{ camera: "A", start: 0, end: 5.2, type: "intro" },      │
│   { camera: "B", start: 5.2, end: 12.1, type: "key_point"},│
│   ...]                                                      │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                  RENDERING PHASE                            │
│                                                             │
│  fluent-ffmpeg (Node.js):                                   │
│  ├── Apply EDL cuts between camera sources                  │
│  ├── Remove retake segments                                 │
│  ├── Add subtle zoom effects (Ken Burns) on key moments     │
│  ├── Burn in subtitles (SRT → ASS with styling)             │
│  ├── Add lower third graphics                               │
│  ├── Apply color correction LUT                             │
│  └── Render to 4:5 vertical (LinkedIn) + 16:9 (YouTube)    │
│                                                             │
│  Output: Final edited video(s)                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Technical Decisions

1. **Record with OBS** (not FFmpeg directly) — OBS handles multi-source recording, hardware encoding, and audio mixing far better than raw FFmpeg on Windows.

2. **Transcribe with Python subprocess** — faster-whisper + WhisperX are Python-only. Call them from Node.js via `child_process.spawn`.

3. **Analyze with Claude API** — Send the timestamped transcript to Claude with a structured prompt. Get back a JSON edit decision list.

4. **Render with fluent-ffmpeg** — Convert the EDL to FFmpeg filter_complex commands. Single render pass for efficiency.

5. **Two output formats:** 4:5 vertical with burned-in subtitles for LinkedIn, 16:9 horizontal for YouTube/general use.

---

## Sources

- [AutoPod](https://www.autopod.fm/) — Automatic podcast editing for Premiere Pro
- [Descript Automatic Multicam](https://help.descript.com/hc/en-us/articles/28736507904525-Automatic-multicam)
- [Eddie AI Podcasts](https://help.heyeddie.ai/en/articles/10548843-introducing-eddie-podcasts-smart-multicam-editing-for-podcast-style-videos)
- [Phantom Editor / Wraith](https://phantomeditor.video/products/Wraith)
- [Gling Multicam](https://www.gling.ai/multicam-video-editing)
- [TimeBolt Retake Detection](https://www.timebolt.io/blog/auto-remove-bad-takes)
- [FFmpeg Multitrack Recording on Windows](https://blog.claranguyen.me/post/2024/12/15/multitrack-recording-win/)
- [WhisperX](https://github.com/m-bain/whisperx) — Word-level timestamps and diarization
- [whisper-timestamped](https://github.com/linto-ai/whisper-timestamped) — DTW-based word timestamps
- [FFmpeg 8.0 Native Whisper](https://www.rendi.dev/post/ffmpeg-8-0-part-1-using-whisper-for-native-video-transcription-in-ffmpeg)
- [Remotion](https://www.remotion.dev/) — Programmatic video with React
- [editly](https://github.com/mifi/editly) — Declarative Node.js video editing
- [OBS WebSocket](https://github.com/obsproject/obs-websocket) — Remote control OBS via WebSocket
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [LinkedIn Video Specs 2026](https://www.yansmedia.com/blog/linkedin-video-specs)
- [LinkedIn Caption Best Practices](https://www.opus.pro/blog/linkedin-video-caption-subtitle-best-practices)
- [Multicam Interview Best Practices](https://beverlyboy.com/film-technology/multi-cam-interview-setup-gear-angles-and-tips/)
- [MoviePy](https://github.com/Zulko/moviepy) — Python video editing
- [AI Video Editing 2026 Overview](https://cutback.video/blog/ai-video-editing-in-2026-best-tools-workflows-automation-explained)
