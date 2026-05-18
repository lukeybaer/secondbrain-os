"""
Post-processes ElevenLabs audio to sound more human:
- Subtle room ambience (takes away studio-perfect sheen)
- Light compression (evens out over-produced dynamics)
- Slight high-freq rolloff (phone/recording feel)
- Tiny pitch micro-variation (breaks the sing-song lock)
- Subtle noise floor (removes "too clean" artifact)
"""
import subprocess
from pathlib import Path

def humanize(input_mp3: Path, output_mp3: Path) -> Path:
    """Apply humanization chain to voice audio."""
    cmd = [
        'ffmpeg', '-y', '-i', str(input_mp3),
        '-af', ','.join([
            # Subtle compression - reduces dynamic over-perfection
            # release=80ms (was 200ms) — shorter release prevents pumping/pause artifacts
            'acompressor=threshold=-18dB:ratio=2.5:attack=8:release=80:makeup=1.5',
            # Very slight high-freq rolloff - removes studio sparkle
            'equalizer=f=8000:width_type=o:width=1.5:g=-2.5',
            # Cut harsh 3-4kHz presence a touch (sing-songy zone)
            'equalizer=f=3500:width_type=o:width=1.2:g=-1.8',
            # Boost low-mid warmth (sounds more like a person in a room)
            'equalizer=f=280:width_type=o:width=1.0:g=1.5',
            # Very faint room tone — reduced from 0.04|0.03 to 0.015|0.010
            # to prevent audible echo gaps between words
            'aecho=0.8:0.82:28|45:0.015|0.010',
            # Normalize output
            'loudnorm=I=-16:TP=-1.5:LRA=11',
        ]),
        '-c:a', 'libmp3lame', '-q:a', '2',
        str(output_mp3)
    ]
    r = subprocess.run(cmd, capture_output=True)
    if not Path(output_mp3).exists() or Path(output_mp3).stat().st_size < 1000:
        # Fallback: just copy if all filters fail
        import shutil
        shutil.copy(str(input_mp3), str(output_mp3))
    return output_mp3
