#!/usr/bin/env python3
"""
pii-ner-scan.py

Layer 2 of the 3-layer PII screen. Walks a target directory, runs Microsoft
Presidio's PERSON / EMAIL / PHONE / LOCATION analyzers against every text
file, and emits a JSON report of any entity that is NOT on the explicit
public-figures allowlist (data/agent/pii-allowlist.json).

Why Presidio:
    Layer 1 is a known-name match — fast and deterministic, but only catches
    names already in memory. If a new person ("PRIVATE_NAME") is mentioned in
    source code who isn't yet a contact, Layer 1 misses them. Presidio's
    spaCy-based NER detects PERSON entities semantically and flags them
    regardless of whether they're in our denylist.

Usage:
    python scripts/pii-ner-scan.py [target_dir]

Exit codes:
    0 = clean (every targeted file actually scanned)
    1 = unallowlisted entities found
    2 = setup error, OR incomplete coverage -- a file we meant to scan could
        not be read or analyzed, so CLEAN is unprovable and the gate blocks
"""

import json
import os
import sys
from collections import namedtuple
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_TARGET = REPO
ALLOWLIST_PATH = REPO / "data" / "agent" / "pii-allowlist.json"

# Layer 2 (NER) runs on prose only -- spaCy's PERSON model gets too many false
# positives on code identifiers (process.argv, setTimeout, package versions).
# Code files are covered by Layer 1 (deterministic denylist).
TEXT_EXTS = {".md", ".txt"}
SKIP_DIRS = {
    "node_modules", ".git", "dist", "out", "build", ".claude",
    "__pycache__", ".venv", "venv", ".next", ".cache",
}
SELF_SKIP = {
    "scripts/build-pii-denylist.js",
    "scripts/pii-screen.js",
    "scripts/pii-ner-scan.py",
    "scripts/pii-llm-gate.js",
    "scripts/simulate-public-sync.js",
    "data/agent/pii-denylist.json",
    "data/agent/pii-allowlist.json",
    "data/agent/known-people.json",
    ".github/workflows/sync-to-public.yml",
    "tests/pii-screen.spec.ts",
}

ENTITIES_TO_CHECK = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_SSN", "CREDIT_CARD"]
SCORE_THRESHOLD = 0.85

# Long files are CHUNKED, never skipped. A size skip was a silent coverage
# hole, and the biggest prose files are exactly where a leak hides. Chunks are
# line-aligned slices of the stripped text and carry their base offset so hit
# line numbers stay correct against the whole file.
CHUNK_CHARS = 100_000

# Longest entity span the analyzer can emit. A logical line longer than
# CHUNK_CHARS cannot be cut on a newline, so its cut lands mid-line, and a
# mid-line cut with no overlap silently drops any entity straddling it.
# Overlapping every mid-line cut by this much means the whole entity always
# lands inside at least one chunk. 512 clears the widest span these analyzers
# produce (an RFC-max EMAIL_ADDRESS is 254 characters).
MAX_ENTITY_CHARS = 512

Span = namedtuple("Span", "entity_type start end score")

# Common placeholder/generic names that legitimately appear in docs and
# should never be treated as PII even when Presidio flags them.
GENERIC_NAMES = {
    "john doe", "jane doe", "john smith", "jane smith",
    "PRIVATE_NAME", "bob", "carol", "dave", "eve",
    "foo", "bar", "baz", "qux",
    "anyone", "someone", "everybody",
    "lorem ipsum",
}


def load_allowlist():
    if not ALLOWLIST_PATH.exists():
        return {"names": set(), "emails": set(), "domains": set(), "tokens": set()}
    raw = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    return {
        "names": {n.lower() for n in raw.get("names", [])},
        "emails": {e.lower() for e in raw.get("emails", [])},
        "domains": {d.lower() for d in raw.get("domains", [])},
        "tokens": {t.lower() for t in raw.get("tokens", [])},
    }


def walk(target):
    """Returns (files, failures).

    os.walk swallows OSError by default, so a directory it cannot list simply
    contributes zero files and the scan still prints CLEAN -- an unreadable
    tree is indistinguishable from an empty one. The onerror callback records
    the traversal failure instead, so the coverage hole blocks exactly the way
    an unreadable file already does."""
    out = []
    failures = []

    def on_error(err):
        where = getattr(err, "filename", None) or target
        failures.append({
            "file": str(where).replace("\\", "/"),
            "reason": f"directory walk failed: {err}",
        })

    for root, dirs, files in os.walk(target, onerror=on_error):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for f in files:
            full = Path(root) / f
            if full.suffix.lower() in TEXT_EXTS:
                out.append(full)
    return out, failures


def is_allowed(entity_type, text, allowlist):
    t = text.lower().strip()
    if entity_type == "PERSON":
        # Single-token PERSON matches are too noisy with NER (any capitalized
        # word becomes a candidate). Layer 1 catches single first names from
        # memory deterministically; Layer 2 only blocks on multi-word PERSON
        # entities that look like real "FirstName LastName" patterns.
        words = text.split()
        if len(words) < 2:
            return True
        if t in GENERIC_NAMES:
            return True
        if any(c in t for c in "().[]{}=/<>"):
            return True
        if any(c.isdigit() for c in t):
            return True
        if len(t) < 5:
            return True
        if t == text and t.lower() == t:
            return True
        first_word = t.split()[0] if t.split() else t
        if first_word in allowlist["tokens"]:
            return True
        for tok in allowlist["tokens"]:
            if first_word == tok.lower() or t == tok.lower() or tok.lower() in t:
                return True
        for name in allowlist["names"]:
            if t == name:
                return True
            if t in name.split() or name in t.split():
                return True
            if first_word in name.split():
                return True
        return False
    if entity_type == "EMAIL_ADDRESS":
        if t in allowlist["emails"]:
            return True
        domain = t.split("@", 1)[-1] if "@" in t else ""
        return domain in allowlist["domains"]
    return False


def strip_code_blocks(text):
    """Remove fenced code blocks (```...```) and inline code (`...`) from
    markdown. Presidio's NER on code identifiers (setTimeout, addEpisode)
    creates massive false positives, so we exclude code from analysis."""
    out = []
    in_fence = False
    for line in text.split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            out.append("")
            continue
        if in_fence:
            out.append("")
            continue
        cleaned = []
        i = 0
        while i < len(line):
            if line[i] == "`":
                end = line.find("`", i + 1)
                if end > 0:
                    i = end + 1
                    continue
            cleaned.append(line[i])
            i += 1
        out.append("".join(cleaned))
    return "\n".join(out)


def chunk_offsets(text, size=CHUNK_CHARS, overlap=MAX_ENTITY_CHARS):
    """Line-aligned [start, stop) spans covering the WHOLE text, no gaps.

    A logical line longer than `size` has no newline to cut on, so that cut
    lands mid-line. Mid-line cuts back the next chunk up by `overlap`
    characters, so an entity straddling the seam still lands whole inside a
    chunk. The duplicate hits the overlap produces are de-duplicated by
    absolute span in main()."""
    if len(text) <= size:
        return [(0, len(text))]
    spans = []
    start = 0
    while start < len(text):
        stop = min(start + size, len(text))
        next_start = stop
        if stop < len(text):
            newline = text.rfind("\n", start, stop)
            if newline > start:
                stop = newline + 1
                next_start = stop
            else:
                next_start = max(stop - overlap, start + 1)
        spans.append((start, stop))
        start = next_start
    return spans


def main():
    args = sys.argv[1:]
    target = Path(args[0]) if args else DEFAULT_TARGET
    target = target.resolve()

    try:
        from presidio_analyzer import AnalyzerEngine
    except ImportError:
        print("[pii-ner] presidio-analyzer not installed. Run: pip install presidio-analyzer && python -m spacy download en_core_web_sm", file=sys.stderr)
        sys.exit(2)

    analyzer = AnalyzerEngine()
    allowlist = load_allowlist()
    files, traversal_failures = walk(target)

    hits = []
    # Files we MEANT to scan and could not. Intentional filters (SKIP_DIRS,
    # non-prose extensions, SELF_SKIP) are deliberate design, not coverage
    # gaps, and never land here -- only traversal, read, decode and analyzer
    # failures do.
    uncovered = list(traversal_failures)
    for f in files:
        rel = str(f.relative_to(REPO if str(f).startswith(str(REPO)) else target)).replace("\\", "/")
        if rel in SELF_SKIP:
            continue
        try:
            content = f.read_text(encoding="utf-8")
        except UnicodeDecodeError as e:
            # errors="ignore" used to drop the undecodable bytes and scan what
            # was left, reporting a partial read as a full one. Only declared
            # prose files (TEXT_EXTS) reach here, so assets and binaries stay
            # legitimate skips while undecodable prose is honestly uncovered.
            # This clause must precede the generic handler: UnicodeDecodeError
            # is a ValueError, not an OSError, so it would otherwise be
            # mislabeled "read failed".
            print(f"[pii-ner] decode error on {rel}: {e}", file=sys.stderr)
            uncovered.append({"file": rel, "reason": f"not valid UTF-8: {e}"})
            continue
        except Exception as e:
            print(f"[pii-ner] read error on {rel}: {e}", file=sys.stderr)
            uncovered.append({"file": rel, "reason": f"read failed: {e}"})
            continue

        scan_text = strip_code_blocks(content)
        results = []
        # Overlapped mid-line cuts scan the seam twice on purpose, so the same
        # entity can come back from two chunks. Absolute span is the identity.
        seen_spans = set()
        analyzer_error = None
        for base, stop in chunk_offsets(scan_text):
            try:
                found = analyzer.analyze(
                    text=scan_text[base:stop],
                    entities=ENTITIES_TO_CHECK,
                    language="en",
                    score_threshold=SCORE_THRESHOLD,
                )
            except Exception as e:
                analyzer_error = f"analyzer failed at offset {base}: {e}"
                break
            for r in found:
                span = Span(r.entity_type, r.start + base, r.end + base, r.score)
                key = (span.entity_type, span.start, span.end)
                if key in seen_spans:
                    continue
                seen_spans.add(key)
                results.append(span)
        if analyzer_error is not None:
            print(f"[pii-ner] analyzer error on {rel}: {analyzer_error}", file=sys.stderr)
            uncovered.append({"file": rel, "reason": analyzer_error})
            continue

        for r in results:
            matched = scan_text[r.start:r.end]
            if is_allowed(r.entity_type, matched, allowlist):
                continue
            line_num = scan_text[:r.start].count("\n") + 1
            line_start = scan_text.rfind("\n", 0, r.start) + 1
            line_end = scan_text.find("\n", r.end)
            if line_end < 0:
                line_end = len(scan_text)
            line_text = scan_text[line_start:line_end].strip()[:160]
            hits.append({
                "file": rel,
                "line": line_num,
                "entity_type": r.entity_type,
                "match": matched,
                "score": round(r.score, 2),
                "context": line_text,
            })

    if hits:
        print(f"[pii-ner] {len(hits)} entities flagged in {target}:")
        by_file = {}
        for h in hits:
            by_file.setdefault(h["file"], []).append(h)
        for file, fhits in by_file.items():
            print(f"  {file} ({len(fhits)}):")
            for h in fhits[:5]:
                print(f"    :{h['line']} [{h['entity_type']}={h['match']!r} score={h['score']}] {h['context']}")
            if len(fhits) > 5:
                print(f"    ... +{len(fhits) - 5} more")

    if uncovered:
        print(
            f"[pii-ner] FAIL-CLOSED -- {len(uncovered)} file(s) NOT covered in {target}; "
            "a partial scan cannot prove CLEAN:",
            file=sys.stderr,
        )
        for u in uncovered[:20]:
            print(f"  {u['file']}: {u['reason']}", file=sys.stderr)
        if len(uncovered) > 20:
            print(f"  ... +{len(uncovered) - 20} more", file=sys.stderr)
        return 2

    if hits:
        return 1

    print(f"[pii-ner] CLEAN -- 0 entities flagged in {target} ({len(files)} files scanned)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
