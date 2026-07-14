#!/usr/bin/env python3
"""
ec2-build-from-queue.py ,  Reads ec2-build-queue.json and builds each video.

Runs on EC2 (/opt/secondbrain/). Builds all videos in the queue that do not
already have a completed final.mp4, then writes results to build_manifest.json.

Fixes over build-videos.py:
- Stock footage is always looped to voice duration (never short)
- ASS captions offset by thumb card duration (0.25s)
- Grok Aurora (xAI) thumbnails for all videos
- Music mix from MUSIC_MAP in empire config
- No -shortest flag ,  explicit -t duration prevents truncation

Usage:
  python3 /opt/secondbrain/scripts/ec2-build-from-queue.py
  python3 /opt/secondbrain/scripts/ec2-build-from-queue.py --id ai_agent_income_formula
"""

import os
import re
import sys
import json
import time
import subprocess
import textwrap
from pathlib import Path

WORK_DIR = Path("/opt/secondbrain/data/youtube/build")
CONFIG_PATH = Path("/opt/secondbrain/empire/config.json")
QUEUE_PATH = Path("/opt/secondbrain/scripts/ec2-build-queue.json")
MANIFEST_PATH = WORK_DIR / "build_manifest.json"
PROPOSALS_DIR_LOCAL = Path("/opt/secondbrain/data/agent/shorts-proposals")
FONT_PATH = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"

# Content-review approval manifest. This is where the briefing dashboard
# records ExampleCo's reject-with-feedback note (video_rejection_note /
# thumbnail_rejection_note). The build reads it so a regenerated video
# actually ExampleCos ExampleCo's feedback into the render. Resolve both the EC2
# deploy path and the local repo path so the script works in both runtimes.
_REPO_ROOT = Path(__file__).resolve().parent.parent
REVIEW_MANIFEST_CANDIDATES = [
    Path("/opt/secondbrain/content-review/pending/manifest.json"),
    _REPO_ROOT / "content-review" / "pending" / "manifest.json",
]


_REQUESTS = None


def requests_client():
    """Import requests only for network-backed build paths.

    Unit tests import this module to exercise pure helpers. Those imports must
    not fail just because the local Python environment lacks EC2 runtime deps.
    """
    global _REQUESTS
    if _REQUESTS is None:
        try:
            import requests as imported_requests
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "The requests package is required for network-backed video build steps. "
                "Install requests in the Python environment used to run ec2-build-from-queue.py."
            ) from exc
        _REQUESTS = imported_requests
    return _REQUESTS


def load_rejection_feedback(vid_id):
    """Return the latest reject-with-feedback note ExampleCo left for this video.

    Looks up the content-review pending manifest and returns a dict with
    {video, thumbnail} rejection notes (empty strings when none). This is
    the feedback ExampleCo types in the dashboard 'Reject and regen' box; before
    2026-05-18 it was stored but never read on regeneration, so ExampleCo's
    feedback was silently dropped on every rebuild.
    """
    out = {"video": "", "thumbnail": ""}
    for path in REVIEW_MANIFEST_CANDIDATES:
        try:
            if not path.exists():
                continue
            data = json.loads(path.read_text())
        except Exception as exc:
            print(f"  [feedback] could not read {path}: {str(exc)[:120]}")
            continue
        for entry in data.get("videos", []):
            if entry.get("id") != vid_id:
                continue
            out["video"] = (entry.get("video_rejection_note") or "").strip()
            out["thumbnail"] = (entry.get("thumbnail_rejection_note") or "").strip()
            return out
    return out

W, H = 1080, 1920
JESSICA_ID = "cgSgspJ2msm6clMCkdW9"

# 2026-05-05 ExampleCo #learn: thumbnail card is a single-frame flash, not 0.25s.
# At 30 fps, 1/30 = 0.0333... s = exactly one frame. Below human perception
# but still the first decoded frame YouTube grabs for share previews. The
# previous 0.25s value was perceptibly visible as a cut at the start.
# Caption offset must match this so word timestamps align to the body.
THUMBNAIL_CARD_DURATION_S = 1.0 / 30.0   # one frame at 30 fps
VOICE_LEAD_PAD_S = 0.45

TRANSCRIPT_WORD_CORRECTIONS = {
    "clod": "Claude",
    "claud": "Claude",
}

TOOLS_TRANSCRIPT_WORD_CORRECTIONS = {
    "alama": "Ollama",
    "olama": "Ollama",
    "codalama": "CodeLlama",
    "codelama": "CodeLlama",
}

EMPHASIS_WORDS = {
    'million', 'billion', 'free', 'viral', 'hack', 'views', 'money', 'banned',
    'first', 'zero', 'never', 'always', 'secret', 'real', 'quit', 'bitcoin',
    'crypto', 'ai', 'claude', 'leaked', 'exposed', 'failed', 'every', 'none',
    'all', 'destroyed', 'accidentally', 'free', 'nine', 'doubled', 'change',
    'broke', 'breaks', 'beats', 'beat', 'best', 'worst', 'dream', 'dreams',
}

# Locked 2026-05-03 from ExampleCo's 6th rejection on nine_free_ai_tools_2026:
# "you have to number them like I said, also narrative/sound is crackly in
# some places and there's no viral/pleasant music behind." Three production
# rules now enforced in the assemble step:
#   1. Every video gets a music bed mixed under the voice. No more voice-only.
#      The ducking ratio is locked at 0.18 so the voice stays dominant but
#      the bed is clearly present (not buried).
#   2. List-style videos (title starts with a number) get bold numbered
#      overlays at the top of the screen for each item, popped in at the
#      timestamp the voice names that item. "1. GAMMA", "2. PERPLEXITY", etc.
#      The overlay is yellow #FFD23F with a black stroke so it pops.
#   3. The voice is treble-rolled-off + de-essed before mixing, and the
#      whole final track is loudness-normalized to -16 LUFS so the audio
#      stops sounding crackly. Existing humanize_voice() only added
#      compression which can amplify hiss; we now follow it with a low-pass
#      at 12kHz + de-esser to kill the high-band crackle.
# Locked 2026-05-03 (v4) after ExampleCo's rejection of the placeholder
# bright_upbeat.mp3 ("annoying drone sound") and the unauthorized
# HoliznaCC0 swap ("are you sure that one was in the approved list").
# The 12 tracks below were SSH-pulled from owner@openclaw at
# /home/owner/.openclaw/workspace/empire/assets/sounds/ and match
# the curated approval list in
# openclaw-archive/extracted/empire/intelligence/music/sound_library.md.
# Each MUSIC_MAP entry references one of those approved filenames; the
# build script verifies the file is at >= 100 KB and >= 120 kbps via
# ffprobe before mixing so a future placeholder swap fails loud.
MUSIC_MAP = {
    "tech":     ("tech_futuristic.mp3",    0.20),  # AI agent demos, Cursor/Claude tool videos
    "ai":       ("motivational_trap.mp3",  0.18),  # AI tools lists (sound_library.md "Best For" exact match)
    "income":   ("motivational_trap.mp3",  0.18),  # success / income content, energetic
    "story":    ("upbeat_hopeful_world.mp3", 0.20),  # Jain-Alright brand vibe, warm world-pop
    "kids":     ("kids_lullaby_piano_60s.mp3", 0.18),  # bedtime stories ONLY
    "serious":  ("dark_cinematic_inception.mp3", 0.16),  # OYU, deep/profound content
    "lofi":     ("lofi_chill.mp3",         0.20),  # study/productivity
    "epic":     ("epic_orchestral.mp3",    0.18),  # big reveal moments
    "hopeful":  ("hopeful_piano.mp3",      0.20),  # Kind Spotlight, empowerment
    "default":  ("motivational_trap.mp3",  0.18),
}
MUSIC_DIR = Path("/opt/secondbrain/empire/assets/sounds")

# Words to skip when picking list-item names from the transcription (common
# english words that capitalize but aren't tool names).
LIST_ITEM_STOPWORDS = {
    "THE", "A", "AN", "THIS", "THAT", "THESE", "THOSE", "YOUR", "YOU", "I",
    "WE", "US", "THEY", "THEM", "IT", "AND", "OR", "BUT", "FOR", "WITH",
    "FROM", "INTO", "UPON", "AS", "AT", "BY", "TO", "OF", "IN", "ON",
    "ALL", "NINE", "TEN", "FIVE", "SEVEN", "EIGHT", "FOUR", "THREE", "TWO",
    "FREE", "AI", "TOOLS", "TOOL", "STEP", "STEPS", "WAY", "WAYS", "THINGS",
    "REAL", "TIME", "ANY", "EVERY", "FIRST", "LAST", "STUDIO", "VOICE",
    "FULL", "ABOUT", "HALF", "DOES", "DOESN'T",
}

def load_config():
    return json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}


# -- Rejection-aware regeneration --------------------------------------------

def load_regen_feedback_file(vid_id):
    """Read the regen_feedback.json hand-off written by auto-regen-rejected-videos.js.

    This file ExampleCos structured rejection context (notes, directives, overrides)
    across the JS/Python process boundary so the build is never feedback-blind.
    """
    for base in [WORK_DIR, _REPO_ROOT / "content-review" / "pending"]:
        fb_path = base / vid_id / "regen_feedback.json"
        if fb_path.exists():
            try:
                return json.loads(fb_path.read_text())
            except Exception as exc:
                print(f"  [feedback] could not parse {fb_path}: {str(exc)[:120]}")
    return None


def get_rejection_note(spec):
    """Return the rejection feedback for this spec, if any.

    A rejected video is re-queued with a `rejection_note` field (set by the
    content-review reject flow). The legacy `video_rejection_note` /
    `thumbnail_rejection_note` fields and the REJECTION_NOTE env var are also
    honored so a single-id rebuild can be triggered directly.
    """
    note = (spec.get("rejection_note")
            or spec.get("video_rejection_note")
            or spec.get("thumbnail_rejection_note")
            or os.environ.get("REJECTION_NOTE", ""))
    return (note or "").strip()


def hydrate_spec_from_proposal(spec):
    """Fill missing queue fields from the original approved proposal.

    Rejection-regeneration must never build from an empty queue script. If the
    old queue row lost `script` or `stock_queries`, recover them from the
    timestamped shorts proposal JSON before generating voice/video.
    """
    spec = dict(spec or {})
    if (spec.get("script") or "").strip() and spec.get("stock_queries"):
        return spec
    vid_id = spec.get("id")
    if not vid_id:
        return spec
    try:
        files = sorted(PROPOSALS_DIR_LOCAL.glob("*.json"), reverse=True)
    except Exception:
        files = []
    for path in files:
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        for proposal in data.get("proposals", []) or []:
            if proposal.get("id") != vid_id:
                continue
            for key in ("script", "stock_queries", "stock_query", "music", "title", "channel"):
                if not spec.get(key) and proposal.get(key):
                    spec[key] = proposal.get(key)
            return spec
    return spec


def script_derived_terms(script, limit=12):
    """Extract content words that actually appear in the narration script.

    Intro/overlay cards and animation prompts must be grounded in this set,
    never invented. Returns lowercased significant words from the script.
    """
    import re as _re
    stop = {
        'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
        'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'this',
        'that', 'it', 'its', 'as', 'so', 'now', 'all', 'her', 'his', 'she',
        'he', 'they', 'you', 'your', 'their', 'what', 'who', 'how', 'them',
        'has', 'had', 'have', 'will', 'can', 'just', 'not', 'no', 'into',
    }
    words = _re.findall(r"[A-Za-z0-9']+", (script or "").lower())
    seen, terms = set(), []
    for w in words:
        if len(w) < 3 or w in stop or w in seen:
            continue
        seen.add(w)
        terms.append(w)
        if len(terms) >= limit:
            break
    return terms


def card_text_from_script(title, script):
    """Card / overlay text MUST come from the script or title, never invented.

    Returns the title only if every significant word in it is present in the
    script (or is itself in the script). Otherwise falls back to the first
    sentence of the script so the card never says something the video doesn't.
    """
    import re as _re
    script = script or ""
    title = (title or "").strip()
    if not title:
        first = _re.split(r"(?<=[.!?])\s+", script.strip())
        return first[0][:70] if first and first[0] else ""
    script_words = set(script_derived_terms(script, limit=200))
    title_words = [w for w in _re.findall(r"[A-Za-z0-9']+", title.lower())
                   if len(w) >= 4]
    grounded = all(w in script_words for w in title_words) if title_words else True
    if grounded:
        return title
    # Title drifted from the script: use the script's own opening line.
    first = _re.split(r"(?<=[.!?])\s+", script.strip())
    return (first[0][:70] if first and first[0] else title)


def run(cmd, check=False, **kwargs):
    # Timeout bumped from 600s to 1500s 2026-05-03: chained ass-subtitle
    # filters (captions.ass + overlays.ass) on the assemble step push the
    # encode time over 600s on EC2 t3-class instances. The previous limit
    # silently truncated the final.mp4 mid-encode.
    #
    # check=False by default so every existing caller keeps its current
    # behavior (many run() calls have their own .exists()/fallback handling and
    # must NOT raise -- e.g. the music-mix voice-only fallback). Pass check=True
    # on critical steps that have no fallback (the final assembly): there a
    # non-zero ffmpeg exit that leaves a partial/truncated file on disk would
    # otherwise sail past the downstream `.exists()` check and be reported as a
    # false success ("claimed success but no valid mp4"). Raising surfaces it.
    timeout = kwargs.get("timeout", 1500)
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        print(f"  CMD FAILED [{result.returncode}]: {cmd[:80]}")
        print(f"  STDERR: {result.stderr[:300]}")
        if check:
            raise RuntimeError(
                f"command failed with exit {result.returncode}: {cmd[:120]} :: "
                f"{(result.stderr or '')[:300]}"
            )
    return result

def load_manifest():
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text())
        except Exception:
            return {}
    return {}

def save_manifest(data):
    MANIFEST_PATH.write_text(json.dumps(data, indent=2))


def build_exit_code(failed, target_id, built):
    """Exit code for a build run.

    Non-zero on ANY failure so a caller (auto-regen-rejected-videos.js) never
    reads a swallowed build error as success. A requested --id / --spec-file
    target that produced nothing built (e.g. the id was absent from the queue
    and no spec was injected) is also a failure, not a silent 0.
    """
    if failed or (target_id and target_id not in built):
        return 1
    return 0


def merge_injected_spec(queue, injected_spec):
    """Merge a caller-supplied spec (from --spec-file) into the in-memory queue.

    Lets a daily-generated id that is NOT present in the transient
    ec2-build-queue.json still build: replaces the existing row with the same
    id when present, otherwise appends. Mutates only the in-memory dict (the
    on-disk queue file is never rewritten, so concurrent runs do not race).
    Returns the injected id.
    """
    inj_id = injected_spec["id"]
    vids = queue.setdefault("videos", [])
    if any(s.get("id") == inj_id for s in vids):
        queue["videos"] = [injected_spec if s.get("id") == inj_id else s for s in vids]
    else:
        vids.append(injected_spec)
    return inj_id


# ── Voice Generation ──────────────────────────────────────────────────────────

POLLY_VOICE_ID = os.environ.get("POLLY_VOICE_ID", "Danielle")
POLLY_REGION = os.environ.get("POLLY_REGION", "us-east-1")


def _polly_synthesize(script, out_path):
    """Fallback TTS via AWS Polly using the EC2 instance role.

    Used when no ElevenLabs key is configured or the ElevenLabs call fails.
    Polly's SynthesizeSpeech caps input at 3000 chars, so long scripts are
    chunked on sentence boundaries and concatenated with ffmpeg.
    """
    import re as _re
    chunks = []
    buf = ""
    for sentence in _re.split(r'(?<=[.!?])\s+', script.strip()):
        if not sentence:
            continue
        if len(buf) + len(sentence) + 1 > 2800 and buf:
            chunks.append(buf)
            buf = sentence
        else:
            buf = (buf + " " + sentence).strip()
    if buf:
        chunks.append(buf)
    if not chunks:
        chunks = [script.strip() or "."]

    part_paths = []
    for i, chunk in enumerate(chunks):
        part = f"{out_path}.polly{i}.mp3"
        res = subprocess.run(
            ["aws", "polly", "synthesize-speech",
             "--text", chunk,
             "--output-format", "mp3",
             "--voice-id", POLLY_VOICE_ID,
             "--engine", "neural",
             "--region", POLLY_REGION,
             part],
            capture_output=True, text=True, timeout=120,
        )
        if res.returncode != 0 or not Path(part).exists():
            raise RuntimeError(f"Polly synthesize failed: {res.stderr[:300]}")
        part_paths.append(part)

    if len(part_paths) == 1:
        Path(part_paths[0]).replace(out_path)
    else:
        concat_list = f"{out_path}.concat.txt"
        Path(concat_list).write_text(
            "\n".join(f"file '{p}'" for p in part_paths))
        run(f'ffmpeg -y -f concat -safe 0 -i {concat_list} -c copy {out_path}')
        for p in part_paths:
            try:
                Path(p).unlink()
            except Exception:
                pass
        try:
            Path(concat_list).unlink()
        except Exception:
            pass
    size = Path(out_path).stat().st_size if Path(out_path).exists() else 0
    print(f"  Voice (Polly/{POLLY_VOICE_ID}): {size} bytes → {out_path}")


def generate_voice(script, out_path, config, voice_id_override=None):
    # 2026-05-18 ExampleCo: the narration voice MUST stay the original Amy voice
    # (ElevenLabs Jessica, cgSgspJ2msm6clMCkdW9). On 2026-05-17 a Polly
    # "Danielle" fallback was added here; when ElevenLabs hit a transient
    # error the build silently shipped a different-sounding voice and ExampleCo
    # heard the wrong narrator. AWS Polly is a different voice, not Amy, so
    # it can never be a transparent substitute.
    #
    # Correct behavior: retry ElevenLabs on transient failures, and if it
    # still cannot produce the Jessica voice, FAIL LOUD. A loud failure lets
    # auto-regen-rejected-videos.js classify the error (it already buckets
    # ElevenLabs 401s) and retry, instead of promoting a wrong-voice video
    # into ExampleCo's approval queue. Polly is only used when ALLOW_POLLY_VOICE=1
    # is explicitly set (kept as an escape hatch, off by default).
    key = config.get("elevenlabs_api_key", "")
    if not key:
        if os.environ.get("ALLOW_POLLY_VOICE") == "1":
            print("  No ElevenLabs key configured; ALLOW_POLLY_VOICE=1 set, using AWS Polly.")
            _polly_synthesize(script, out_path)
            return
        raise RuntimeError(
            "ElevenLabs API key not configured and ALLOW_POLLY_VOICE is not set. "
            "Refusing to ship a non-Amy voice. Set elevenlabs_api_key in empire-config.json."
        )
    # 2026-05-25 ExampleCo #learn: when the rejection history says the voice
    # changed, the interpreter sets voice_id_override on the spec; the
    # caller passes it through here. Falls back to JESSICA_ID (the
    # original Amy voice) when no override is provided.
    voice_id = (voice_id_override or "").strip() or JESSICA_ID
    last_err = ""
    for attempt in range(1, 4):
        try:
            r = requests_client().post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                headers={"xi-api-key": key, "Content-Type": "application/json"},
                json={"text": script, "model_id": "eleven_turbo_v2_5",
                      "voice_settings": {"stability": 0.40, "similarity_boost": 0.60,
                                         "style": 0.45, "use_speaker_boost": False}},
                timeout=120
            )
            if r.status_code >= 400:
                body = (r.text or "").replace("\n", " ")[:500]
                raise RuntimeError(f"{r.status_code} ElevenLabs error: {body}")
            r.raise_for_status()
            Path(out_path).write_bytes(r.content)
            voice_label = "Jessica" if voice_id == JESSICA_ID else f"override {voice_id}"
            print(f"  Voice (ElevenLabs {voice_label}): {len(r.content)} bytes -> {out_path}")
            return
        except Exception as e:
            last_err = str(e)[:500]
            print(f"  ElevenLabs TTS attempt {attempt}/3 failed ({last_err})")
            if attempt < 3:
                time.sleep(2 * attempt)
    if os.environ.get("ALLOW_POLLY_VOICE") == "1":
        print(f"  ElevenLabs exhausted ({last_err}); ALLOW_POLLY_VOICE=1, using AWS Polly fallback.")
        _polly_synthesize(script, out_path)
        return
    raise RuntimeError(
        f"ElevenLabs TTS failed after 3 attempts ({last_err}). Refusing to fall "
        f"back to a non-Amy voice. Fix the ElevenLabs key/quota and retry the "
        f"build, or set ALLOW_POLLY_VOICE=1 to explicitly accept the Polly voice."
    )

def prepare_voice_script(text):
    text = (text or "").lstrip()
    if text.lower().startswith("ai "):
        return "A.I. " + text[3:]
    return text

def humanize_voice(inp, out):
    run(f'ffmpeg -y -i {inp} '
        f'-af "acompressor=threshold=-18dB:ratio=3:attack=10:release=100,'
        f'equalizer=f=3000:t=q:w=1:g=2,equalizer=f=200:t=q:w=1:g=-1" '
        f'{out}')
    return out if Path(out).exists() else inp

def add_voice_lead_pad(inp, out, pad_s=VOICE_LEAD_PAD_S):
    """Add a tiny inaudible lead pad so the first phoneme is not clipped.

    ExampleCo rejected short009 on 2026-05-07 because the opening "AI" was cut off.
    120ms is below the awkward-silence threshold but gives mobile players and
    encoders enough preroll to preserve the first syllable.
    """
    pad_ms = max(0, int(round(pad_s * 1000)))
    boost_until = max(pad_s + 0.35, pad_s)
    filter_chain = (
        f"adelay={pad_ms}:all=1,"
        f"volume=volume=1.25:enable='between(t,0,{boost_until:.2f})'"
    )
    run(f'ffmpeg -y -i {inp} -af "{filter_chain}" -c:a libmp3lame -q:a 2 {out}')
    return out if Path(out).exists() else inp

def voice_duration(path):
    r = run(f"ffprobe -v quiet -show_entries format=duration -of csv=p=0 {path}")
    try:
        return float(r.stdout.strip())
    except Exception:
        return 30.0

def correct_transcript_words(words, script_text=""):
    script_lower = (script_text or "").lower()
    corrected = []
    for w in words or []:
        item = dict(w)
        raw = (item.get("word") or "").strip()
        key = raw.lower().strip(".,!?'\"")
        if "claude" in script_lower and key in TRANSCRIPT_WORD_CORRECTIONS:
            item["word"] = TRANSCRIPT_WORD_CORRECTIONS[key]
        elif ("ollama" in script_lower or "codelama" in script_lower or "codellama" in script_lower) and key in TOOLS_TRANSCRIPT_WORD_CORRECTIONS:
            item["word"] = TOOLS_TRANSCRIPT_WORD_CORRECTIONS[key]
        elif "vs code extension" in script_lower and key == "continue":
            item["word"] = "Continue"
        corrected.append(item)
    return corrected


# ── Captions (Groq Whisper) ───────────────────────────────────────────────────

def transcribe_words(audio_path, groq_key):
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {groq_key}"}
    with open(audio_path, "rb") as f:
        resp = requests_client().post(url, headers=headers,
                             files={"file": f},
                             data={"model": "whisper-large-v3-turbo",
                                   "response_format": "verbose_json",
                                   "timestamp_granularities[]": "word"},
                             timeout=120)
    resp.raise_for_status()
    words = resp.json().get("words", [])
    print(f"  Captions: {len(words)} words transcribed")
    return words


# Filler words floored at score 0 so the emphasis pass never highlights
# them (the eye glues to garbage and trains itself to ignore the highlight).
# Locked in scheduled-tasks/captions-aurora/SKILL.md.
_CAPTION_FILLERS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "of", "in", "on", "at", "to", "for", "and", "or", "but", "if", "that",
    "this", "it", "you", "i", "we", "they", "he", "she", "his", "her",
    "their", "our", "my", "your", "its", "as", "with", "from", "by",
    "into", "upon", "do", "does", "did", "have", "has", "had", "will",
    "would", "could", "should", "may", "might", "can", "so", "than",
    "then", "there",
}


def _claude_cli_path():
    """Resolve the claude-code cli.js for the Claude Max emphasis scoring call.
    Same dual-path approach used elsewhere (local dev vs EC2 deploy)."""
    import os as _os
    candidates = [
        _os.path.expanduser("~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        _os.path.join(_os.environ.get("USERPROFILE", _os.path.expanduser("~")),
                      "AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js"),
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def score_emphasis_with_claude(words, script_text):
    """Score every transcribed word for visual emphasis. Returns a set of
    indices into `words` that should be highlighted (top 20% by score).

    Per scheduled-tasks/captions-aurora/SKILL.md: free Claude Max call,
    one per video. Falls back to a hardcoded EMPHASIS_WORDS list if the
    CLI is unreachable so the build never blocks on the LLM.
    """
    target_pct = 0.20
    target_count = max(1, int(round(len(words) * target_pct)))
    cli = _claude_cli_path()
    if not cli:
        print("  [emphasis] claude cli not found, falling back to hardcoded list")
        return _legacy_emphasis_indices(words)

    word_list = [(i, (w.get("word") or "").strip()) for i, w in enumerate(words)]
    transcript_blob = "\n".join(f"{i}\t{wd}" for i, wd in word_list)

    prompt = (
        "Score every word in this YouTube Shorts transcript for visual "
        "emphasis. The TOP 20% (~"
        + str(target_count) + " words) will be highlighted in green on screen.\n\n"
        "RULES (apply in order):\n"
        "1. Filler words (the, a, an, is, are, was, were, be, of, in, on, at,\n"
        "   to, for, and, or, but, that, this, it, you, I, we, they, he, she)\n"
        "   ALWAYS score 0.0.\n"
        "2. Numbers and number-words (any digits, first, second, billion,\n"
        "   thirty, ten) -> 0.85+\n"
        "3. Brand / tool / proper nouns (Claude, GPT, GitHub, Copilot, Ollama,\n"
        "   ChatGPT, NotebookLM, n8n, Perplexity) -> 0.85+\n"
        "4. Surprise / urgency words (free, never, always, secret, viral,\n"
        "   banned, leaked, exposed, broke, broken, crashed, destroyed,\n"
        "   accidentally, zero, nobody, everyone, instantly, forever) -> 0.80+\n"
        "5. Strong verbs (cancel, replace, kill, save, double, halve, steal,\n"
        "   expose, ditch, switch, automate, generate, audit) -> 0.65 to 0.80\n"
        "6. Strong topic-specific nouns (subscription, prompt, agent, workflow,\n"
        "   transcript, dashboard, pipeline) -> 0.55 to 0.75\n"
        "7. Generic content words -> 0.30 to 0.50\n"
        "8. Pronouns / determiners that escaped rule 1 -> 0.10\n\n"
        "OUTPUT: a JSON array of objects [{\"i\": index, \"s\": score}, ...] in the\n"
        "same order as input. ONLY the JSON array. No prose. No markdown fences.\n"
        "Start with [ end with ].\n\n"
        "FULL SCRIPT for context:\n"
        + (script_text or "")[:2000] + "\n\n"
        "WORDS (one per line, format: index<TAB>word):\n"
        + transcript_blob
    )

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    try:
        r = subprocess.run(
            [sys.executable.replace("python3", "node") if sys.executable.endswith("python3") else "node",
             cli, "--model", "claude-haiku-4-5-20251001", "-p", prompt],
            capture_output=True, text=True, timeout=180, env=env,
        )
        if r.returncode != 0 or not r.stdout:
            print(f"  [emphasis] claude cli exit={r.returncode}, falling back")
            return _legacy_emphasis_indices(words)
        out = r.stdout.strip()
        lb, rb = out.find("["), out.rfind("]")
        if lb < 0 or rb <= lb:
            print("  [emphasis] no JSON array in claude output, falling back")
            return _legacy_emphasis_indices(words)
        scored = json.loads(out[lb:rb + 1])
        # Force fillers to 0 even if the LLM scored them.
        for item in scored:
            wd = (words[item["i"]].get("word") or "").strip().lower().strip(".,!?'\"")
            if wd in _CAPTION_FILLERS:
                item["s"] = 0.0
        scored.sort(key=lambda x: -x.get("s", 0))
        top = {item["i"] for item in scored[:target_count]}
        rate = len(top) / max(1, len(words))
        print(f"  [emphasis] scored via Claude, {len(top)}/{len(words)} words = {rate*100:.1f}% green (target 20%)")
        return top
    except Exception as e:
        print(f"  [emphasis] claude scoring exception: {e}, falling back")
        return _legacy_emphasis_indices(words)


def _legacy_emphasis_indices(words):
    """Fallback emphasis selection. Uses the hardcoded EMPHASIS_WORDS list
    expanded to ~20% via length + caps heuristics. Worse than Claude but
    keeps the build moving when the LLM is unreachable."""
    out = set()
    for i, w in enumerate(words):
        word = (w.get("word") or "").strip().lower().strip(".,!?'\"")
        if not word or word in _CAPTION_FILLERS:
            continue
        if word in EMPHASIS_WORDS or len(word) >= 8 or word.isupper():
            out.add(i)
    return out


def write_ass(words, ass_path, thumb_offset=THUMBNAIL_CARD_DURATION_S, emphasis_indices=None):
    """Hormozi/MrBeast-style kinetic captions.

    Each word is a single Dialogue event with libass animation overrides:
      - 60ms fade in / 60ms fade out (\\fad)
      - Scale punch 100 -> 115 -> 100 over the first 250ms (\\t...fscx,\\fscy)
      - Slight y-bounce on entry (\\t...pos)
      - Top-20% emphasis words are bright yellow (#FFFF00) and slightly larger
        with a longer scale-pulse hold; rest are pure white.
      - All anchored at upper-third center (an5 + pos 540,1500), Impact font.
        Falls back to DejaVu Sans Bold on EC2 / Linux where Impact is missing.

    Locked 2026-05-05 by ExampleCo ("the word popping up is crap, do way better").
    Skill spec: scheduled-tasks/captions-aurora/SKILL.md.
    """
    if not words:
        return None
    if emphasis_indices is None:
        emphasis_indices = set()
    # 2026-05-06 ExampleCo #learn: revert emphasis color from yellow to green.
    # The prior write_ass used &H0088FF00 (BGR neon green) and ExampleCo
    # explicitly liked it. The Hormozi-style yellow rewrite was a
    # regression I introduced reading literature instead of checking his
    # standing preference. Green is the SecondBrain canonical emphasis
    # color across captions and animations.
    WHITE, GREEN, OUTLINE = "&H00FFFFFF", "&H0088FF00", "&H00000000"

    def fmt(t):
        h, m = int(t // 3600), int((t % 3600) // 60)
        s, cs = int(t % 60), int((t % 1) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    # Impact is the Hormozi/MrBeast canonical font. Linux EC2 typically lacks
    # it; libass falls back through fontconfig. We declare both Impact and
    # DejaVu Sans so libass picks the first available.
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        # An Alignment=5 (an5) means center-anchored. MarginV is unused with an5+pos.
        # Outline 8px black + Shadow 4px = strong legibility on any bg.
        f"Style: Kinetic,Impact,120,{WHITE},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,8,4,5,0,0,0,1\n"
        f"Style: KineticEm,Impact,140,{GREEN},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,9,5,5,0,0,0,1\n"
        f"Style: KineticLong,Impact,90,{WHITE},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,7,4,5,0,0,0,1\n"
        f"Style: KineticEmLong,Impact,100,{GREEN},&H000000FF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,8,5,5,0,0,0,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    events = []
    em_count = 0
    for i, w in enumerate(words):
        word = (w.get("word") or "").strip()
        start = w.get("start", 0) + thumb_offset
        end = w.get("end", start + 0.3) + thumb_offset
        if not word:
            continue
        is_em = (i in emphasis_indices) if emphasis_indices else (
            word.lower().strip(".,!?'\"") in EMPHASIS_WORDS
        )
        is_long = len(word) > 12
        style = ("KineticEmLong" if is_em and is_long else
                 "KineticEm" if is_em else
                 "KineticLong" if is_long else "Kinetic")
        if is_em:
            em_count += 1

        # Per-word duration in ms for the scale animation timeline.
        dur_ms = max(150, int((end - start) * 1000))
        # Scale punch: 70 -> 115 -> 100 over first ~250ms, then hold.
        # Emphasis words get a stronger punch (130) and a color-flash from
        # white-edge to yellow over the same window.
        peak_scx = 130 if is_em else 115
        # Y-bounce: slide up from y=1540 to y=1500 in the first 200ms.
        # That gives a springy entrance without leaving the upper-third anchor.
        # Position is set via \pos to override the style's MarginV.
        overrides = (
            r"{\an5\pos(540,1500)"
            r"\fad(60,60)"
            f"\\t(0,200,\\fscx{peak_scx}\\fscy{peak_scx})"
            r"\t(200,300,\fscx100\fscy100)"
            r"\move(540,1540,540,1500,0,200)"
            r"}"
        )

        esc = word.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        events.append(
            f"Dialogue: 0,{fmt(start)},{fmt(end)},{style},,0,0,0,,{overrides}{esc}"
        )

    Path(ass_path).write_text(header + "\n".join(events) + "\n")
    rate = (em_count / len(events)) if events else 0
    band_ok = 0.15 <= rate <= 0.25
    flag = "OK" if band_ok else "OUT-OF-BAND"
    print(
        f"  ASS: {len(events)} kinetic events, {em_count} green ({rate*100:.1f}%, target 20%, {flag}) -> {ass_path}"
    )
    return ass_path


# ── Thumbnail (Bedrock Stable Image Ultra via thumbnail_aurora skill) ─────────
# 2026-05-04 ExampleCo #learn: we already have a proven thumbnail skill at
# src/main/empire/thumbnail_aurora.py (Bedrock Stable Image Ultra, gated
# verification, retry logic, 537 lines, tests). The prior code here called
# Grok at https://api.x.ai/v1/images/generations with model grok-2-image,
# which returned 404 every time and silently fell back to a colored
# gradient. Both the SKILL.md and the implementation existed for a week
# before this build script started using them. The lesson: ALWAYS search
# for proven skills/repos before building from scratch
# (memory/feedback_use_proven_skills_first.md).

def grok_thumbnail(title, out_path, config):
    """Generate a thumbnail by delegating to the proven thumbnail_aurora skill.

    Function name kept as `grok_thumbnail` so existing callers keep working
    without churn; the implementation now invokes the working Bedrock
    pipeline. Returns the path to the generated thumbnail or falls back
    to bright_gradient_thumbnail only if Bedrock itself fails.
    """
    # Resolve the skill path. Same dual-path candidates as elsewhere in
    # this file for local dev vs EC2 deploy.
    candidates = [
        Path("/opt/secondbrain/src/main/empire/thumbnail_aurora.py"),
        Path(__file__).resolve().parent.parent / "src" / "main" / "empire" / "thumbnail_aurora.py",
    ]
    skill = next((c for c in candidates if c.exists()), None)
    if skill is None:
        print("  [thumb] thumbnail_aurora.py not found, using bright gradient fallback")
        return bright_gradient_thumbnail(title, out_path)

    # Derive a video id from the output path (the dirname matches the build id).
    video_id = Path(out_path).parent.name or "shorts_thumb"

    print(f"  [thumb] Bedrock Stable Image Ultra via thumbnail_aurora.py")
    try:
        r = subprocess.run(
            [sys.executable, str(skill),
             "--id", video_id,
             "--title", title,
             "--channel", "AILifeHacksByExampleCoyExampleCo",
             "--out", str(out_path)],
            capture_output=True, text=True, timeout=300,
        )
        if r.returncode == 0 and Path(out_path).exists():
            try:
                meta = json.loads(r.stdout)
                m = meta.get("metrics", {})
                print(f"  [thumb] OK: {meta.get('model')} seed={meta.get('seed')} "
                      f"lum={m.get('mean_luminance')} lr_mae={m.get('lr_mirror_mae')} "
                      f"size={m.get('size_kb')}KB")
            except Exception:
                pass
            return str(out_path)
        print(f"  [thumb] thumbnail_aurora exit {r.returncode}: {(r.stderr or r.stdout or '')[:300]}")
    except subprocess.TimeoutExpired:
        print("  [thumb] thumbnail_aurora timed out after 300s")
    except Exception as e:
        print(f"  [thumb] thumbnail_aurora exception: {e}")

    print("  [thumb] Falling back to bright gradient (NOT photoreal, will be visibly worse)")
    return bright_gradient_thumbnail(title, out_path)


def _thumb_passes_brightness_check(path):
    """Lightweight inline QC. Mirrors check-thumbnail-quality.py logic but
    runs in-process so we can retry before shipping a doomed artifact.
    Returns True if mean luminance >= 40 (matches the gate threshold)."""
    try:
        from PIL import Image
        img = Image.open(path).convert("RGB")
        # Sample-based mean luminance for speed.
        pixels = list(img.resize((64, 64), Image.LANCZOS).getdata())
        avg = sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels) / len(pixels)
        return avg >= 40
    except Exception:
        # If we can't inspect it, assume bad and let the upstream QC catch it.
        return False

def composite_text_thumbnail(bg_path, title, out_path):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.open(bg_path).convert("RGB")
    ratio = max(W / img.width, H / img.height)
    nw, nh = int(img.width * ratio), int(img.height * ratio)
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - W) // 2, (nh - H) // 2
    img = img.crop((left, top, left + W, top + H))

    # Dark gradient overlay
    overlay = Image.new("RGBA", (W, 900), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for y in range(900):
        od.line([(0, y), (W, y)], fill=(0, 0, 0, int(180 * (1 - y / 900))))
    img = img.convert("RGBA")
    img.alpha_composite(overlay, (0, 0))
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img)

    try:
        font_h = ImageFont.truetype(FONT_PATH, 110)
    except Exception:
        font_h = ImageFont.load_default()

    words = title.split()
    mid = max(1, len(words) // 2)
    lines = [" ".join(words[:mid]), " ".join(words[mid:])]
    y = 300
    for line in lines:
        for ox, oy, color in [(-4, -4, "black"), (4, 4, "black"), (0, 0, "white")]:
            draw.text((W // 2 + ox, y + oy), line, font=font_h, fill=color,
                      stroke_width=6, stroke_fill="black", anchor="mm")
        bbox = draw.textbbox((0, 0), line, font=font_h)
        y += (bbox[3] - bbox[1]) + 24

    img.save(str(out_path), "JPEG", quality=92)
    print(f"  Thumbnail (Grok Aurora): {out_path}")
    return str(out_path)

def gradient_thumbnail(title, out_path):
    """Legacy near-black gradient. Retained ONLY for tests that pin the
    historical behavior. Production code should call
    bright_gradient_thumbnail() -- this one fails the pixel-histogram QC
    gate by design (mean luminance ~10)."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (W, H), "#0a0a1e")
    draw = ImageDraw.Draw(img)
    for y in range(H):
        g = int(30 * (y / H))
        draw.line([(0, y), (W, y)], fill=(g // 3, g // 4, g))
    try:
        font = ImageFont.truetype(FONT_PATH, 88)
    except Exception:
        font = ImageFont.load_default()
    for i, line in enumerate(textwrap.wrap(title, width=16)):
        bbox = draw.textbbox((0, 0), line, font=font)
        x = (W - (bbox[2] - bbox[0])) // 2
        draw.text((x, 600 + i * 110), line, fill="white", font=font,
                  stroke_width=4, stroke_fill="black")
    img.save(str(out_path), "JPEG", quality=90)
    return str(out_path)


def bright_gradient_thumbnail(title, out_path):
    """Bright, colorful gradient fallback that passes the pixel-histogram QC
    gate (mean luminance > 80). Use this when Grok Aurora is unavailable or
    has exhausted retries. ExampleCo 2026-04-29: 'the briefing is Amy, the
    pipeline is the briefing, the fixes should be happening' -- so the
    fallback must produce a SHIPPABLE artifact, not a placeholder that
    invariably gets rejected.

    Composition: vibrant indigo-to-orange diagonal gradient with a softer
    radial highlight behind the title text. Hits all three RGB channels
    with mid-to-high values so the brightness check + variance check
    in check-thumbnail-quality.py both pass."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (W, H), (40, 60, 130))
    draw = ImageDraw.Draw(img)
    # Diagonal gradient: indigo top-left -> warm orange/red bottom-right.
    for y in range(H):
        t = y / H
        r = int(60 + (220 - 60) * t)   # 60 -> 220
        g = int(80 + (110 - 80) * t)   # 80 -> 110
        b = int(180 + (60 - 180) * t)  # 180 -> 60
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    # Soft radial highlight behind the title (cy ~ 750).
    cx, cy = W // 2, 750
    for radius in range(900, 0, -8):
        alpha = max(0, 90 - int(90 * (radius / 900)))
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            fill=(255, 240, 180, alpha),
        )
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(FONT_PATH, 96)
    except Exception:
        font = ImageFont.load_default()
    for i, line in enumerate(textwrap.wrap(title, width=14)):
        bbox = draw.textbbox((0, 0), line, font=font)
        x = (W - (bbox[2] - bbox[0])) // 2
        # White text with a strong black stroke so it reads against the
        # bright background.
        draw.text((x, 600 + i * 120), line, fill="white", font=font,
                  stroke_width=6, stroke_fill="black")
    img.save(str(out_path), "JPEG", quality=92)
    print(f"  [thumb] Wrote bright fallback: {out_path}")
    return str(out_path)


# ── Audio polish + music mixing (locked 2026-05-03) ──────────────────────────

def polish_voice(voice_in, voice_out):
    """De-ess + low-pass + final loudness normalization on the voice track.

    ExampleCo's rejection 2026-05-03 said the narration was crackly. The existing
    humanize_voice() applies a 3-band EQ that boosts 3kHz which can amplify
    sibilance + dither artifacts on the ElevenLabs MP3 source. This step:

      * de-essers the 5-9kHz sibilance band (compander attack 5ms release 50ms),
      * low-passes at 11.5kHz to drop dither hiss above the voice band,
      * applies a gentle wide-band compressor at -22dB to keep dynamics tight,
      * normalizes to -16 LUFS / -1.5 dBTP / 11 LRA so it sits at platform-
        standard loudness.

    The output is what gets mixed with music in mix_voice_with_music().
    """
    chain = (
        "lowpass=f=11500,"
        "compand=attacks=0.005:decays=0.05:points=-90/-90|-23/-23|-12/-15|0/-12,"
        "loudnorm=I=-16:TP=-1.5:LRA=11"
    )
    run(f'ffmpeg -y -i {voice_in} -af "{chain}" -c:a libmp3lame -q:a 2 {voice_out}')
    return voice_out if Path(voice_out).exists() else voice_in


def pick_music_track(spec):
    """Choose a music track from MUSIC_MAP based on spec metadata.

    Resolution order:
      1. spec["music"] explicit override (e.g. "bright_upbeat")
      2. spec["channel"] mapping (BedtimeStories -> kids, AILifeHacks -> ai)
      3. spec["style"] / spec["topic"] keyword match
      4. "default"
    """
    explicit = (spec.get("music") or "").strip()
    if explicit:
        for key, (fname, _) in MUSIC_MAP.items():
            if explicit.lower() in (key, fname.lower(), fname.replace(".mp3", "").lower()):
                return MUSIC_MAP[key]
        # explicit string isn't in the map, fall through

    channel = (spec.get("channel") or "").lower()
    if "bedtime" in channel or "kids" in channel:
        return MUSIC_MAP["kids"]
    # Match both AILifeHacks (legacy personal) and AILifeHacksByExampleCoyExampleCo (brand
    # channel, default per feedback_default_youtube_channel.md 2026-05-03).
    if "ailifehacks" in channel or "ai life" in channel:
        return MUSIC_MAP["ai"]
    if "pmstrategies" in channel:
        return MUSIC_MAP["serious"]

    blob = (spec.get("topic", "") + " " + spec.get("title", "") + " " +
            spec.get("style", "") + " " + spec.get("script", "")).lower()
    if any(k in blob for k in ("income", "money", "salary", "revenue", "$")):
        return MUSIC_MAP["income"]
    if any(k in blob for k in ("kids", "robot", "elephant", "whale", "dream")):
        return MUSIC_MAP["story"]

    return MUSIC_MAP["default"]


def mix_voice_with_music(voice_path, music_track, out_path, voice_dur):
    """Mix polished voice with looped, ducked music bed.

    music_track is a (filename, ratio) tuple from MUSIC_MAP.
    The music is looped to cover voice_dur + a short tail, side-chain compressed
    against the voice so it ducks under the voice automatically, and mixed at
    the configured ratio. Falls back to voice-only if the music file is missing
    so the build doesn't break in environments without the assets.
    """
    fname, ratio = music_track
    music_path = MUSIC_DIR / fname
    if not music_path.exists():
        print(f"  [music] {music_path} missing -- shipping voice-only (this WILL fail the music_presence rubric)")
        # Still produce out_path so the rest of the pipeline can use one path.
        run(f"ffmpeg -y -i {voice_path} -c:a aac -b:a 192k {out_path}")
        return out_path, False

    target = voice_dur + 1.0
    chain = (
        f"[0:a]volume=1.0[v];"
        f"[1:a]aloop=loop=-1:size=2e9,atrim=duration={target:.2f},"
        f"volume={ratio},afade=t=in:st=0:d=0.4,afade=t=out:st={max(0,target-0.6):.2f}:d=0.6[m];"
        f"[v][m]amix=inputs=2:duration=first:dropout_transition=0,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    )
    run(f'ffmpeg -y -i {voice_path} -i "{music_path}" '
        f'-filter_complex "{chain}" -map "[out]" -c:a aac -b:a 192k {out_path}')
    if not Path(out_path).exists():
        print(f"  [music] mix failed -- falling back to voice-only")
        run(f"ffmpeg -y -i {voice_path} -c:a aac -b:a 192k {out_path}")
        return out_path, False
    print(f"  [music] mixed with {fname} (ratio={ratio})")
    return out_path, True


# ── List-item detection + numbered overlays (locked 2026-05-03) ──────────────

LIST_TITLE_RE = __import__("re").compile(r"^\s*(\d{1,2})\s+([A-Za-z])")


def detect_list_count(title):
    """Return the count if the title is a list-style video (e.g. '9 Free AI Tools').
    None for non-list videos. Caps at 12 to keep overlays readable on Shorts."""
    m = LIST_TITLE_RE.match(title or "")
    if not m:
        return None
    n = int(m.group(1))
    if n < 2 or n > 12:
        return None
    return n


def extract_list_items(spec, words):
    """Find the N tool/item names + their start times from the transcribed
    word list.

    Heuristic: list-style videos read "GAMMA builds presentations from a
    single sentence. PERPLEXITY searches with real citations." -- the items
    are usually proper nouns at the start of clauses. We:
      1. Try spec["tool_list"] explicitly if provided.
      2. Otherwise scan the words for tokens that look like brand names
         (length 3+, not all digits, not in LIST_ITEM_STOPWORDS) and pick
         tokens that appear at the start of a clause (after a long pause
         from the previous word, or capitalized in the source script).
      3. Stop after collecting N items.
    Returns list of {"n": 1, "name": "GAMMA", "start": 7.96, "end": 9.32}.

    2026-05-06 ExampleCo: extended so that an explicit spec["tool_list"] / spec[
    "items"] / spec["list_items"] triggers the numbered overlay rendering
    EVEN WHEN the title does not match the list-pattern detector. Previously
    only "9 Free AI Tools"-style titles got overlays; now any video that
    declares a tool_list in its spec renders them too. Required for
    ai_agent_income_formula whose title "She Replaced Her $1,400/Month VA"
    does not pattern-match but ExampleCo explicitly wants 5 numbered tools shown.
    """
    explicit = spec.get("tool_list") or spec.get("items") or spec.get("list_items") or []
    if explicit:
        n = len(explicit)
    else:
        n = detect_list_count(spec.get("title", ""))
    if not n:
        return []
    HOOK_SKIP_SEC = 4.0  # promoted: used by both explicit-override and heuristic paths

    # Explicit override path. Try strict-then-fuzzy matching for each name.
    # If we still cannot place an item via word match (uncommon names get
    # mis-transcribed), distribute it evenly between the items we did find,
    # so the overlay shows the spec'd brand at an approximate timestamp
    # rather than failing back to the heuristic. The brand name on screen
    # is what ExampleCo asked for; the timestamp is best-effort when transcription
    # mangles it.
    explicit = spec.get("tool_list") or spec.get("items") or spec.get("list_items") or []
    if explicit and len(explicit) == n:
        def _fuzzy_match(token, target):
            """Token matches target if substring or 1-edit-distance prefix."""
            if not token or not target:
                return False
            if token == target or token.startswith(target) or target.startswith(token):
                return True
            # Tolerate 1 char difference in the first 5 chars (mis-hearings
            # like Yoodli -> Udli, Krea -> Kria, ElevenLabs -> Eleven Labs)
            ta = token[:5]
            tb = target[:5]
            if abs(len(ta) - len(tb)) > 1:
                return False
            edits = 0
            i = j2 = 0
            while i < len(ta) and j2 < len(tb):
                if ta[i] == tb[j2]:
                    i += 1; j2 += 1
                else:
                    edits += 1
                    if edits > 1:
                        return False
                    if len(ta) > len(tb):
                        i += 1
                    elif len(tb) > len(ta):
                        j2 += 1
                    else:
                        i += 1; j2 += 1
            return True

        items_matched = []  # (idx_in_explicit, j_in_words, start, end)
        idx = 0
        for i, name in enumerate(explicit):
            tgt_full = name.upper().strip(".,!?'\" ")
            tgt_first = tgt_full.split()[0]
            for j in range(idx, len(words)):
                token = (words[j].get("word") or "").upper().strip(".,!?'\"")
                if not token:
                    continue
                if _fuzzy_match(token, tgt_first) or _fuzzy_match(token, tgt_full):
                    start = float(words[j].get("start", 0))
                    end = float(words[j].get("end", start + 2.5))
                    items_matched.append((i, j, start, end, tgt_full))
                    idx = j + 1
                    break
        # Build the output items, filling missing positions by interpolation.
        if items_matched:
            # Build a mapping idx_in_explicit -> (start, end) for matched
            placed = {m[0]: (m[2], m[3]) for m in items_matched}
            # Compute fallback range from first/last matched start times
            voice_total_words = words[-1].get("end", 30.0) if words else 30.0
            first_t = items_matched[0][2]
            last_t = items_matched[-1][2]
            # If we got >= half the items matched, accept and interpolate
            if len(items_matched) >= max(2, n // 2):
                items = []
                for i, name in enumerate(explicit):
                    tgt_full = name.upper().strip(".,!?'\" ")
                    if i in placed:
                        start, end = placed[i]
                    else:
                        # Interpolate between last placed-before and next placed-after
                        before = max((mi for mi in placed if mi < i), default=None)
                        after = min((mi for mi in placed if mi > i), default=None)
                        if before is not None and after is not None:
                            t_before = placed[before][0]
                            t_after = placed[after][0]
                            start = t_before + (t_after - t_before) * ((i - before) / (after - before))
                        elif before is not None:
                            # Extrapolate forward at avg pacing of body
                            avg_step = (last_t - first_t) / max(1, items_matched[-1][0] - items_matched[0][0])
                            start = placed[before][0] + (i - before) * avg_step
                        elif after is not None:
                            avg_step = (last_t - first_t) / max(1, items_matched[-1][0] - items_matched[0][0])
                            start = placed[after][0] - (after - i) * avg_step
                        else:
                            start = HOOK_SKIP_SEC + i * 3.0
                        end = start + 2.5
                    items.append({"n": i + 1, "name": tgt_full, "start": start, "end": end})
                return items

    # Heuristic path: list items follow the pattern "NAME <action-verb>",
    # e.g. "GAMMA BUILDS", "PERPLEXITY SEARCHES", "IDEOGRAM CREATES". The
    # verb is third-person-singular (ends in S, len >= 4) or in a known
    # action-verb set. Skip the hook (first 5s) where the title and CTA are
    # spoken but no item names are introduced. Also skip the outro after
    # the Nth item.
    ACTION_VERBS = {
        "BUILDS", "CREATES", "MAKES", "GENERATES", "SEARCHES", "TRANSCRIBES",
        "COACHES", "ENHANCES", "COMPOSES", "WRITES", "DESIGNS", "COMPILES",
        "CONVERTS", "TURNS", "RENDERS", "PRODUCES", "GIVES", "DELIVERS",
        "BRINGS", "DOES", "RECORDS", "SUMMARIZES", "AUTOMATES", "TRANSLATES",
        "EDITS", "PREDICTS", "TRAINS", "RUNS", "EXTRACTS", "LETS", "HELPS",
    }
    MIN_GAP_BETWEEN_ITEMS = 0.8  # each tool gets at least this long on screen
    candidates = []
    j = 0
    last_item_end = 0.0
    while j < len(words) and len(candidates) < n:
        w = words[j]
        token_raw = (w.get("word") or "").strip()
        token = token_raw.upper().strip(".,!?'\"")
        start = float(w.get("start", 0))
        # Skip the hook section (intro + CTA before first item)
        if start < HOOK_SKIP_SEC:
            j += 1
            continue
        # Skip if too close to the previous accepted item
        if start - last_item_end < MIN_GAP_BETWEEN_ITEMS:
            j += 1
            continue
        # Token must be a plausible brand-name candidate. A brand name is
        # never a verb itself (so reject ACTION_VERBS) and never a 3sg verb
        # shape ending in S (e.g. "COMPOSES", "BUILDS").
        if len(token) < 3 or token.isdigit() or token in LIST_ITEM_STOPWORDS:
            j += 1
            continue
        if token in ACTION_VERBS:
            j += 1
            continue
        if token.endswith("S") and len(token) >= 5 and token not in {"LABS", "DOCS"}:
            # 3sg-verb-shape token: skip unless it's a known brand suffix.
            j += 1
            continue
        # The word right after must be an action verb (3sg pattern). If not,
        # this token is not a list item.
        if j + 1 >= len(words):
            break
        la1 = (words[j + 1].get("word") or "").upper().strip(".,!?'\"")
        # Two-word brand check: "ELEVEN LABS GIVES". If next word is also a
        # candidate-shape (not a verb, not a stopword, len>=3), look at j+2
        # for the verb.
        verb_idx = None
        absorb_next = False
        if la1 in ACTION_VERBS or (la1.endswith("S") and len(la1) >= 5 and la1 not in LIST_ITEM_STOPWORDS):
            verb_idx = j + 1
        elif j + 2 < len(words) and len(la1) >= 3 and la1 not in LIST_ITEM_STOPWORDS and not la1.isdigit():
            la2 = (words[j + 2].get("word") or "").upper().strip(".,!?'\"")
            if la2 in ACTION_VERBS or (la2.endswith("S") and len(la2) >= 5 and la2 not in LIST_ITEM_STOPWORDS):
                verb_idx = j + 2
                absorb_next = True
        if verb_idx is None:
            j += 1
            continue
        name = token_raw.upper().strip(".,!?'\"")
        if absorb_next:
            name = f"{name} {la1}"
        candidates.append({
            "n": len(candidates) + 1,
            "name": name,
            "start": start,
            "end": float(w.get("end", start + 1.0)),
        })
        last_item_end = float(words[verb_idx].get("end", start + 1.5))
        # Skip past the verb + object (typical "NAME VERB OBJECT" = 3-5 words)
        j = verb_idx + 1
    return candidates[:n]


def build_numbered_overlay_ass(items, total_dur, out_path):
    """Write a separate ASS subtitle file containing bold animated "N. NAME"
    overlays positioned near the top of the screen, one per list item.

    EC2's static ffmpeg build does not link freetype, so the drawtext filter
    is unavailable. Instead we use the subtitles/ass filter (already used for
    captions) and compose the overlays as ASS Dialogue events with rich
    inline styling.

    Locked 2026-05-03 (v2) from ExampleCo's "Those 1/2/3 labels look like shit
    let's get some beauty/design/animation in there for them" rejection.
    v1 was plain yellow text on a black box, no animation. v2 design:

      * Layer 1 (back): a big magenta-to-cyan gradient pill drawn as a thick
        bordered shape using the BorderStyle 4 box with rounded corners.
        Acts as the visual anchor.
      * Layer 2 (number): a giant 180pt cyan number (1, 2, ...) on the left,
        bold italic. Slides in from off-screen left over 280ms, then settles.
      * Layer 3 (name): 110pt bold yellow brand name on the right of the
        number, scales up from 50% to 100% over 280ms with a subtle bounce
        (\\t timing curve). Drop shadow for depth.
      * All three layers fade out together when the next item enters.

    The ASS animation tags used:
      \\move(x1,y1,x2,y2,t1,t2)  smooth position interpolation
      \\fad(in_ms,out_ms)         fade
      \\t(t1,t2,tags)             time-interpolate tag values for animation
      \\fscx, \\fscy              x/y scale percent
      \\1c                        primary fill color
      \\3c                        outline color
      \\bord                      outline width
      \\shad                      shadow distance
      \\an4 / \\an6                left-center / right-center alignment
    """
    if not items:
        return None

    def fmt(t):
        h = int(t // 3600)
        mm = int((t % 3600) // 60)
        ss = int(t % 60)
        cs = int((t % 1) * 100)
        return f"{h}:{mm:02d}:{ss:02d}.{cs:02d}"

    # ASS BGR with alpha. &HAABBGGRR. Yellow + cyan brand colors with
    # opaque magenta-to-cyan-style background drawn via vector clip + fill.
    YELLOW = "&H003FD2FF"      # #FFD23F
    CYAN   = "&H00FFD600"      # #00D6FF
    MAGENTA = "&H00CC2EFF"     # #FF2ECC
    BLACK  = "&H00101010"
    SHADOW = "&H80000000"

    # The v2 "pill background" used BorderStyle 4 with whitespace text, which
    # does not render in libass because whitespace has zero glyph width. v3
    # uses ASS vector drawing (\p1) to draw a real rounded-rect filled shape
    # behind the text. The drawing pen is in 1/8 px units by default; we
    # scale via \fscx100\fscy100 and use \pbo to set baseline offset.
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        # PillFill: vector-drawn filled shape. PrimaryColour is the fill.
        f"Style: PillFill,DejaVu Sans,100,{MAGENTA},&H000000FF,{BLACK},{SHADOW},"
        "0,0,0,0,100,100,0,0,1,0,8,5,40,40,200,1\n"
        # NumLg: huge cyan italic number with thick black border.
        f"Style: NumLg,DejaVu Sans,180,{CYAN},&H000000FF,{BLACK},{SHADOW},"
        "1,1,0,0,100,100,0,0,1,8,4,5,40,40,200,1\n"
        # NameLg/NameMd: bold yellow brand name.
        f"Style: NameLg,DejaVu Sans,120,{YELLOW},&H000000FF,{BLACK},{SHADOW},"
        "1,0,0,0,100,100,0,0,1,8,5,5,40,40,200,1\n"
        f"Style: NameMd,DejaVu Sans,92,{YELLOW},&H000000FF,{BLACK},{SHADOW},"
        "1,0,0,0,100,100,0,0,1,7,4,5,40,40,200,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    # Vector pill: rounded rect sized to fit BOTH the number row (y=200) and
    # the name row (y=360). Total vertical span ~280px so half-height = 160.
    # Width 880px so even long brand names like "ELEVENLABS" sit inside.
    # ASS \p1 drawing commands: m = move, l = line, b = cubic Bezier.
    pill_w_half = 460
    pill_h_half = 170
    r = 70
    pill_shape = (
        f"m {-pill_w_half + r} {-pill_h_half} "
        f"l {pill_w_half - r} {-pill_h_half} "
        f"b {pill_w_half} {-pill_h_half} {pill_w_half} {-pill_h_half + r} {pill_w_half} {-pill_h_half + r} "
        f"l {pill_w_half} {pill_h_half - r} "
        f"b {pill_w_half} {pill_h_half} {pill_w_half - r} {pill_h_half} {pill_w_half - r} {pill_h_half} "
        f"l {-pill_w_half + r} {pill_h_half} "
        f"b {-pill_w_half} {pill_h_half} {-pill_w_half} {pill_h_half - r} {-pill_w_half} {pill_h_half - r} "
        f"l {-pill_w_half} {-pill_h_half + r} "
        f"b {-pill_w_half} {-pill_h_half} {-pill_w_half + r} {-pill_h_half} {-pill_w_half + r} {-pill_h_half}"
    )

    # v5 layout (locked 2026-05-03 from "numbered items hide behind the names
    # of the services"): the number sits ABOVE the name (stacked vertically),
    # not to the left of it. This eliminates the horizontal collision when
    # long brand names like "PERPLEXITY" or "ELEVENLABS" overrun their slot
    # and overlap the number. Number is on a dedicated row at y=200, name on
    # a separate row at y=340. Both centered horizontally on x=540 so the
    # alignment stays clean regardless of text length. The pill behind them
    # is taller to encompass both rows.
    events = []
    for i, it in enumerate(items):
        t0 = float(it["start"]) + THUMBNAIL_CARD_DURATION_S
        if i + 1 < len(items):
            next_t = float(items[i + 1]["start"]) + THUMBNAIL_CARD_DURATION_S
            t1 = max(t0 + 1.0, next_t - 0.25)
        else:
            t1 = min(total_dur - 0.2, t0 + 3.0)
        num_y = 200
        name_y = 360
        center_x = 540
        slide_ms = 260
        num_text = str(it["n"])
        name_text_raw = str(it["name"])
        name_text = name_text_raw.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        # Pick name style based on actual character width so very long names
        # like "ELEVENLABS" or "PERPLEXITY" downsize and never run off the canvas.
        if len(name_text_raw) <= 9:
            name_style = "NameLg"
        elif len(name_text_raw) <= 13:
            name_style = "NameMd"
        else:
            name_style = "NameMd"
        # Layer 0 pill background DISABLED 2026-05-03 (v7).
        # libass renders the \p1 vector pill shape in screen-absolute space
        # rather than relative to \pos, producing a stuck magenta rectangle
        # in the top-left corner regardless of fade or scale tweaks. The
        # cyan number + yellow brand with thick black borders + drop shadows
        # are perfectly readable on busy B-roll without a background fill,
        # so we ship without the pill rather than fight the libass quirk.
        # Re-enable later by rendering the pill as a pre-baked PNG and
        # using ffmpeg's overlay filter (which IS available on EC2's
        # static build).
        pill_center_y = (num_y + name_y) // 2  # kept for reference, unused
        # Layer 5: number sits on the TOP row, slides in from off-screen
        # left, scales up. Always renders above the name (Layer < 5 = name).
        events.append(
            f"Dialogue: 5,{fmt(t0)},{fmt(t1)},NumLg,,0,0,0,,"
            f"{{\\an5\\move(-200,{num_y},{center_x},{num_y},0,{slide_ms})"
            f"\\fad(140,250)\\bord10\\3c{BLACK}\\shad8}}"
            f"{num_text}"
        )
        # Layer 2: name on the BOTTOM row, scale-up bounce from 60% to 100%.
        # Lower layer than the number so if any positioning ever overlaps,
        # the number wins.
        events.append(
            f"Dialogue: 2,{fmt(t0)},{fmt(t1)},{name_style},,0,0,0,,"
            f"{{\\an5\\pos({center_x},{name_y})\\fad(160,250)"
            f"\\fscx60\\fscy60\\t(0,{slide_ms},\\fscx100\\fscy100)"
            f"\\bord8\\3c{BLACK}\\shad6}}"
            f"{name_text}"
        )

    Path(out_path).write_text(header + "\n".join(events) + "\n")
    print(f"  Numbered overlay ASS: {len(events)} events ({len(items)} items x 3 layers), {out_path}")
    return out_path


def render_playwright_overlay(spec, words, emphasis_indices, list_items, total_dur, out_path, work_dir):
    """Render a transparent HTML/CSS motion overlay via Playwright.

    This is optional by design. If Node, Playwright, Chromium, or ffmpeg is
    missing on EC2, the builder keeps the ASS overlays and ships the video.
    """
    if os.environ.get("DISABLE_PLAYWRIGHT_OVERLAY"):
        print("  [playwright-overlay] disabled by env")
        return None

    candidates = [
        Path("/opt/secondbrain/src/main/empire/playwright_aurora_overlay.js"),
        Path(__file__).resolve().parent.parent / "src" / "main" / "empire" / "playwright_aurora_overlay.js",
    ]
    renderer = next((p for p in candidates if p.exists()), None)
    if not renderer:
        print("  [playwright-overlay] renderer not found, using ASS overlays only")
        return None

    words_json = Path(work_dir) / "playwright_words.json"
    list_json = Path(work_dir) / "playwright_list_items.json"
    words_json.write_text(json.dumps(words or []))
    list_json.write_text(json.dumps(list_items or []))

    node_bin = os.environ.get("NODE_BIN", "node")
    cmd = [
        node_bin,
        str(renderer),
        "--script", spec.get("script", ""),
        "--words-json", str(words_json),
        "--list-items-json", str(list_json),
        "--emphasis-indices", ",".join(str(i) for i in sorted(emphasis_indices or [])),
        "--topic", spec.get("topic", "default"),
        "--duration", f"{total_dur:.3f}",
        "--thumb-offset", f"{THUMBNAIL_CARD_DURATION_S:.6f}",
        "--channel", spec.get("channel", "AILifeHacksByExampleCoyExampleCo"),
        "--out", str(out_path),
    ]
    overlay_fps = os.environ.get("PLAYWRIGHT_OVERLAY_FPS", "4")
    overlay_scale = os.environ.get("PLAYWRIGHT_OVERLAY_SCALE", "0.25")
    cmd.extend(["--fps", overlay_fps])
    cmd.extend(["--render-scale", overlay_scale])

    try:
        timeout = int(os.environ.get("PLAYWRIGHT_OVERLAY_TIMEOUT", "900"))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:
        try:
            Path(out_path).unlink()
        except Exception:
            pass
        print(f"  [playwright-overlay] skipped: {exc}")
        return None

    if result.returncode != 0:
        try:
            Path(out_path).unlink()
        except Exception:
            pass
        stderr = (result.stderr or result.stdout or "").strip().replace("\n", " ")
        print(f"  [playwright-overlay] skipped: {stderr[:500]}")
        return None

    if not Path(out_path).exists():
        print("  [playwright-overlay] renderer exited cleanly but no overlay file was written")
        return None

    receipt = (result.stdout or "").strip()
    print(f"  [playwright-overlay] rendered {out_path}: {receipt[:500]}")
    return str(out_path)


# ── Stock Footage (Pexels) ────────────────────────────────────────────────────

def fetch_stock(query, out_path, config):
    key = config.get("pexels_api_key", "")
    r = requests_client().get(
        f"https://api.pexels.com/videos/search?query={query}&per_page=5&orientation=portrait",
        headers={"Authorization": key}, timeout=30
    )
    if r.status_code != 200:
        print(f"  Pexels error {r.status_code}")
        return None
    for v in r.json().get("videos", []):
        for f in sorted(v.get("video_files", []), key=lambda x: x.get("height", 0), reverse=True):
            if f.get("height", 0) >= 1080:
                data = requests_client().get(f["link"], timeout=120).content
                Path(out_path).write_bytes(data)
                print(f"  Stock: {len(data)} bytes → {out_path}")
                return out_path
    return None


# ── Video Assembly ────────────────────────────────────────────────────────────

def apply_regen_overrides(spec):
    """Translate spec['regen_overrides'] (produced by the LLM feedback
    interpreter in scripts/lib/interpret-rejection-into-spec-overrides.js)
    into concrete spec mutations before build. Each override is a
    no-silent-drop contract; the build either uses the override or logs
    a clear reason it could not.

    Supported overrides:
      - banned_phrases       : string list. Each phrase is removed from
                               spec['script'] (case-insensitive, whole
                               word) and from spec['title'] / tags so it
                               cannot appear in the rebuilt video.
      - hook_phrase          : string. Replaces the script's opening
                               sentence with the override text.
      - voice_id_override    : string. Overrides the ElevenLabs voice
                               id for the TTS call.
      - stock_query_override : string. Replaces spec['stock_query'].
      - animation_density    : 'low'|'normal'|'high'. Stamped on spec.
    """
    overrides = spec.get("regen_overrides") or {}
    if not overrides or overrides.get("error"):
        return spec
    banned = [p for p in (overrides.get("banned_phrases") or []) if p and isinstance(p, str)]
    if banned:
        script = spec.get("script") or ""
        title  = spec.get("title")  or ""
        for phrase in banned:
            pattern = re.compile(r"\b" + re.escape(phrase) + r"\b", re.IGNORECASE)
            script = pattern.sub("", script)
            title  = pattern.sub("", title)
        spec["script"] = re.sub(r"\s+", " ", script).strip()
        spec["title"]  = re.sub(r"\s+", " ", title).strip() or spec.get("title")
        print(f"  [regen-overrides] removed {len(banned)} banned phrase(s) from script + title")
    hook = overrides.get("hook_phrase")
    if hook and isinstance(hook, str) and hook.strip():
        existing = (spec.get("script") or "").strip()
        first_break = re.search(r"(?<=[.!?])\s+", existing)
        rest = existing[first_break.end():] if first_break else existing
        spec["script"] = hook.strip().rstrip(".") + ". " + rest
        print(f"  [regen-overrides] hook replaced -> {hook.strip()[:80]}")
    if overrides.get("voice_id_override"):
        spec["voice_id"] = overrides["voice_id_override"]
        print(f"  [regen-overrides] voice_id_override -> {overrides['voice_id_override']}")
    if overrides.get("stock_query_override"):
        spec["stock_query"] = overrides["stock_query_override"]
        spec["stock_queries"] = [overrides["stock_query_override"]]
        print(f"  [regen-overrides] stock_query -> {overrides['stock_query_override']}")
    # 2026-05-25 ExampleCo: dropped opening_tag_override. Tags are crafted by
    # the playwright overlay renderer from the actual script sentences,
    # not selected from a slot. A rejected tag is now expressed as a
    # banned_phrase + required_directive, and the renderer's script-
    # driven path handles the rest.
    if overrides.get("animation_density"):
        spec["animation_density"] = overrides["animation_density"]
        print(f"  [regen-overrides] animation_density -> {overrides['animation_density']}")
    return spec


def build_video(spec, config):
    spec = hydrate_spec_from_proposal(spec)
    # 2026-05-25 ExampleCo #learn: the LLM feedback interpreter writes
    # regen_overrides onto the manifest before this build runs. Apply
    # them BEFORE the script-length validation so banned phrases
    # cannot resurrect themselves through copy-paste from the spec.
    spec = apply_regen_overrides(spec)
    vid_id = spec["id"]

    # E6 2026-06-12: load the regen_feedback.json hand-off (structured
    # directives from the JS orchestrator) and the manifest rejection notes.
    fb = load_regen_feedback_file(vid_id)
    if fb:
        print(f"  [feedback] loaded regen_feedback.json ({len(fb.get('directives', []))} directives)")
        if fb.get("directives"):
            spec.setdefault("regen_directives", fb["directives"])
        if fb.get("rejection_note") and not spec.get("rejection_note"):
            spec["rejection_note"] = fb["rejection_note"]
    manifest_fb = load_rejection_feedback(vid_id)
    if manifest_fb.get("video") or manifest_fb.get("thumbnail"):
        print(f"  [feedback] loaded manifest rejection notes")
    d = WORK_DIR / vid_id
    d.mkdir(parents=True, exist_ok=True)
    script_text = (spec.get("script") or "").strip()
    if len(script_text.split()) < 20:
        raise ValueError(
            f"script missing or too short for {vid_id}; refusing to build a "
            "near-empty approval artifact"
        )
    spec["script"] = script_text

    voice_raw  = d / "voice.mp3"
    voice_h    = d / "voice_human.mp3"
    voice_pad  = d / "voice_padded.mp3"
    stock_raw  = d / "stock_raw.mp4"
    stock_s    = d / "stock_scaled.mp4"
    stock_loop = d / "stock_looped.mp4"
    thumbnail  = d / "thumbnail.jpg"
    thumb_card = d / "thumb_card.mp4"
    ass_file   = d / "captions.ass"
    concat_txt = d / "concat.txt"
    final      = d / "final.mp4"

    print(f"\n{'='*60}")
    print(f"Building: {spec['title']} [{vid_id}]")
    print(f"{'='*60}\n")

    # 1. Voice
    if voice_h.exists():
        print("[1] Voice exists ,  reusing")
    else:
        if not voice_raw.exists():
            print("[1] Generating ElevenLabs voice...")
            generate_voice(prepare_voice_script(spec["script"]), str(voice_raw), config, voice_id_override=spec.get("voice_id"))
        print("[1] Humanizing voice...")
        humanize_voice(str(voice_raw), str(voice_h))

    voice_base = str(voice_h) if voice_h.exists() else str(voice_raw)
    if not voice_pad.exists():
        print(f"[1b] Adding {VOICE_LEAD_PAD_S:.2f}s lead pad to protect first syllable...")
        add_voice_lead_pad(voice_base, str(voice_pad))
    voice_file = str(voice_pad) if voice_pad.exists() else voice_base
    dur = voice_duration(voice_file)
    total_dur = dur + THUMBNAIL_CARD_DURATION_S  # + single-frame thumb card
    print(f"  Voice duration: {dur:.1f}s, total: {total_dur:.1f}s")

    # 2. Captions (always regenerate for clean timestamps)
    print("[2] Transcribing for word-level captions...")
    words = correct_transcript_words(
        transcribe_words(voice_file, config.get("groq_api_key", "")),
        spec.get("script", ""),
    )
    # Per scheduled-tasks/captions-aurora/SKILL.md: top 20% of words are
    # highlighted in green based on Claude-scored interestingness, not the
    # 35-word hardcoded list. Falls back to legacy list if Claude unreachable.
    emphasis_indices = score_emphasis_with_claude(words, spec.get("script", ""))
    write_ass(words, str(ass_file), thumb_offset=THUMBNAIL_CARD_DURATION_S, emphasis_indices=emphasis_indices)

    # 2b. Custom animations overlay (per scheduled-tasks/animations-aurora/SKILL.md)
    # Detects numbered steps and outro CTA. Word-punch overlays are blocked
    # because they duplicated captions instead of adding visual meaning.
    # Renders as a
    # second ASS track that gets chained into the final ffmpeg -vf below.
    # Falls back to no-overlay if the skill module is missing.
    animations_ass = d / "animations.ass"
    try:
        # Resolve animations_aurora.py from src/main/empire (local) or
        # /opt/secondbrain/src/main/empire (EC2 deploy).
        for _emp_dir in ("/opt/secondbrain/src/main/empire",
                         str(Path(__file__).resolve().parent.parent / "src" / "main" / "empire")):
            if Path(_emp_dir).exists() and _emp_dir not in sys.path:
                sys.path.insert(0, _emp_dir)
        from animations_aurora import emit_animations as _emit_anim
        anim_result = _emit_anim(
            spec.get("script", ""), words, emphasis_indices,
            spec.get("topic", "default"),
            THUMBNAIL_CARD_DURATION_S, str(animations_ass),
            spec.get("channel", "AILifeHacksByExampleCoyExampleCo"),
        )
        print(f"  [animations] {anim_result.get('events', 0)} events, density "
              f"{anim_result.get('density_per_s', 0)}/s, plan={[p['type'] for p in anim_result.get('plan', [])]}")
    except Exception as _ae:
        try: animations_ass.unlink()
        except Exception: pass
        print(f"  [animations] skipped: {_ae}")

    # 3. Thumbnail
    # ExampleCo 2026-04-29 dispatch: regen kept producing the same blank thumbs
    # because this branch reused the existing thumbnail file even when
    # FORCE_REBUILD=1 was set. The mp4 step honors FORCE_REBUILD (line 488)
    # but the thumb step did not. Now both honor it. When auto-regen-
    # rejected-videos.js explicitly forces a rebuild, the thumbnail must
    # also be regenerated -- otherwise we keep shipping the same rejected
    # artifact under a "rebuilt" label.
    if thumbnail.exists() and not os.environ.get("FORCE_REBUILD"):
        print("[3] Thumbnail exists -- reusing (set FORCE_REBUILD=1 to regenerate)")
    else:
        if thumbnail.exists():
            print("[3] Thumbnail exists but FORCE_REBUILD=1 -- regenerating")
            try: thumbnail.unlink()
            except Exception: pass
            # Also nuke the cached Grok background so we get a fresh image.
            bg_cache = thumbnail.with_name(thumbnail.stem + "_bg.jpg")
            if bg_cache.exists():
                try: bg_cache.unlink()
                except Exception: pass
        else:
            print("[3] Generating Grok Aurora thumbnail...")
        grok_thumbnail(spec["title"], thumbnail, config)

    # 4. Stock footage. Locked 2026-05-03 from ExampleCo's "now it's just one
    # video the whole time" rejection: the spec ships a `stock_queries`
    # array (e.g. ["person using laptop", "screens data technology",
    # "phone app swiping"]) but the previous code read `stock_query`
    # (singular) and fell back to "technology", so EVERY build was a
    # single Pexels clip looped through the whole video. The fix reads
    # the plural array, fetches one clip per query, and concats them so
    # the visual cuts every voice_dur/N seconds. Cache invalidation:
    # FORCE_REBUILD=1 OR a missing stock_loop wipes the per-query
    # cache. Otherwise reuse to keep iteration cheap.
    queries = spec.get("stock_queries") or ([spec.get("stock_query")] if spec.get("stock_query") else [])
    queries = [q for q in queries if q] or ["technology"]
    force_rebuild = bool(os.environ.get("FORCE_REBUILD"))
    if stock_loop.exists() and not force_rebuild:
        loop_dur = voice_duration(str(stock_loop))
        if loop_dur >= dur:
            print(f"[4] Looped stock exists ({loop_dur:.1f}s), reusing (FORCE_REBUILD=1 to refresh)")
        else:
            stock_loop.unlink()
            print("[4] Looped stock too short, regenerating")
    if not stock_loop.exists():
        per_clip_dur = max(3.0, (dur + 1.0) / len(queries))  # >=3s per clip so cuts are not jarring
        clip_files = []
        for idx, query in enumerate(queries):
            clip_raw = d / f"stock_raw_{idx}.mp4"
            clip_scaled = d / f"stock_scaled_{idx}.mp4"
            if not clip_raw.exists() or force_rebuild:
                if force_rebuild and clip_raw.exists():
                    clip_raw.unlink()
                print(f"[4.{idx+1}] Fetching Pexels: '{query}'")
                if not fetch_stock(query, str(clip_raw), config):
                    print(f"  Pexels failed for '{query}', skipping this clip")
                    continue
            if not clip_scaled.exists() or force_rebuild:
                if force_rebuild and clip_scaled.exists():
                    clip_scaled.unlink()
                # Scale + crop to 1080x1920, trim to per_clip_dur, drop audio.
                # 2026-05-05: same ultrafast preset as the final assembly step.
                # Large Pexels clips (20MB+) at preset=fast hit the 1500s
                # subprocess timeout on t3.small. ultrafast is ~5x faster at
                # marginally larger output (acceptable for an intermediate).
                _scale_preset = os.environ.get("FFMPEG_X264_PRESET", "ultrafast")
                _scale_crf = os.environ.get("FFMPEG_X264_CRF", "24")
                run(f"ffmpeg -y -i {clip_raw} -t {per_clip_dur:.2f} "
                    f"-vf 'scale=1080:1920:force_original_aspect_ratio=increase,"
                    f"crop=1080:1920,setsar=1' -an -pix_fmt yuv420p -r 30 "
                    f"-c:v libx264 -preset {_scale_preset} -crf {_scale_crf} {clip_scaled}")
            if clip_scaled.exists():
                clip_files.append(clip_scaled)
        if not clip_files:
            # Hard fallback: dark color background covering the full duration
            print("[4] All stock fetches failed, using dark fallback")
            fallback = d / "stock_fallback.mp4"
            run(f"ffmpeg -y -f lavfi -i color=c=0x0a0a1a:s=1080x1920:d={dur+5} "
                f"-pix_fmt yuv420p -r 30 {fallback}")
            clip_files = [fallback]
        # Concat the per-query clips, then loop the concat block to cover dur+5s
        concat_clips = d / "stock_concat_clips.txt"
        concat_clips.write_text("\n".join(f"file '{c}'" for c in clip_files) + "\n")
        concat_one = d / "stock_concat_once.mp4"
        run(f"ffmpeg -y -f concat -safe 0 -i {concat_clips} -c copy {concat_one}")
        one_dur = voice_duration(str(concat_one)) or 1.0
        loops_needed = int((dur + 5) / one_dur) + 1
        loop_list = d / "loop_list.txt"
        loop_list.write_text(f"file '{concat_one}'\n" * loops_needed)
        run(f"ffmpeg -y -f concat -safe 0 -i {loop_list} -t {dur + 5} -c copy {stock_loop}")
        print(f"  Stock multi-clip looped: {voice_duration(str(stock_loop)):.1f}s "
              f"({len(clip_files)} unique clips x {loops_needed} loops)")

    # 5. Thumbnail card (0.25s)
    if not thumb_card.exists():
        # Single-frame flash. -frames:v 1 guarantees exactly one frame
        # regardless of how ffmpeg rounds -t at 30fps. Keeps the share-
        # preview-frame-matches-thumbnail contract (perceptual hash of
        # frame 0) while being below the threshold of perception for
        # the viewer (one frame = 33ms, looks instant).
        run(f"ffmpeg -y -loop 1 -i {thumbnail} -frames:v 1 -vf 'scale=1080:1920' "
            f"-pix_fmt yuv420p -r 30 {thumb_card}")

    # 5a. Polish the voice (de-ess + low-pass + loudness norm), fixes ExampleCo's
    # "narration is crackly" rejection 2026-05-03.
    voice_polished = d / "voice_polished.mp3"
    print("[5a] Polishing voice (de-ess + low-pass + loudness)...")
    polish_voice(voice_file, str(voice_polished))
    voice_for_mix = str(voice_polished) if voice_polished.exists() else voice_file

    # 5b. Mix voice with music bed, fixes ExampleCo's "no viral/pleasant music
    # behind" rejection 2026-05-03. Falls back to voice-only if asset missing.
    mixed_audio = d / "mixed_audio.m4a"
    music_track = pick_music_track(spec)
    print(f"[5b] Mixing voice with music track: {music_track[0]} (ratio {music_track[1]})")
    _, music_mixed_ok = mix_voice_with_music(voice_for_mix, music_track, str(mixed_audio), dur)
    audio_for_assemble = str(mixed_audio) if mixed_audio.exists() else voice_for_mix

    # 5c. Build numbered overlay ASS file for list-style videos, fixes ExampleCo's
    # "you have to number them like I said" rejection 2026-05-03.
    # Uses ASS rather than drawtext because EC2's static ffmpeg has no
    # freetype linkage so the drawtext filter is unavailable.
    list_items = extract_list_items(spec, words)
    overlay_ass = d / "overlays.ass"
    overlay_built = build_numbered_overlay_ass(list_items, total_dur, str(overlay_ass)) if list_items else None
    if list_items:
        print(f"[5c] Numbered overlays: {len(list_items)} items detected: "
              f"{', '.join(it['name'] for it in list_items[:5])}{'...' if len(list_items) > 5 else ''}")
    else:
        print("[5c] No list-style title detected, skipping numbered overlays")

    # 5d. PRIVATE_NAME HTML/CSS motion overlay. This produces a transparent alpha MOV
    # via Playwright screenshots and ffmpeg qtrle encoding. It replaces the
    # ASS visual overlay layers when available, while captions still render
    # through ASS. Missing Playwright or Chromium falls back cleanly to ASS.
    playwright_overlay = d / "playwright_overlay.mov"
    playwright_built = render_playwright_overlay(
        spec, words, emphasis_indices, list_items, total_dur, str(playwright_overlay), d
    )

    # 6. Assemble (NO -shortest, explicit -t to prevent truncation)
    print("[6] Assembling final video...")
    concat_txt.write_text(f"file '{thumb_card}'\nfile '{stock_loop}'\n")
    # Build the base filter chain. Captions always render via ASS. The older
    # numbered/custom ASS overlays are kept as the fallback visual layer when
    # the richer Playwright alpha overlay is not available.
    vf_parts = []
    if ass_file.exists():
        vf_parts.append(f"ass={ass_file}")
    if not playwright_built and overlay_built and Path(overlay_built).exists():
        vf_parts.append(f"ass={overlay_built}")
    if not playwright_built and animations_ass.exists():
        vf_parts.append(f"ass={animations_ass}")
    # 2026-05-04: switched preset from `fast` to `ultrafast` and CRF 22 to 24.
    # On t3.small the `fast` preset hit the 1500s subprocess timeout for
    # short006_ollamacode (looped stock + ASS subtitle filter is the long
    # pole). `ultrafast` cuts encode wall-time roughly 4-5x at the cost of
    # a ~20-30% larger file, which is fine for sub-30MB shorts. Quality
    # difference is imperceptible at YouTube's transcode bitrate.
    preset = os.environ.get("FFMPEG_X264_PRESET", "ultrafast")
    crf = os.environ.get("FFMPEG_X264_CRF", "24")
    if playwright_built and Path(playwright_built).exists():
        base_chain = ",".join(vf_parts) if vf_parts else "null"
        run(f"ffmpeg -y -f concat -safe 0 -i {concat_txt} -i {audio_for_assemble} -i {playwright_built} "
            f'-filter_complex "[0:v]{base_chain}[base];[base][2:v]overlay=0:0:format=auto:eof_action=pass[v]" '
            f'-map "[v]" -map 1:a '
            f"-c:v libx264 -preset {preset} -crf {crf} -c:a aac -b:a 192k "
            f"-t {total_dur} -pix_fmt yuv420p {final}", check=True)
    else:
        vf_arg = f'-vf "{",".join(vf_parts)}"' if vf_parts else ""
        run(f"ffmpeg -y -f concat -safe 0 -i {concat_txt} -i {audio_for_assemble} "
            f"{vf_arg} "
            f"-c:v libx264 -preset {preset} -crf {crf} -c:a aac -b:a 192k "
            f"-t {total_dur} -pix_fmt yuv420p {final}", check=True)

    if not final.exists():
        print(f"  FAILED: no final.mp4")
        return None, None

    size_mb = final.stat().st_size / 1024 / 1024
    actual_dur = voice_duration(str(final))
    print(f"  DONE: {size_mb:.1f}MB, {actual_dur:.1f}s")

    # Copy to youtube dir for upload
    import shutil
    yt_mp4  = Path(f"/opt/secondbrain/data/youtube/{vid_id}.mp4")
    yt_thumb = Path(f"/opt/secondbrain/data/youtube/{vid_id}_thumb.jpg")
    shutil.copy2(str(final), str(yt_mp4))
    if thumbnail.exists():
        shutil.copy2(str(thumbnail), str(yt_thumb))
    print(f"  Copied to youtube dir: {yt_mp4}")

    return str(final), str(thumbnail)


# ── Main ──────────────────────────────────────────────────────────────────────

def load_today_approved_proposal_ids():
    """Read today's approved AIDailyLifeHacks proposals.

    Returns a set of approved proposal ids, OR the literal sentinel string
    'GATE_NOT_PRESENT' when today's proposals file does not exist (which
    means the morning briefing has not run yet, so we should NOT enforce
    the gate; let the legacy regen flow proceed). Returns an empty set if
    the file exists but no proposal has been approved yet (skip-equals-no-
    video).

    Locked 2026-05-04 by ExampleCo: "If I skip, no video gets made." The
    proposals file is the single source of truth for what is allowed to
    build today.
    """
    # CT date, not UTC. Briefings + proposals are date-stamped in CT
    # (America/Chicago). After 7 PM CT the UTC date rolls forward and the
    # gate cannot find today's proposals file.
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")
    except Exception:
        today = datetime.utcnow().strftime("%Y-%m-%d")
    p = PROPOSALS_DIR_LOCAL / f"{today}.json"
    if not p.exists():
        return "GATE_NOT_PRESENT"
    try:
        state = json.loads(p.read_text())
    except Exception:
        return "GATE_NOT_PRESENT"
    proposals = state.get("proposals", []) or []
    return {pp["id"] for pp in proposals if pp.get("status") == "approved" and pp.get("id")}


if __name__ == "__main__":
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    config = load_config()
    queue  = json.loads(QUEUE_PATH.read_text()) if QUEUE_PATH.exists() else {"videos": []}
    manifest = load_manifest()

    # ExampleCo 2026-04-29: auto-regen-rejected-videos.js calls this script with
    # `--id <id>`. Previously this parsed `sys.argv[1]` as the bare id, so
    # target_id became the literal "--id" and every video in the queue
    # got skipped (silently). The build appeared to "complete" with 0
    # work done. Fix: support both the legacy bare-id form and the
    # `--id <id>` form.
    target_id = None
    spec_file = None
    _argv = sys.argv[1:]
    for i, a in enumerate(_argv):
        if a == "--id" and i + 1 < len(_argv):
            target_id = _argv[i + 1]
        elif a.startswith("--id="):
            target_id = a.split("=", 1)[1]
        elif a == "--spec-file" and i + 1 < len(_argv):
            spec_file = _argv[i + 1]
        elif a.startswith("--spec-file="):
            spec_file = a.split("=", 1)[1]
        elif i == 0 and not a.startswith("--"):
            # Legacy bare-id form.
            target_id = a
    if target_id:
        print(f"[main] target_id={target_id}")

    # --spec-file <path> lets the regen orchestrator (auto-regen-rejected-
    # videos.js) rebuild a daily-generated id that is NOT present in the
    # transient ec2-build-queue.json. Previously `--id <daily_id>` no-oped
    # because the loop only iterates that stale queue file; the build then
    # exited 0 with nothing built ("claimed success but no mp4"). We inject the
    # caller-supplied spec into the in-memory queue only (the on-disk queue file
    # is never mutated, so concurrent runs don't race).
    injected_spec = None
    if spec_file:
        try:
            injected_spec = json.loads(Path(spec_file).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[main] --spec-file unreadable ({spec_file}): {e}")
            sys.exit(1)
        if not isinstance(injected_spec, dict) or not injected_spec.get("id"):
            print(f"[main] --spec-file must contain a JSON object with an 'id' field: {spec_file}")
            sys.exit(1)
        inj_id = merge_injected_spec(queue, injected_spec)
        if not target_id:
            target_id = inj_id
        print(f"[main] injected spec for {inj_id} from {spec_file}")

    # Daily approval gate (locked 2026-05-04 by ExampleCo #learn).
    # When run WITHOUT --id (i.e. the daily auto-generation path), only
    # proposals approved by ExampleCo today can build. When run WITH --id (the
    # rejection-regen path used by auto-regen-rejected-videos.js), the gate
    # is bypassed because that flow is already tied to a previously-approved
    # video being regenerated. Skip-equals-no-video applies only to fresh
    # daily generation, not to fixes of already-approved videos.
    approved_today = load_today_approved_proposal_ids()
    if not target_id:
        if approved_today == "GATE_NOT_PRESENT":
            print("[gate] No proposals file for today; legacy daily-build mode (gate inactive)")
        elif len(approved_today) == 0:
            print("[gate] No approved proposals today. Skip = no video. Exiting cleanly.")
            sys.exit(0)
        else:
            print(f"[gate] {len(approved_today)} approved proposal(s) today: {sorted(approved_today)}")

    built = []
    failed = []
    for spec in queue.get("videos", []):
        vid_id = spec["id"]
        if target_id and target_id != vid_id:
            continue
        # Skip non-approved entries when the daily gate is active.
        if (not target_id) and isinstance(approved_today, set) and vid_id not in approved_today:
            print(f"[gate] {vid_id} not in today's approved set, skipping")
            continue

        # A re-queued rejected video ExampleCos a rejection note. It must ALWAYS
        # rebuild from that feedback -- the stale-final.mp4 skip must not fire,
        # otherwise the rejected video would be re-shipped unchanged.
        spec_rejection = get_rejection_note(spec)

        # Skip if already successfully built and final.mp4 is fresh.
        final_path = WORK_DIR / vid_id / "final.mp4"
        if (final_path.exists()
                and not os.environ.get("FORCE_REBUILD")
                and not spec_rejection):
            print(f"[{vid_id}] final.mp4 exists ,  skipping (set FORCE_REBUILD=1 to override)")
            built.append(vid_id)
            continue
        if spec_rejection and final_path.exists():
            print(f"[{vid_id}] rejected video re-queued, rebuilding from feedback")

        try:
            video_path, thumb_path = build_video(spec, config)
            if video_path:
                manifest[vid_id] = {
                    "title": spec["title"],
                    "channel": spec["channel"],
                    "video": video_path,
                    "thumbnail": thumb_path,
                    "built_at": __import__("datetime").datetime.utcnow().isoformat(),
                }
                if spec_rejection:
                    manifest[vid_id]["regenerated_from_rejection"] = spec_rejection
                built.append(vid_id)
            else:
                failed.append(vid_id)
        except Exception as e:
            print(f"  EXCEPTION building {vid_id}: {e}")
            failed.append(vid_id)

    save_manifest(manifest)

    print(f"\n{'='*60}")
    print(f"DONE: {len(built)} built, {len(failed)} failed")
    for b in built:
        print(f"  OK:   {b}")
    for f in failed:
        print(f"  FAIL: {f}")
    print(f"{'='*60}")

    # Exit non-zero on ANY failure so a caller (auto-regen-rejected-videos.js)
    # never reads a swallowed build error as success. Previously the script
    # fell off the end of __main__ and returned exit 0 even for "0 built" or
    # "N failed" -- a false success.
    sys.exit(build_exit_code(failed, target_id, built))
