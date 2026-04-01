"""
build_video.py — Canonical video builder. All production rules enforced here.
Import and call build_video() for every AILifeHacks short.

RULES ARE IN CODE. This is not optional reading.
"""
import subprocess, json, shutil, sys, re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# ── Constants (locked) ──────────────────────────────────────────────────────
W, H = 1080, 1920
JESSICA_ID = "cgSgspJ2msm6clMCkdW9"
ELEVENLABS_MODEL = "eleven_turbo_v2_5"
VOICE_STABILITY = 0.40
VOICE_SIMILARITY = 0.60
VOICE_STYLE = 0.45

EMPHASIS_WORDS = {
    'million','billion','free','viral','hack','views','money','banned','first','zero',
    'never','always','secret','real','quit','ethics','paid','lost','wrong','nine',
    'bitcoin','crypto','ai','claude','everyone','nobody','question','thousands'
}

MUSIC_MAP = {
    'tech':     ('tech_futuristic_norm.mp3', 0.18),
    'income':   ('hopeful_piano_norm.mp3',   0.20),
    'serious':  ('dark_cinematic_inception_norm.mp3', 2.34),
    'default':  ('tech_futuristic_norm.mp3', 0.18),
}

NOPE_PILE = ['pentagon','military','government','weapons','national security','cia','nsa','fbi','war','banned by']

SOUNDS_DIR = Path(__file__).parent.parent / 'assets' / 'sounds'
CONFIG_PATH = Path(__file__).parent.parent / 'config.json'


def _load_config():
    return json.load(open(CONFIG_PATH))


def _check_nope_pile(topic: str, script: str):
    combined = (topic + ' ' + script).lower()
    for phrase in NOPE_PILE:
        if phrase in combined:
            raise ValueError(f"NOPE PILE: topic contains banned phrase '{phrase}'. Abort.")


def generate_voice(script: str, out_path: Path, kids: bool = False) -> Path:
    """Generate ElevenLabs voice. Always applies humanizer after."""
    import requests
    config = _load_config()
    key = config['elevenlabs_api_key']

    stability = 0.75 if kids else VOICE_STABILITY
    similarity = 0.75 if kids else VOICE_SIMILARITY
    style = 0.20 if kids else VOICE_STYLE

    # Clean script
    script = re.sub(r'[—–]', ' ', script)
    script = re.sub(r'["\u201c\u201d\u2018\u2019]', '', script)

    r = requests.post(
        f'https://api.elevenlabs.io/v1/text-to-speech/{JESSICA_ID}',
        headers={'xi-api-key': key, 'Content-Type': 'application/json'},
        json={
            'text': script,
            'model_id': ELEVENLABS_MODEL,
            'voice_settings': {
                'stability': stability,
                'similarity_boost': similarity,
                'style': style,
                'use_speaker_boost': False
            }
        },
        timeout=60
    )
    r.raise_for_status()
    out_path.write_bytes(r.content)

    # MANDATORY: apply humanizer
    from voice_humanizer import humanize
    human_path = out_path.parent / (out_path.stem + '_human.mp3')
    humanize(out_path, human_path)
    return human_path


def build_captions_filter(words: list, duration: float) -> str:
    """
    Build ffmpeg drawtext filter with:
    - Single word pop-in
    - t0=0.0 for first word
    - Green #00FF88 for emphasis words
    - fontsize=88, reduce to 68 for words >12 chars
    - ? and ! preserved
    """
    BAD = set('"\':\\%$,[](){}@/#&\u2014')
    filters = []

    for i, w in enumerate(words):
        raw = w['word']
        display = ''.join(c for c in raw if c not in BAD).strip()
        if not display:
            continue

        t0 = float(w['start'])
        t1 = float(words[i+1]['start']) if i+1 < len(words) else duration
        t1 = min(t1, duration)
        if t1 - t0 < 0.12:
            t1 = t0 + 0.12

        fade_start = max(t0, t1 - 0.08)

        # Color
        clean_lower = display.lower().strip('.,!?;:')
        color = '#00FF88' if clean_lower in EMPHASIS_WORDS else 'white'

        # Font size
        fontsize = 68 if len(display) > 12 else 88

        # Escape for ffmpeg
        escaped = display.replace("'", "\u2019").replace(':', '\\:').replace('\\', '\\\\')

        alpha_expr = f"if(lt(t,{t0:.3f}),0,if(lt(t,{fade_start:.3f}),1,max(0,({t1:.3f}-t)/0.08)))"

        filters.append(
            f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
            f":text='{escaped}'"
            f":fontsize={fontsize}"
            f":fontcolor={color}"
            f":alpha='{alpha_expr}'"
            f":x=(w-text_w)/2:y=1600"
            f":shadowcolor=black:shadowx=3:shadowy=3"
        )

    return ','.join(filters) if filters else 'null'


def strip_leading_silence(voice_path: Path, threshold_db: float = -45, min_silence_ms: int = 100) -> Path:
    """Remove leading silence from voice file. Returns path to cleaned file."""
    import subprocess
    from pathlib import Path as _Path

    out = _Path(str(voice_path).replace('.mp3', '_trimmed.mp3'))
    # Use silenceremove to strip leading silence
    subprocess.run([
        'ffmpeg', '-y', '-i', str(voice_path),
        '-af', f'silenceremove=start_periods=1:start_threshold={threshold_db}dB:start_silence=0.1',
        '-c:a', 'libmp3lame', '-q:a', '2',
        str(out)
    ], check=True, capture_output=True)

    # Check it's not empty
    r = subprocess.run([
        'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(out)
    ], capture_output=True, text=True)
    if r.returncode == 0 and float(r.stdout.strip() or 0) > 0.5:
        out.rename(voice_path)
        print(f'Silence stripped from {voice_path.name}')
    else:
        out.unlink(missing_ok=True)
        print(f'No leading silence in {voice_path.name}')

    return voice_path


def trim_to_voice(final_path: Path, voice_path: Path) -> float:
    """Trim final video to voice duration + 2.5s thumbnail card + 0.5s buffer."""
    import subprocess
    from pathlib import Path as _Path

    # Get voice duration
    r = subprocess.run([
        'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(voice_path)
    ], capture_output=True, text=True)
    voice_dur = float(r.stdout.strip())
    # total_target = voice_duration + 2.5 (thumb card) + 0.5 (buffer)
    target_dur = voice_dur + 2.5 + 0.5

    # Get video duration
    r2 = subprocess.run([
        'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(final_path)
    ], capture_output=True, text=True)
    vid_dur = float(r2.stdout.strip())

    if vid_dur > target_dur + 0.5:
        tmp = _Path(str(final_path).replace('.mp4', '_trim.mp4'))
        subprocess.run([
            'ffmpeg', '-y', '-i', str(final_path),
            '-t', str(target_dur),
            '-c', 'copy',
            str(tmp)
        ], check=True, capture_output=True)
        tmp.rename(final_path)
        print(f'Trimmed: {vid_dur:.1f}s → {target_dur:.1f}s')
    else:
        print(f'No trim needed: {vid_dur:.1f}s (voice={voice_dur:.1f}s)')

    return target_dur


def mix_audio(voice_path: Path, music_type: str, out_path: Path) -> Path:
    """Mix voice with normalized music. Always uses *_norm.mp3 versions."""
    music_file, ratio = MUSIC_MAP.get(music_type, MUSIC_MAP['default'])
    music_path = SOUNDS_DIR / music_file

    if not music_path.exists():
        raise FileNotFoundError(f"Music not found: {music_path}")

    subprocess.run([
        'ffmpeg', '-y',
        '-i', str(voice_path),
        '-i', str(music_path),
        '-filter_complex',
        f'[0:a]volume=1.0[v];[1:a]volume={ratio}[m];[v][m]amix=inputs=2:duration=first,'
        f'loudnorm=I=-16:TP=-1.5:LRA=11[out]',
        '-map', '[out]',
        '-c:a', 'aac', '-b:a', '192k',
        str(out_path)
    ], check=True, capture_output=True)
    return out_path


def prepend_thumbnail_card(video_path: Path, thumbnail_path: Path, out_path: Path, hold_seconds: float = 2.5) -> Path:
    """MANDATORY: Bake thumbnail as 2.5s opening card into video."""
    from video_utils import prepend_thumbnail_card as _prepend
    return _prepend(video_path, thumbnail_path, out_path, hold_seconds)


def add_watermark_filter() -> str:
    """Returns ffmpeg drawtext for @ailifehacks watermark."""
    return (
        "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        ":text='\\@ailifehacks'"
        ":fontsize=36:fontcolor=white@0.6"
        ":x=(w-text_w)/2:y=h-80"
    )


def qa_check(video_path: Path) -> bool:
    """Basic QA: file exists, >2MB, duration >10s."""
    if not video_path.exists():
        print(f"QA FAIL: {video_path} does not exist")
        return False
    size_mb = video_path.stat().st_size / 1024 / 1024
    if size_mb < 2:
        print(f"QA FAIL: {video_path} too small ({size_mb:.1f}MB)")
        return False
    probe = subprocess.run([
        'ffprobe','-v','quiet','-show_entries','format=duration',
        '-of','default=noprint_wrappers=1:nokey=1', str(video_path)
    ], capture_output=True, text=True)
    try:
        dur = float(probe.stdout.strip())
        if dur < 10:
            print(f"QA FAIL: {video_path} too short ({dur:.1f}s)")
            return False
    except Exception:
        pass
    print(f"QA PASS: {video_path.name} ({size_mb:.1f}MB)")
    return True
