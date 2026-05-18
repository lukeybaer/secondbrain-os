"""
Three-tier Hebbian memory store.

Port of secondbrain-os/src/main/memory-index.ts. The Graphiti cascade is
intentionally omitted; the TS version treats it as fire-and-forget anyway.

Tier 1  MEMORY.md         always-loaded pointer file, capped at 50 lines
Tier 2  <topic>.md + index.json   one file per topic, weighted, decays
Tier 3  archive/YYYY-MM-DD.md     append-only, entries land here below 0.05

Weight rules:
  new entry          weight 0.2, decay_rate 0.1
  re-access (dedup)  mentions++, last_accessed reset
  promotion          mentions >= 3 -> weight 0.8, decay_rate 0.02
  daily decay        weight *= (1 - decay_rate) ** days_since_access
  archive threshold  weight < 0.05  -> moved to archive, removed from index
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

WORKING_MEMORY_MAX_LINES = 50
ARCHIVE_THRESHOLD = 0.05
PROMOTION_MENTIONS = 3
PROMOTION_WEIGHT = 0.8
INITIAL_WEIGHT = 0.2
INITIAL_DECAY = 0.1
PROMOTED_DECAY = 0.02


@dataclass
class MemoryEntry:
    id: str
    topic: str
    file: str
    weight: float
    mentions: int
    last_accessed: str
    decay_rate: float
    valid_at: str
    tier: int = 2
    invalid_at: Optional[str] = None


@dataclass
class MemoryIndex:
    version: int = 1
    last_updated: str = field(default_factory=lambda: date.today().isoformat())
    entries: list[MemoryEntry] = field(default_factory=list)
    hashes: list[str] = field(default_factory=list)


def _today() -> str:
    return date.today().isoformat()


def _md5(content: str) -> str:
    return hashlib.md5(content.strip().encode("utf-8")).hexdigest()


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50]


class MemoryStore:
    """Three-tier memory store rooted at a directory on disk."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.archive_dir = self.root / "archive"
        self.index_path = self.root / "index.json"
        self.working_path = self.root / "MEMORY.md"
        self._cache: Optional[MemoryIndex] = None

    def init(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        self._load_index()

    # ── Index I/O ──────────────────────────────────────────────────────────
    def _load_index(self) -> MemoryIndex:
        if self._cache is not None:
            return self._cache
        if not self.index_path.exists():
            self._cache = MemoryIndex()
            self._save_index()
            return self._cache
        try:
            raw = json.loads(self.index_path.read_text("utf-8"))
            self._cache = MemoryIndex(
                version=raw.get("version", 1),
                last_updated=raw.get("last_updated", _today()),
                entries=[MemoryEntry(**e) for e in raw.get("entries", [])],
                hashes=list(raw.get("hashes", [])),
            )
            return self._cache
        except (json.JSONDecodeError, TypeError, KeyError):
            self._cache = MemoryIndex()
            return self._cache

    def _save_index(self) -> None:
        assert self._cache is not None
        self._cache.last_updated = _today()
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": self._cache.version,
            "last_updated": self._cache.last_updated,
            "entries": [asdict(e) for e in self._cache.entries],
            "hashes": list(self._cache.hashes),
        }
        self.index_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    # ── Tier 1: Working Memory ─────────────────────────────────────────────
    def read_working(self) -> str:
        if not self.working_path.exists():
            return ""
        return self.working_path.read_text("utf-8")

    def write_working(self, content: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        lines = content.split("\n")
        if len(lines) > WORKING_MEMORY_MAX_LINES:
            lines = lines[-WORKING_MEMORY_MAX_LINES:]
        self.working_path.write_text("\n".join(lines), encoding="utf-8")

    def append_working(self, line: str) -> None:
        existing = self.read_working()
        dated = f"[{_today()}] {line}"
        self.write_working(f"{existing}\n{dated}" if existing else dated)

    # ── Tier 2: Indexed Memory ─────────────────────────────────────────────
    def upsert(
        self,
        topic: str,
        content: str,
        *,
        decay_rate: Optional[float] = None,
        file: Optional[str] = None,
    ) -> MemoryEntry:
        index = self._load_index()
        h = _md5(content)

        existing = next(
            (e for e in index.entries if e.id == h and e.invalid_at is None),
            None,
        )
        if existing is not None:
            existing.mentions += 1
            existing.last_accessed = _today()
            # Mirrors TS quirk: any per-entry custom rate is overwritten on re-access.
            existing.decay_rate = (
                PROMOTED_DECAY if existing.mentions >= PROMOTION_MENTIONS else INITIAL_DECAY
            )
            if existing.mentions >= PROMOTION_MENTIONS and existing.weight < 0.5:
                existing.weight = PROMOTION_WEIGHT
            existing.weight = min(1.0, existing.weight)
            self._save_index()
            return existing

        fname = file or f"{_slugify(topic)}.md"
        entry = MemoryEntry(
            id=h,
            topic=topic,
            file=fname,
            weight=INITIAL_WEIGHT,
            mentions=1,
            last_accessed=_today(),
            decay_rate=INITIAL_DECAY if decay_rate is None else decay_rate,
            valid_at=_today(),
            tier=2,
        )

        file_path = self.root / fname
        file_path.parent.mkdir(parents=True, exist_ok=True)
        header = (
            f"# {topic}\n"
            f"*weight: {entry.weight} | mentions: {entry.mentions} "
            f"| valid_from: {entry.valid_at}*\n\n"
        )
        file_path.write_text(header + content, encoding="utf-8")

        index.entries.append(entry)
        index.hashes.append(h)
        self._save_index()
        return entry

    def invalidate(
        self, entry_id: str, replacement_content: Optional[str] = None
    ) -> None:
        index = self._load_index()
        target = next((e for e in index.entries if e.id == entry_id), None)
        if target is not None:
            target.invalid_at = _today()
            target.weight = 0.0
        self._save_index()
        if replacement_content and target is not None:
            self.upsert(target.topic, replacement_content)

    def load_relevant(
        self, min_weight: float = 0.3, max_entries: int = 8
    ) -> list[tuple[MemoryEntry, str]]:
        index = self._load_index()
        relevant = sorted(
            (
                e
                for e in index.entries
                if e.tier == 2 and e.invalid_at is None and e.weight >= min_weight
            ),
            key=lambda e: e.weight,
            reverse=True,
        )[:max_entries]

        results: list[tuple[MemoryEntry, str]] = []
        touched = False
        for entry in relevant:
            file_path = self.root / entry.file
            if not file_path.exists():
                continue
            results.append((entry, file_path.read_text("utf-8")))
            entry.mentions += 1
            entry.last_accessed = _today()
            touched = True
        if touched:
            self._save_index()
        return results

    # ── Tier 3: Archive ────────────────────────────────────────────────────
    def append_archive(self, content: str) -> None:
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        file_path = self.archive_dir / f"{_today()}.md"
        stamp = datetime.now(timezone.utc).isoformat()
        with file_path.open("a", encoding="utf-8") as f:
            f.write(f"\n---\n*{stamp}*\n{content}\n")

    def load_archive(self, day: str) -> str:
        file_path = self.archive_dir / f"{day}.md"
        if not file_path.exists():
            return ""
        return file_path.read_text("utf-8")

    # ── Nightly decay ──────────────────────────────────────────────────────
    def run_nightly_decay(self) -> dict[str, int]:
        index = self._load_index()
        decayed = 0
        archived = 0
        pruned = 0
        to_remove: set[str] = set()

        for entry in list(index.entries):
            if entry.tier != 2 or entry.invalid_at is not None:
                continue

            days = (date.today() - date.fromisoformat(entry.last_accessed)).days
            if days > 0:
                old = entry.weight
                entry.weight = max(
                    0.0, entry.weight * ((1.0 - entry.decay_rate) ** days)
                )
                if entry.weight != old:
                    decayed += 1

            if entry.weight < ARCHIVE_THRESHOLD and entry.invalid_at is None:
                file_path = self.root / entry.file
                if file_path.exists():
                    self.append_archive(
                        f"## {entry.topic} (archived — weight: {entry.weight:.3f})\n"
                        f"{file_path.read_text('utf-8')}"
                    )
                    file_path.unlink()
                    archived += 1
                to_remove.add(entry.id)
                pruned += 1

        if to_remove:
            index.entries = [e for e in index.entries if e.id not in to_remove]
            index.hashes = [h for h in index.hashes if h not in to_remove]

        self._save_index()
        return {"decayed": decayed, "archived": archived, "pruned": pruned}

    # ── Context builder ────────────────────────────────────────────────────
    def build_context(self, *, max_chars: int = 3000, min_weight: float = 0.3) -> str:
        working = self.read_working()
        tier2 = self.load_relevant(min_weight=min_weight, max_entries=6)

        parts: list[str] = []
        if working.strip():
            parts.append(f"### Working Memory\n{working.strip()}")
        for entry, content in tier2:
            parts.append(
                f"### {entry.topic} (weight: {entry.weight:.2f})\n{content[:500]}"
            )

        combined = "\n\n".join(parts)
        if len(combined) > max_chars:
            return combined[:max_chars] + "\n\n*(memory truncated)*"
        return combined


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(Path(tmp) / "memory")
        store.init()
        store.write_working("Owner: Demo User\nTimezone: CT")

        for _ in range(3):
            store.upsert("dentist project", "Found a dentist who skips X-rays.")
        store.upsert("low-stakes note", "Tried a new coffee shop.")

        # Simulate 30 days of inactivity on the low-stakes note.
        idx = store._load_index()
        for e in idx.entries:
            if e.topic == "low-stakes note":
                e.last_accessed = (date.today() - timedelta(days=30)).isoformat()
        store._save_index()

        print("Before decay:")
        for e in store._load_index().entries:
            print(f"  {e.topic:25s} w={e.weight:.3f} m={e.mentions}")

        stats = store.run_nightly_decay()
        print(f"\nDecay stats: {stats}\n")

        print("After decay:")
        for e in store._load_index().entries:
            print(f"  {e.topic:25s} w={e.weight:.3f} m={e.mentions}")

        print("\n--- build_context() ---")
        print(store.build_context())
