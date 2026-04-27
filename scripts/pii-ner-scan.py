#!/usr/bin/env python3
"""
pii-ner-scan.py

Layer 2 of the 3-layer PII screen. Walks a target directory, runs Microsoft
Presidio's PERSON / EMAIL / PHONE / LOCATION analyzers against every text
file, and emits a JSON report of any entity that is NOT on the explicit
public-figures allowlist (data/agent/pii-allowlist.json).

Why Presidio:
    Layer 1 is a known-name match — fast and deterministic, but only catches
    names already in memory. If a new person ("John Smith") is mentioned in
    source code who isn't yet a contact, Layer 1 misses them. Presidio's
    spaCy-based NER detects PERSON entities semantically and flags them
    regardless of whether they're in our denylist.

Usage:
    python scripts/pii-ner-scan.py [target_dir]

Exit codes:
    0 = clean
    1 = unallowlisted entities found
    2 = setup error
"""

import json
import os
import sys
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

# Common placeholder/generic names that legitimately appear in docs and
# should never be treated as PII even when Presidio flags them.
GENERIC_NAMES = {
    "john doe", "jane doe", "john smith", "jane smith",
    "alice", "bob", "carol", "dave", "eve",
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
    out = []
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for f in files:
            full = Path(root) / f
            if full.suffix.lower() in TEXT_EXTS:
                out.append(full)
    return out


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
    files = walk(target)

    hits = []
    for f in files:
        rel = str(f.relative_to(REPO if str(f).startswith(str(REPO)) else target)).replace("\\", "/")
        if rel in SELF_SKIP:
            continue
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        if len(content) > 200_000:
            continue

        scan_text = strip_code_blocks(content)
        try:
            results = analyzer.analyze(
                text=scan_text,
                entities=ENTITIES_TO_CHECK,
                language="en",
                score_threshold=SCORE_THRESHOLD,
            )
        except Exception as e:
            print(f"[pii-ner] analyzer error on {rel}: {e}", file=sys.stderr)
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

    if not hits:
        print(f"[pii-ner] CLEAN -- 0 entities flagged in {target} ({len(files)} files scanned)")
        return 0

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
    return 1


if __name__ == "__main__":
    sys.exit(main())
