#!/usr/bin/env python3
"""
transcribe.py
Transcribe audio/video files using faster-whisper with word-level timestamps.
Used by SecondBrain Studio for the recording pipeline.

Usage:
    python transcribe.py <audio_path> --output-format json
    python transcribe.py <audio_path> --output-format srt
    python transcribe.py <audio_path> --model small

Requirements:
    pip install faster-whisper
"""

import sys
import json
import argparse
from pathlib import Path


def transcribe(audio_path: str, model_size: str = "small", device: str = "auto") -> dict:
    """Transcribe audio file and return word-level timestamps."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({
            "error": "faster-whisper not installed. Run: pip install faster-whisper",
            "words": [],
            "text": ""
        }))
        sys.exit(1)

    # Determine compute type based on device
    if device == "auto":
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
                compute_type = "float16"
            else:
                device = "cpu"
                compute_type = "int8"
        except ImportError:
            device = "cpu"
            compute_type = "int8"
    elif device == "cuda":
        compute_type = "float16"
    else:
        compute_type = "int8"

    # Load model
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    # Transcribe with word timestamps
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=500,
            speech_pad_ms=200,
        ),
    )

    words = []
    full_text_parts = []

    for segment in segments:
        full_text_parts.append(segment.text.strip())
        if segment.words:
            for word in segment.words:
                words.append({
                    "word": word.word.strip(),
                    "start": round(word.start, 3),
                    "end": round(word.end, 3),
                    "probability": round(word.probability, 3),
                })

    return {
        "words": words,
        "text": " ".join(full_text_parts),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
    }


def words_to_srt(words: list, max_words_per_line: int = 8, max_chars: int = 42) -> str:
    """Convert word-level timestamps to SRT subtitle format."""
    entries = []
    index = 1
    line_words = []
    line_start = None

    for w in words:
        if line_start is None:
            line_start = w["start"]
        line_words.append(w["word"])
        line_text = " ".join(line_words)
        duration = w["end"] - line_start

        if len(line_words) >= max_words_per_line or len(line_text) >= max_chars or duration >= 3.5:
            entries.append({
                "index": index,
                "start": format_srt_time(line_start),
                "end": format_srt_time(w["end"]),
                "text": line_text,
            })
            index += 1
            line_words = []
            line_start = None

    # Flush remaining
    if line_words:
        entries.append({
            "index": index,
            "start": format_srt_time(line_start),
            "end": format_srt_time(words[-1]["end"]),
            "text": " ".join(line_words),
        })

    lines = []
    for e in entries:
        lines.append(f"{e['index']}")
        lines.append(f"{e['start']} --> {e['end']}")
        lines.append(e["text"])
        lines.append("")

    return "\n".join(lines)


def format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio with word-level timestamps")
    parser.add_argument("audio_path", help="Path to audio/video file")
    parser.add_argument("--output-format", choices=["json", "srt"], default="json")
    parser.add_argument("--model", default="small", help="Whisper model size")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    args = parser.parse_args()

    if not Path(args.audio_path).exists():
        print(json.dumps({"error": f"File not found: {args.audio_path}", "words": [], "text": ""}))
        sys.exit(1)

    result = transcribe(args.audio_path, model_size=args.model, device=args.device)

    if args.output_format == "json":
        print(json.dumps(result, ensure_ascii=False))
    elif args.output_format == "srt":
        print(words_to_srt(result["words"]))


if __name__ == "__main__":
    main()
