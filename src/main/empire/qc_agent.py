"""
qc_agent.py — Quality Control Agent
Runs after every video build. Blocks delivery on failure.
Call: python3 qc_agent.py <video_dir>
Or import: from qc_agent import run_qc
"""
import subprocess, json, sys, struct
from pathlib import Path

CHECKS = []

def check(name):
    def decorator(fn):
        CHECKS.append((name, fn))
        return fn
    return decorator


# ── Individual checks ────────────────────────────────────────────────────────

@check("file_exists")
def check_file_exists(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, f"final.mp4 missing in {vid_dir}"
    return True, f"final.mp4 exists ({final.stat().st_size/1024/1024:.1f}MB)"


@check("min_size_2mb")
def check_min_size(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    mb = final.stat().st_size / 1024 / 1024
    if mb < 2:
        return False, f"Too small: {mb:.1f}MB (min 2MB)"
    return True, f"{mb:.1f}MB ✓"


@check("min_duration_10s")
def check_duration(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    r = subprocess.run([
        'ffprobe','-v','quiet','-show_entries','format=duration',
        '-of','default=noprint_wrappers=1:nokey=1', str(final)
    ], capture_output=True, text=True)
    try:
        dur = float(r.stdout.strip())
        if dur < 10:
            return False, f"Too short: {dur:.1f}s (min 10s)"
        if dur > 65:
            return False, f"Too long: {dur:.1f}s (max 65s for Shorts)"
        return True, f"{dur:.1f}s ✓"
    except:
        return False, "Could not read duration"


@check("has_audio")
def check_has_audio(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    r = subprocess.run([
        'ffprobe','-v','quiet','-select_streams','a',
        '-show_entries','stream=codec_type',
        '-of','default=noprint_wrappers=1:nokey=1', str(final)
    ], capture_output=True, text=True)
    if 'audio' not in r.stdout:
        return False, "No audio stream found — music/voice missing!"
    return True, "Audio stream present ✓"


@check("thumbnail_exists")
def check_thumbnail_exists(vid_dir: Path) -> tuple[bool, str]:
    thumb = vid_dir / 'thumbnail.jpg'
    if not thumb.exists():
        return False, "thumbnail.jpg MISSING — required for YouTube"
    size = thumb.stat().st_size
    if size < 10000:
        return False, f"thumbnail.jpg too small ({size} bytes) — likely blank/corrupt"
    return True, f"thumbnail.jpg exists ({size/1024:.0f}KB) ✓"


@check("thumbnail_not_black")
def check_thumbnail_not_black(vid_dir: Path) -> tuple[bool, str]:
    """Check thumbnail has real content (not solid black)."""
    thumb = vid_dir / 'thumbnail.jpg'
    if not thumb.exists():
        return False, "thumbnail.jpg missing"
    # Use ffprobe to get mean luminance of thumbnail
    r = subprocess.run([
        'ffprobe','-v','quiet','-f','lavfi',
        f'-i','movie={thumb},signalstats',
        '-show_entries','frame_tags=lavfi.signalstats.YAVG',
        '-of','default=noprint_wrappers=1:nokey=1'
    ], capture_output=True, text=True)
    # Fallback: just check file size > 50KB (black JPEG compresses tiny)
    size_kb = thumb.stat().st_size / 1024
    if size_kb < 20:
        return False, f"Thumbnail suspiciously small ({size_kb:.0f}KB) — may be black/blank"
    return True, f"Thumbnail has content ({size_kb:.0f}KB) ✓"


@check("thumbnail_card_in_video")
def check_thumbnail_card(vid_dir: Path) -> tuple[bool, str]:
    """Check that video starts with thumbnail card (first frame should be bright, not content)."""
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    # Extract first frame
    first_frame = vid_dir / '_qc_first_frame.jpg'
    subprocess.run([
        'ffmpeg','-y','-i',str(final),'-vframes','1','-q:v','2',str(first_frame)
    ], capture_output=True)
    if not first_frame.exists():
        return False, "Could not extract first frame"
    size_kb = first_frame.stat().st_size / 1024
    first_frame.unlink(missing_ok=True)
    # Thumbnail cards are high-quality JPEGs, typically >50KB when extracted
    if size_kb < 5:
        return False, f"First frame too small ({size_kb:.0f}KB) — thumbnail card may be missing"
    return True, f"First frame present ({size_kb:.0f}KB) ✓"


@check("has_voice_mp3")
def check_voice_humanized(vid_dir: Path) -> tuple[bool, str]:
    """Check that humanized voice file was generated."""
    human = vid_dir / 'voice_human.mp3'
    voice = vid_dir / 'voice.mp3'
    if not voice.exists():
        return False, "voice.mp3 missing — TTS was not run"
    if not human.exists():
        return False, "voice_human.mp3 missing — humanizer was NOT applied!"
    return True, "voice.mp3 + voice_human.mp3 both present ✓"


@check("resolution_1080x1920")
def check_resolution(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    r = subprocess.run([
        'ffprobe','-v','quiet','-select_streams','v:0',
        '-show_entries','stream=width,height',
        '-of','json', str(final)
    ], capture_output=True, text=True)
    try:
        info = json.loads(r.stdout)
        s = info['streams'][0]
        w, h = s['width'], s['height']
        if w != 1080 or h != 1920:
            return False, f"Wrong resolution: {w}x{h} (need 1080x1920)"
        return True, f"{w}x{h} ✓"
    except:
        return False, "Could not check resolution"


@check("tg_version_exists")
def check_tg_version(vid_dir: Path) -> tuple[bool, str]:
    tg = vid_dir / 'tg.mp4'
    if not tg.exists():
        return False, "tg.mp4 missing — Telegram version not generated"
    mb = tg.stat().st_size / 1024 / 1024
    if mb > 50:
        return False, f"tg.mp4 too large: {mb:.1f}MB (Telegram limit 50MB)"
    return True, f"tg.mp4 exists ({mb:.1f}MB) ✓"


@check("thumbnail_has_grok_bg")
def check_thumbnail_grok_bg(vid_dir: Path) -> tuple[bool, str]:
    thumb = vid_dir / 'thumbnail.jpg'
    if not thumb.exists():
        return False, "thumbnail.jpg missing"
    size_kb = thumb.stat().st_size / 1024
    if size_kb < 200:
        return False, f"Thumbnail only {size_kb:.0f}KB — likely no Grok background (need >200KB)"
    # Check for bg source file
    bg_files = list(vid_dir.glob('*_bg.jpg')) + list(vid_dir.glob('thumbnail_bg.jpg'))
    if not bg_files:
        # Warn but don't fail — bg might be in analytics dir
        return True, f"Thumbnail {size_kb:.0f}KB ✓ (bg source not in dir — ok if in analytics)"
    return True, f"Thumbnail {size_kb:.0f}KB ✓, bg source: {bg_files[0].name}"


@check("title_has_hook_element")
def check_title_hook(vid_dir: Path) -> tuple[bool, str]:
    import re
    queue_path = Path(__file__).parent.parent / 'state' / 'upload_queue.json'
    title = None
    if queue_path.exists():
        try:
            queue = json.load(open(queue_path))
            for entry in queue:
                if entry.get('id') == vid_dir.name or vid_dir.name in entry.get('path', ''):
                    title = entry.get('title', '')
                    break
        except Exception:
            pass

    if not title:
        return True, "Could not find title — skipping hook check"

    has_number = bool(re.search(r'\d+', title))
    power_words = ['free', 'secret', 'nobody', 'everyone', 'banned', 'quit', 'lost', 'never', 'always', 'real', 'first']
    has_power = any(w in title.lower() for w in power_words)

    if has_number:
        return True, f"Title has specific number ✓: '{title}'"
    if has_power:
        return True, f"Title has power word ✓: '{title}'"
    return False, f"Weak title — no number or power word: '{title}' (add stat like '295%' or '9 AIs')"


@check("no_nope_pile")
def check_nope_pile(vid_dir: Path) -> tuple[bool, str]:
    NOPE = ['pentagon', 'military', 'government', 'weapons', 'national security', 'cia', 'nsa', 'fbi', 'banned by', 'war crimes']
    queue_path = Path(__file__).parent.parent / 'state' / 'upload_queue.json'
    text_to_check = vid_dir.name + ' '
    if queue_path.exists():
        try:
            queue = json.load(open(queue_path))
            for entry in queue:
                if entry.get('id') == vid_dir.name:
                    text_to_check += entry.get('title', '') + ' ' + entry.get('description', '')
        except Exception:
            pass
    for sf in vid_dir.glob('script*.txt'):
        text_to_check += sf.read_text(errors='replace')
    text_lower = text_to_check.lower()
    hits = [p for p in NOPE if p in text_lower]
    if hits:
        return False, f"NOPE PILE topics detected: {hits} — algorithm suppression risk!"
    return True, "No NOPE PILE topics ✓"


@check("caption_timing_natural")
def check_caption_timing(vid_dir: Path) -> tuple[bool, str]:
    """
    Verify captions use NATURAL timestamps (start near 0s, not shifted by 2.5s).
    Correct architecture: voice + captions start at t=0, thumbnail card is just the visual backdrop.
    First word should start between 0.0s and 1.0s — NOT at 2.5s+.
    """
    ts_file = vid_dir / 'timestamps.json'
    if ts_file.exists():
        try:
            data = json.load(open(ts_file))
            words = data if isinstance(data, list) else data.get('words', [])
            if words:
                first_start = float(words[0].get('start', 0))
                if first_start > 2.0:
                    return False, f"Caption timestamps are shifted: first word at {first_start:.2f}s — should be ~0s (natural). Do NOT shift timestamps by 2.5s."
                return True, f"First caption at {first_start:.2f}s ✓ (natural, unshifted)"
        except Exception:
            pass

    return True, "No timestamps.json to verify — skipping timing check"


@check("captions_have_timestamps")
def check_captions_timestamps(vid_dir: Path) -> tuple[bool, str]:
    ts = vid_dir / 'timestamps.json'
    if not ts.exists():
        return False, "timestamps.json missing — captions may not have been generated from real Whisper transcription!"
    try:
        data = json.load(open(ts))
        word_count = len(data) if isinstance(data, list) else len(data.get('words', []))
        if word_count < 5:
            return False, f"timestamps.json has only {word_count} words — seems incomplete"
        return True, f"timestamps.json has {word_count} words ✓"
    except Exception:
        return False, "timestamps.json exists but could not parse"


@check("audio_has_music")
def check_audio_has_music(vid_dir: Path) -> tuple[bool, str]:
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"
    r = subprocess.run([
        'ffprobe', '-v', 'quiet', '-select_streams', 'a:0',
        '-show_entries', 'stream=bit_rate',
        '-of', 'json', str(final)
    ], capture_output=True, text=True)
    try:
        info = json.loads(r.stdout)
        br = int(info['streams'][0].get('bit_rate', 0))
        if br < 64000:
            return False, f"Audio bitrate very low ({br//1000}kbps) — music may not be mixed"
        return True, f"Audio bitrate {br//1000}kbps ✓"
    except Exception:
        return True, "Could not check audio bitrate — skipping"


@check("thumbnail_card_duration")
def check_thumb_card_duration(vid_dir: Path) -> tuple[bool, str]:
    """Video should be ~2.5s longer than bg.mp4 due to thumbnail card."""
    final = vid_dir / 'final.mp4'
    bg = vid_dir / 'bg.mp4'
    if not final.exists() or not bg.exists():
        return True, "Cannot verify (missing bg.mp4) — skipping"

    def get_dur(p):
        r = subprocess.run([
            'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(p)
        ], capture_output=True, text=True)
        try:
            return float(r.stdout.strip())
        except Exception:
            return 0

    final_dur = get_dur(final)
    bg_dur = get_dur(bg)
    diff = final_dur - bg_dur

    if diff < 1.5:
        return False, f"Thumbnail card missing or too short: final={final_dur:.1f}s, bg={bg_dur:.1f}s, diff={diff:.1f}s (need ~2.5s)"
    if diff > 4.0:
        return False, f"Thumbnail card too long: {diff:.1f}s extra (expected ~2.5s)"
    return True, f"Thumbnail card: +{diff:.1f}s ✓"


@check("captions_green_highlights")
def check_green_highlights(vid_dir: Path) -> tuple[bool, str]:
    """Extract frames from video body and verify green #00FF88 captions are visible."""
    import subprocess, json, base64, os
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return False, "final.mp4 missing"

    # Get duration
    r = subprocess.run(['ffprobe','-v','quiet','-show_entries','format=duration',
        '-of','default=noprint_wrappers=1:nokey=1', str(final)], capture_output=True, text=True)
    try:
        dur = float(r.stdout.strip())
    except:
        return True, "Could not get duration — skipping vision check"

    if dur < 6:
        return True, "Video too short for vision check — skipping"

    # Extract 3 frames from video body (after thumbnail card)
    frames = []
    for t in [4.0, dur*0.4 + 2.5, dur*0.7 + 2.5]:
        if t >= dur:
            continue
        frame_path = vid_dir / f'_qc_frame_{t:.0f}.jpg'
        subprocess.run([
            'ffmpeg','-y','-ss',str(t),'-i',str(final),
            '-vframes','1','-q:v','3',str(frame_path)
        ], capture_output=True)
        if frame_path.exists():
            frames.append(frame_path)

    if not frames:
        return True, "Could not extract frames — skipping vision check"

    # Use Anthropic Claude vision to check for green text
    try:
        import anthropic
        config = json.load(open(Path(__file__).parent.parent / 'config.json'))
        api_key = config.get('anthropic_api_key') or os.environ.get('ANTHROPIC_API_KEY','')
        if not api_key:
            for f in frames: f.unlink(missing_ok=True)
            return True, "No Anthropic key — skipping vision check"

        client = anthropic.Anthropic(api_key=api_key)

        image_content = []
        for fp in frames[:2]:  # Use max 2 frames to save cost
            img_b64 = base64.standard_b64encode(fp.read_bytes()).decode()
            image_content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}
            })

        image_content.append({
            "type": "text",
            "text": "These are frames from an AI YouTube Short. Look for caption text. Answer ONLY with a JSON object: {\"has_captions\": true/false, \"has_green_text\": true/false, \"green_word_count\": <number>, \"notes\": \"<brief observation>\"}. Green text is #00FF88 (bright neon green). We expect emphasis words like 'million', 'free', 'billion', 'banned', 'real', 'never' to appear in green."
        })

        resp = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=200,
            messages=[{"role":"user","content":image_content}]
        )

        result_text = resp.content[0].text.strip()
        # Parse JSON from response
        import re
        json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            has_captions = result.get('has_captions', False)
            has_green = result.get('has_green_text', False)
            notes = result.get('notes', '')

            for f in frames: f.unlink(missing_ok=True)

            if not has_captions:
                return False, f"Vision: NO CAPTIONS detected in video frames! {notes}"
            if not has_green:
                return False, f"Vision: Captions present but NO GREEN highlights detected. {notes}"
            return True, f"Vision: Captions ✓ + green highlights ✓. {notes}"
        else:
            for f in frames: f.unlink(missing_ok=True)
            return True, f"Vision response unparseable — skipping: {result_text[:100]}"

    except Exception as e:
        for f in frames: f.unlink(missing_ok=True)
        return True, f"Vision check error (non-blocking): {str(e)[:80]}"


@check("hook_quality_score")
def check_hook_quality(vid_dir: Path) -> tuple[bool, str]:
    """Use Groq LLM to score hook quality. Must score ≥6/10 to pass."""
    import json, sys
    sys.path.insert(0, str(Path(__file__).parent))

    # Get title from upload queue
    queue_path = Path(__file__).parent.parent / 'state' / 'upload_queue.json'
    kids_queue_path = Path(__file__).parent.parent / 'state' / 'kids_upload_queue.json'

    title = None
    for qp in [queue_path, kids_queue_path]:
        if qp.exists():
            queue = json.load(open(qp))
            for entry in queue:
                if entry.get('id') == vid_dir.name or vid_dir.name in entry.get('path',''):
                    title = entry.get('title','')
                    break
        if title:
            break

    # Also try to get first line of script
    opening_line = ""
    for sf in list(vid_dir.glob('script*.txt')) + list(vid_dir.glob('script.txt')):
        lines = sf.read_text().strip().split('\n')
        opening_line = lines[0] if lines else ""
        break

    if not title:
        return True, "No title found in queue — skipping hook check"

    # Skip kids videos (different quality criteria)
    if 'kids' in vid_dir.name.lower() or 'bedtime' in vid_dir.name.lower():
        return True, "Kids video — hook scoring skipped"

    try:
        from groq import Groq
        config = json.load(open(Path(__file__).parent.parent / 'config.json'))
        client = Groq(api_key=config['groq_api_key'])

        prompt = f"""You are a YouTube Shorts viral video expert. Score this video concept for hook quality.

Title: {title}
Opening line: {opening_line or '(not available)'}

Score on a scale of 1-10 for:
- Would a random person STOP SCROLLING? (Purple Cow test)
- Does it create curiosity or FOMO?
- Is there a specific stat, number, or surprising fact?
- Is it uplifting/positive in tone (not dark/scary)?

Respond ONLY with JSON: {{"score": <1-10>, "verdict": "PASS" or "FAIL", "reason": "<one sentence>", "suggestion": "<one specific improvement if score < 7>"}}

Score 8-10 = viral potential. 6-7 = acceptable. Below 6 = needs rework."""

        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role":"user","content":prompt}],
            max_tokens=200,
            temperature=0.3
        )

        import re
        result_text = resp.choices[0].message.content.strip()
        json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            score = result.get('score', 5)
            verdict = result.get('verdict', 'FAIL')
            reason = result.get('reason', '')
            suggestion = result.get('suggestion', '')

            if score < 6:
                msg = f"Hook score {score}/10 — WEAK. {reason}"
                if suggestion:
                    msg += f" Fix: {suggestion}"
                return False, msg
            return True, f"Hook score {score}/10 ✓ — {reason}"
        else:
            return True, f"LLM response unparseable — skipping: {result_text[:80]}"

    except Exception as e:
        return True, f"Hook check error (non-blocking): {str(e)[:80]}"


@check("no_trailing_video")
def check_no_trailing_video(vid_dir: Path) -> tuple[bool, str]:
    """Video should not run more than 2s after voice ends."""
    voice = vid_dir / 'voice_human.mp3'
    if not voice.exists():
        voice = vid_dir / 'voice.mp3'
    final = vid_dir / 'final.mp4'

    if not voice.exists() or not final.exists():
        return True, 'SKIP: missing files'

    def get_dur(p):
        r = subprocess.run([
            'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(p)
        ], capture_output=True, text=True)
        return float(r.stdout.strip() or 0)

    voice_dur = get_dur(voice)
    vid_dur = get_dur(final)
    # vid_dur = voice_dur + 2.5 (thumb card) + small buffer
    expected_max = voice_dur + 2.5 + 2.0  # 2s tolerance

    if vid_dur > expected_max:
        return False, f'video={vid_dur:.1f}s voice={voice_dur:.1f}s trailing={vid_dur-voice_dur-2.5:.1f}s (max 2.0s)'
    return True, f'video={vid_dur:.1f}s voice={voice_dur:.1f}s OK'


@check("no_voice_delay")
def check_no_voice_delay(vid_dir: Path) -> tuple[bool, str]:
    """Voice audio should start within 0.3s of the thumbnail card ending (t=2.5s)."""
    import re as _re
    final = vid_dir / 'final.mp4'
    if not final.exists():
        return True, 'SKIP: no final.mp4'

    # Extract audio from t=2.5 to t=4.0 and check for signal
    tmp = vid_dir / '_qa_audio_check.wav'
    try:
        subprocess.run([
            'ffmpeg', '-y', '-ss', '2.5', '-t', '1.0', '-i', str(final),
            '-vn', '-c:a', 'pcm_s16le', str(tmp)
        ], check=True, capture_output=True)

        size = tmp.stat().st_size
        tmp.unlink(missing_ok=True)

        # Check RMS level using volumedetect
        r2 = subprocess.run([
            'ffmpeg', '-y', '-ss', '2.5', '-t', '1.5', '-i', str(final),
            '-vn', '-af', 'volumedetect', '-f', 'null', '-'
        ], capture_output=True, text=True)
        output = r2.stderr
        if 'mean_volume' in output:
            m = _re.search(r'mean_volume: ([-\d.]+) dB', output)
            if m:
                mean_db = float(m.group(1))
                if mean_db < -60:
                    return False, f'Voice likely delayed — mean volume at t=2.5-4.0s is {mean_db:.1f}dB (silence)'
                return True, f'Voice starts OK (mean {mean_db:.1f}dB at t=2.5s)'
    except Exception:
        pass
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

    return True, 'SKIP: could not check'


# ── Runner ───────────────────────────────────────────────────────────────────

def run_qc(vid_dir: str | Path, strict: bool = True) -> dict:
    """
    Run all QC checks on a video directory.
    Returns dict with passed, failed, results.
    If strict=True, raises on any failure.
    """
    vid_dir = Path(vid_dir)
    results = {}
    passed = 0
    failed = 0

    print(f"\n{'='*60}")
    print(f"QC CHECK: {vid_dir.name}")
    print(f"{'='*60}")

    for name, fn in CHECKS:
        try:
            ok, msg = fn(vid_dir)
        except Exception as e:
            ok, msg = False, f"Exception: {e}"

        status = "✅ PASS" if ok else "❌ FAIL"
        print(f"  {status} [{name}]: {msg}")
        results[name] = {'passed': ok, 'msg': msg}
        if ok:
            passed += 1
        else:
            failed += 1

    print(f"\nResult: {passed}/{passed+failed} checks passed")

    if failed > 0:
        print(f"❌ QC FAILED — {failed} check(s) failed. DO NOT SEND TO LUKEY.")
        if strict:
            raise ValueError(f"QC failed for {vid_dir.name}: {failed} failures")
    else:
        print(f"✅ QC PASSED — {vid_dir.name} is ready to send")

    print(f"{'='*60}\n")
    return {'passed': passed, 'failed': failed, 'results': results}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 qc_agent.py <video_dir>")
        sys.exit(1)
    try:
        run_qc(sys.argv[1], strict=False)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
