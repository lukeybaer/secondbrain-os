from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import pytest

from memory_index import (
    ARCHIVE_THRESHOLD,
    INITIAL_DECAY,
    INITIAL_WEIGHT,
    PROMOTED_DECAY,
    PROMOTION_MENTIONS,
    PROMOTION_WEIGHT,
    WORKING_MEMORY_MAX_LINES,
    MemoryStore,
    _md5,
    _slugify,
)


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "memory")
    s.init()
    return s


def _backdate(store: MemoryStore, entry_id: str, days: int) -> None:
    """Rewind an entry's last_accessed to simulate elapsed time."""
    idx = store._load_index()
    target = next(e for e in idx.entries if e.id == entry_id)
    target.last_accessed = (date.today() - timedelta(days=days)).isoformat()
    store._save_index()


# ── init / disk layout ────────────────────────────────────────────────────────


def test_init_creates_layout(store: MemoryStore) -> None:
    assert store.root.exists()
    assert store.archive_dir.exists()
    assert store.index_path.exists()


# ── upsert ────────────────────────────────────────────────────────────────────


def test_upsert_writes_file_and_index(store: MemoryStore) -> None:
    entry = store.upsert("dentist project", "Found a dentist who skips X-rays.")
    assert entry.weight == INITIAL_WEIGHT
    assert entry.mentions == 1
    assert entry.decay_rate == INITIAL_DECAY
    assert entry.invalid_at is None

    file_path = store.root / entry.file
    assert file_path.exists()
    content = file_path.read_text("utf-8")
    assert "Found a dentist" in content
    assert "weight: 0.2" in content


def test_upsert_dedupes_by_content_hash(store: MemoryStore) -> None:
    a = store.upsert("topic", "same content")
    b = store.upsert("topic", "same content")
    assert a.id == b.id
    assert b.mentions == 2

    idx = store._load_index()
    assert len([e for e in idx.entries if e.id == a.id]) == 1


def test_md5_normalizes_whitespace() -> None:
    assert _md5("hello") == _md5("  hello  ")
    assert _md5("hello") != _md5("hello world")


def test_slugify_caps_and_cleans() -> None:
    assert _slugify("Hello World!") == "hello-world"
    assert _slugify("a" * 100) == "a" * 50
    assert _slugify("---dashes---") == "dashes"


# ── promotion ─────────────────────────────────────────────────────────────────


def test_promotion_at_three_mentions(store: MemoryStore) -> None:
    entry = None
    for _ in range(3):
        entry = store.upsert("hot topic", "Used a lot.")
    assert entry is not None
    assert entry.mentions == PROMOTION_MENTIONS
    assert entry.weight == PROMOTION_WEIGHT
    assert entry.decay_rate == PROMOTED_DECAY


def test_promotion_does_not_demote_already_high_weight(store: MemoryStore) -> None:
    for _ in range(3):
        entry = store.upsert("hot topic", "Used a lot.")
    # Manually bump above 0.8 to verify the < 0.5 guard
    idx = store._load_index()
    target = next(e for e in idx.entries if e.id == entry.id)
    target.weight = 0.95
    store._save_index()

    entry = store.upsert("hot topic", "Used a lot.")
    assert entry.weight == 0.95  # left alone, not snapped back to 0.8


def test_weight_clamped_to_one(store: MemoryStore) -> None:
    for _ in range(3):
        entry = store.upsert("hot topic", "Used a lot.")
    idx = store._load_index()
    target = next(e for e in idx.entries if e.id == entry.id)
    target.weight = 1.5  # corrupt the file directly
    store._save_index()

    entry = store.upsert("hot topic", "Used a lot.")
    assert entry.weight <= 1.0


# ── invalidate ────────────────────────────────────────────────────────────────


def test_invalidate_marks_but_does_not_delete(store: MemoryStore) -> None:
    entry = store.upsert("old fact", "I used to live in Austin.")
    store.invalidate(entry.id, replacement_content="I live in NYC now.")

    idx = store._load_index()
    old = next(e for e in idx.entries if e.id == entry.id)
    assert old.invalid_at is not None
    assert old.weight == 0.0

    # Replacement exists as a separate live entry.
    live = [e for e in idx.entries if e.invalid_at is None]
    assert len(live) == 1
    assert live[0].id != entry.id


def test_dedup_skips_invalidated_entries(store: MemoryStore) -> None:
    """Re-upserting the same content after invalidation creates a fresh entry."""
    a = store.upsert("topic", "same content")
    store.invalidate(a.id)
    b = store.upsert("topic", "same content")

    # Same hash, but the invalidated entry is ignored by the dedup lookup,
    # so a new live entry sits alongside it.
    idx = store._load_index()
    matching = [e for e in idx.entries if e.id == a.id]
    assert any(e.invalid_at is not None for e in matching)
    assert any(e.invalid_at is None for e in matching)
    assert b.mentions == 1  # fresh, not bumped


# ── load_relevant ─────────────────────────────────────────────────────────────


def test_load_relevant_filters_by_weight(store: MemoryStore) -> None:
    low = store.upsert("low", "low importance")
    high = None
    for _ in range(3):
        high = store.upsert("high", "high importance")

    results = store.load_relevant(min_weight=0.3)
    ids = [e.id for e, _ in results]
    assert high.id in ids
    assert low.id not in ids


def test_load_relevant_bumps_mentions(store: MemoryStore) -> None:
    for _ in range(3):
        entry = store.upsert("x", "x")
    before = entry.mentions
    store.load_relevant(min_weight=0.3)
    refreshed = next(e for e in store._load_index().entries if e.id == entry.id)
    assert refreshed.mentions == before + 1


def test_load_relevant_skips_missing_files(store: MemoryStore) -> None:
    for _ in range(3):
        entry = store.upsert("ghost", "x")
    (store.root / entry.file).unlink()
    results = store.load_relevant(min_weight=0.3)
    assert results == []


def test_load_relevant_orders_by_weight_descending(store: MemoryStore) -> None:
    for _ in range(3):
        high = store.upsert("high", "high")
    for _ in range(3):
        mid = store.upsert("mid", "mid")
    # Pull mid back down so the order is observable.
    idx = store._load_index()
    next(e for e in idx.entries if e.id == mid.id).weight = 0.5
    next(e for e in idx.entries if e.id == high.id).weight = 0.9
    store._save_index()

    results = store.load_relevant(min_weight=0.3)
    assert [e.id for e, _ in results] == [high.id, mid.id]


# ── decay ─────────────────────────────────────────────────────────────────────


def test_nightly_decay_multiplicative(store: MemoryStore) -> None:
    entry = store.upsert("aged", "An old fact.")
    _backdate(store, entry.id, days=5)

    stats = store.run_nightly_decay()
    refreshed = next(e for e in store._load_index().entries if e.id == entry.id)

    expected = INITIAL_WEIGHT * ((1 - INITIAL_DECAY) ** 5)
    assert refreshed.weight == pytest.approx(expected)
    assert stats["decayed"] == 1
    assert stats["archived"] == 0
    assert expected >= ARCHIVE_THRESHOLD


def test_nightly_decay_archives_below_threshold(store: MemoryStore) -> None:
    entry = store.upsert("doomed", "Will be archived.")
    _backdate(store, entry.id, days=60)  # 0.2 * 0.9^60 ≈ 0.00037

    file_path = store.root / entry.file
    assert file_path.exists()

    stats = store.run_nightly_decay()
    assert stats["archived"] == 1
    assert stats["pruned"] == 1
    assert not file_path.exists()

    archive_files = list(store.archive_dir.glob("*.md"))
    assert len(archive_files) == 1
    archive_text = archive_files[0].read_text("utf-8")
    assert "Will be archived" in archive_text
    assert "doomed" in archive_text

    idx = store._load_index()
    assert all(e.id != entry.id for e in idx.entries)
    assert entry.id not in idx.hashes


def test_promoted_entries_decay_more_slowly(store: MemoryStore) -> None:
    fresh = store.upsert("fresh", "weak signal")
    for _ in range(3):
        promoted = store.upsert("promoted", "strong signal")
    _backdate(store, fresh.id, days=10)
    _backdate(store, promoted.id, days=10)

    store.run_nightly_decay()
    refreshed = {e.id: e for e in store._load_index().entries}

    fresh_w = refreshed[fresh.id].weight
    promoted_w = refreshed[promoted.id].weight
    assert promoted_w == pytest.approx(PROMOTION_WEIGHT * ((1 - PROMOTED_DECAY) ** 10))
    assert fresh_w == pytest.approx(INITIAL_WEIGHT * ((1 - INITIAL_DECAY) ** 10))
    assert promoted_w > fresh_w


def test_decay_skips_invalidated(store: MemoryStore) -> None:
    entry = store.upsert("zombie", "shh")
    store.invalidate(entry.id)
    _backdate(store, entry.id, days=100)
    stats = store.run_nightly_decay()
    assert stats == {"decayed": 0, "archived": 0, "pruned": 0}


# ── working memory ────────────────────────────────────────────────────────────


def test_working_memory_truncates_to_max_lines(store: MemoryStore) -> None:
    lines = [f"line {i}" for i in range(60)]
    store.write_working("\n".join(lines))
    saved = store.read_working().split("\n")
    assert len(saved) == WORKING_MEMORY_MAX_LINES
    assert "line 59" in saved
    assert "line 9" not in saved


def test_append_working_dates_entries(store: MemoryStore) -> None:
    store.append_working("first thought")
    store.append_working("second thought")
    text = store.read_working()
    today = date.today().isoformat()
    assert text.count(f"[{today}]") == 2
    assert "first thought" in text
    assert "second thought" in text


# ── archive ───────────────────────────────────────────────────────────────────


def test_append_archive_writes_dated_block(store: MemoryStore) -> None:
    store.append_archive("first")
    store.append_archive("second")
    text = store.load_archive(date.today().isoformat())
    assert "first" in text
    assert "second" in text
    assert text.count("---") == 2


# ── context builder ───────────────────────────────────────────────────────────


def test_build_context_includes_working_and_promoted(store: MemoryStore) -> None:
    store.write_working("Owner: Test User\nTimezone: CT")
    for _ in range(3):
        store.upsert("project alpha", "Alpha is the priority this quarter.")

    ctx = store.build_context(min_weight=0.3)
    assert "Working Memory" in ctx
    assert "Owner: Test User" in ctx
    assert "project alpha" in ctx


def test_build_context_truncates_at_max_chars(store: MemoryStore) -> None:
    store.write_working("x" * 5000)
    ctx = store.build_context(max_chars=500)
    assert len(ctx) <= 500 + len("\n\n*(memory truncated)*")
    assert ctx.endswith("*(memory truncated)*")
