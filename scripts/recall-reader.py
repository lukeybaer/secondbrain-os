#!/usr/bin/env python3
"""recall-reader.py: the one read-only search engine behind Amy's recall door.

It searches the life archive twice (first-hand evidence and assistant
sessions, so neither can crowd the other out of the candidates) and the
session passage store, inside one time budget. The two session stores answer
in well under a second, so they run first, each under its own cap, and the
first-hand pass gets all the time they leave. A store that runs out of time
is reported as timed out, never as empty. It opens every database read-only
and writes nothing.

  python3 recall-reader.py   (one request as JSON on stdin, one reply line out)

Request: {"question", "limit", "budget_ms", "archive_dbs": [...],
           "session_db", "session_sources": [...],
           "filters": {"since", "until", "channels": [...], "order",
                       "people": [name, email or phone number, ...]}}
Reply:    {"ok", "took_ms", "tags", "browse", "people", "stores": [{"name",
           "state", "error", "mode", "words_not_found", "rows", "took_ms",
           "skipped", "window_counts"}]}
  people: one entry per asked person, {"asked", "state", "matched": [{"id",
         "name"}], "total"}, present only when people were asked for. state:
         ok | ambiguous (every matching contact is kept) | literal (an email
         or number no contact lists, matched as asked) | unknown (no contact
         has that name: it was searched as words) | no_identity (no contact
         list yet: searched as words) | no_records (no record lists them as
         a participant: their name was searched as words)
  browse: true when the reply lists what sits inside the filter instead of
         searching words
  state: ok | timed_out | unavailable | error
  mode:  all_words | present_words | any_word | none (the ladder step that
         answered, see ladder_steps in life-archive-fast-search.py), or
         browse (a filter with no search words: the newest items inside it)
  tags:  null when no filter was asked for, else ok | partial | missing (the
         archive's date and channel tags; 'missing' means the filter could
         not be applied and the search ran without it)
  skipped: not read for this question. Only a browse skips: it lists what the
         life archive's tags hold inside the filter, so the session passage
         store is not listed (and nothing is when the tags are missing).

A filter narrows, the words decide: when records match the words but none of
them is inside the filter, the rows outside come back marked in_filter false.
A channel filter therefore never skips a store: a store outside the asked
channels is still searched, and its rows come back marked outside it. A
person filter keeps the records whose sender, recipients or speaker is that
person; the session passages hold no participants, so with a person filter
they come back marked outside it.
"""

import importlib.util
import json
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODES = ("all_words", "present_words", "any_word", "browse", "none")
DEFAULT_BUDGET_MS = 6000
# Each pass must finish by this share of the budget, counted from the start.
# Measured on the cloud index (2026-11-15): passages under 0.25 s, archived
# sessions under 0.8 s, first-hand 1.4 to 4.5 s for common words. The quick
# passes run first under small caps; the first-hand pass may use the rest.
SHARE_PASSAGES, SHARE_ARCHIVE_SESSIONS, SHARE_FIRST_HAND = 0.15, 0.35, 1.0
# The passage store has no index on time. With a time filter the best-ranked
# passages are read and the ones inside the window kept.
PASSAGE_POOL = 400


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FAST = _load("life_archive_fast_search", "life-archive-fast-search.py")
_LIFE = None


def stable_path(value):
    """The indexer's own release-proof spelling of a stored path. The indexer
    module is loaded only when a path names a release folder."""
    global _LIFE
    text = str(value or "")
    if "releases" in text:
        if _LIFE is None:
            _LIFE = _load("life_archive", "life-archive.py")
        text = str(_LIFE.stable_path(text))
    return text.replace("\\", "/").lower()


def item_key(row):
    """One item, however many index rows were written for it."""
    return (row.get("source"), stable_path(row.get("source_id")), stable_path(row.get("raw_path")))


def open_read_only(path):
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=2000")
    return con


def timed(con, deadline, work):
    """Run `work` on `con`, stopping it at `deadline`. Returns (value, state)."""
    if time.monotonic() >= deadline:
        return None, "timed_out"
    con.set_progress_handler(lambda: 1 if time.monotonic() >= deadline else 0, 4000)
    try:
        return work(), "ok"
    except sqlite3.Error as exc:
        if time.monotonic() >= deadline or "interrupt" in str(exc).lower():
            return None, "timed_out"
        return None, f"error: {exc}"
    finally:
        con.set_progress_handler(None, 0)


def store(name, started, state="ok", mode="none", missing=(), rows=(), skipped=False, counts=None):
    failed = state.startswith("error")
    return {
        "name": name,
        "state": "error" if failed else state,
        "error": state[7:] if failed else None,
        "mode": mode if rows else "none",
        "words_not_found": list(missing),
        "rows": list(rows),
        "took_ms": int((time.monotonic() - started) * 1000),
        "skipped": bool(skipped),
        "window_counts": counts or None,
    }


def worst(states):
    for wanted in ("timed_out", "error"):
        for state in states:
            if state.startswith(wanted):
                return state
    return "ok"


def clean_filters(raw):
    """The request's filter with only the fields the engine understands, or None."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in ("since", "until"):
        try:
            if raw.get(key) is not None:
                out[key] = int(raw[key])
        except (TypeError, ValueError):
            pass
    channels = raw.get("channels")
    if isinstance(channels, list) and channels:
        out["channels"] = [str(channel) for channel in channels if str(channel)]
    if raw.get("order") == "newest":
        out["order"] = "newest"
    people = raw.get("people")
    if isinstance(people, list):
        names = []
        for value in people:
            text = " ".join(str(value or "").split())[:80]
            if text and text not in names:
                names.append(text)
        if names:
            out["people"] = names[:3]
    return out or None


def resolve_people(dbs, names):
    """FAST.resolve_person for each asked name, against the first archive that
    holds a contact list. With none, an email or number is still matched as
    asked and a name is searched as words."""
    for db in dbs:
        try:
            con = open_read_only(db)
        except sqlite3.Error:
            continue
        try:
            if FAST.has_identity(con):
                return [FAST.resolve_person(con, name) for name in names]
        except sqlite3.Error:
            pass
        finally:
            con.close()
    con = sqlite3.connect(":memory:")
    try:
        return [FAST.resolve_person(con, name) for name in names]
    finally:
        con.close()


def tag_states(dbs):
    """The weakest tag state among the archives: a filter is only as good as
    the least-tagged index it runs on. None when no archive is here, so the
    reply never blames tags for an archive that did not answer."""
    if not dbs:
        return None
    states = []
    for db in dbs:
        try:
            con = open_read_only(db)
            try:
                states.append(FAST.tag_state(con))
            finally:
                con.close()
        except sqlite3.Error:
            states.append("missing")
    for wanted in ("missing", "partial"):
        if wanted in states:
            return wanted
    return "ok"


def archive_pass(name, dbs, question, fetch, deadline, scope, filters=None, windows=None, browse=False,
                 handles=None):
    """One search of the archives. `windows` caches each archive's
    filter_window, so the two passes of one question build it once.
    `handles` are the asked people's (resolve_person): only records they
    took part in sit inside the filter."""
    started = time.monotonic()
    terms = FAST.effective_terms(question)
    newest = bool(filters and filters.get("order") == "newest")
    windows = {} if windows is None else windows
    answered, states, counts = [], [], {}
    for db in dbs:
        try:
            con = open_read_only(db)
        except sqlite3.Error as exc:
            states.append(f"error: {exc}")
            continue
        try:
            def work():
                con.execute("BEGIN")  # one read snapshot, as in search_db
                if browse:
                    found, inside = FAST.browse_con(con, db, filters, fetch, handles)
                    return found, "browse", [], inside
                window = None
                if filters or handles:
                    if str(db) not in windows:
                        windows[str(db)] = FAST.filter_window(con, filters, handles)
                    window = windows[str(db)]
                found, mode, not_found = FAST.search_con(con, db, question, fetch, scope, window, newest)
                return found, mode, not_found, {}

            value, state = timed(con, deadline, work)
        finally:
            con.close()
        states.append(state)
        if state == "ok":
            answered.append(value)
    # A word is found nowhere only when no database that answered holds it, so
    # the order the databases are read in cannot change the answer (review R7).
    missing = [word for word in (answered[0][2] if answered else [])
               if all(word in not_found for _, _, not_found, _ in answered)]
    candidates = []
    for found, _mode, not_found, inside in answered:
        for channel, count in inside.items():
            counts[channel] = counts.get(channel, 0) + count
        # A database that dropped a word another one holds matched only some of
        # the words that exist: 'any_word', as orderedCandidates does in JS.
        dropped_held = any(word not in missing for word in not_found)
        for row in found:
            for field in ("match_mode", "ladder_step"):
                if dropped_held and row.get(field) == "present_words":
                    row[field] = "any_word"
            candidates.append(row)

    def outside(row):
        return 1 if row.get("in_filter") is False else 0

    def tie(row):
        return (str(row.get("database") or ""),)

    # Rows found by a tighter step first, then rows inside the filter, then the
    # newest (when asked) or the search's own ranking. The database path only
    # breaks exact ties, so one item read from two databases keeps the same
    # copy whatever the read order. A browse keeps the engine's order: each
    # channel in turn.
    if newest and not browse:
        candidates.sort(key=lambda row: (MODES.index(row["ladder_step"]), outside(row),
                                         -(row.get("ts_epoch") or 0)) + tie(row))
    elif not browse:
        candidates.sort(key=lambda row: (MODES.index(row["ladder_step"]), outside(row))
                        + tuple(FAST.ranking_key(row, terms, question)) + tie(row))
    rows, seen = [], set()
    for row in candidates:
        key = item_key(row)
        if key not in seen:
            seen.add(key)
            rows.append(row)
    rows = rows[:fetch]
    return store(name, started, worst(states), rows[0]["ladder_step"] if rows else "none", missing, rows,
                 counts=counts)


PASSAGE_COLUMNS = "rowid, session_id, repo, ts, byte_range, snippet(fts, 0, '[', ']', ' ... ', 48) AS snippet"
PASSAGES_SQL = f"SELECT {PASSAGE_COLUMNS} FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?"
PASSAGE_ROW_SQL = f"SELECT {PASSAGE_COLUMNS} FROM fts WHERE fts MATCH ? AND rowid = ?"


def passage_row(row, mode, in_filter, at=None):
    at = FAST.epoch_seconds(row["ts"]) if at is None else at
    return dict(row, match_mode=mode, ts_epoch=at, ts_basis="record", channel="session", in_filter=in_filter)


def passages_pass(name, db, question, limit, deadline, filters=None, people=False):
    started = time.monotonic()
    filters = filters or {}
    since, until = filters.get("since"), filters.get("until")
    channels = filters.get("channels") or []
    # Every passage is an assistant session. A channel filter that leaves
    # sessions out still gets them searched; they come back marked outside it.
    # A passage names no participants, so a person filter leaves it outside.
    sessions_in = (not channels or "session" in channels) and not people
    windowed = sessions_in and (since is not None or until is not None)
    newest = filters.get("order") == "newest"

    def marked(inside_window=True):
        """in_filter for a passage: None when no filter narrows anything."""
        if not sessions_in:
            return False
        if windowed:
            return inside_window
        return True if channels else None
    try:
        con = open_read_only(db)
    except sqlite3.Error as exc:
        return store(name, started, f"error: {exc}")

    def word_exists(word):
        return con.execute(
            "SELECT 1 FROM fts WHERE fts MATCH ? LIMIT 1", (FAST.phrase_query((word,)),)
        ).fetchone() is not None

    def holds(terms, rowid=None):
        """Some passage (or passage `rowid`) holds every word in `terms`."""
        if rowid is None:
            sql, params = "SELECT 1 FROM fts WHERE fts MATCH ? LIMIT 1", (FAST.fts_query(terms, "AND"),)
        else:
            sql, params = "SELECT 1 FROM fts WHERE fts MATCH ? AND rowid = ?", (FAST.fts_query(terms, "AND"), rowid)
        return con.execute(sql, params).fetchone() is not None

    def work():
        # As in search_con: a step widened by a side-by-side pair runs only when
        # some passage holds every word, and each row is labeled by what it holds.
        missing = []
        for mode, terms, operator, missing in FAST.ladder_steps(question, word_exists):
            loose = FAST.widened(terms, question, operator)
            if loose and not holds(terms):
                continue
            query = FAST.match_query(terms, question, operator)

            def labeled(row, inside, at=None, step=mode, check=terms if loose else None):
                """A passage row with the step that found it and what it holds."""
                item = dict(row)
                rowid = item.pop("rowid")
                item = passage_row(item, step, inside, at)
                item["ladder_step"] = step
                if check is not None and not holds(check, rowid):
                    item["match_mode"] = "any_word"
                return item

            if not windowed and not newest:
                found = con.execute(PASSAGES_SQL, (query, limit)).fetchall()
                if found:
                    return [labeled(row, marked()) for row in found], mode, missing
                continue
            pool = [(rowid, FAST.epoch_seconds(ts)) for rowid, ts in con.execute(
                "SELECT rowid, ts FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?", (query, PASSAGE_POOL)
            )]
            if not pool:
                continue
            kept = [(rowid, at) for rowid, at in pool if at is not None
                    and (since is None or at >= since) and (until is None or at < until)]
            inside = bool(kept)
            if not kept:
                kept = pool  # the words outrank the window, as in the archive
            elif newest:
                kept.sort(key=lambda pair: -pair[1])
            rows = []
            for rowid, at in kept[:limit]:
                row = con.execute(PASSAGE_ROW_SQL, (query, rowid)).fetchone()
                if row is not None:
                    rows.append(labeled(row, marked(inside), at))
            return rows, mode, missing
        return [], "none", missing

    try:
        value, state = timed(con, deadline, work)
    finally:
        con.close()
    if state != "ok":
        return store(name, started, state)
    rows, mode, missing = value
    return store(name, started, "ok", mode, missing, rows)


def answer(request):
    started = time.monotonic()
    question = str(request.get("question") or "").strip()
    limit = max(1, min(50, int(request.get("limit") or 10)))
    budget_ms = request.get("budget_ms")
    budget = (DEFAULT_BUDGET_MS if budget_ms is None else max(0.0, float(budget_ms))) / 1000.0
    dbs, seen = [], set()
    for raw in request.get("archive_dbs") or []:
        path = Path(str(raw))
        if path.exists() and str(path.resolve()).lower() not in seen:
            seen.add(str(path.resolve()).lower())
            dbs.append(path)
    own = FAST.source_filter(request.get("session_sources") or [])
    raw = clean_filters(request.get("filters")) or {}
    names = raw.pop("people", [])
    asked = raw or None  # the window, channels and order: the parts read from tags
    # A window, channel or order needs the archive's tags. Without them the
    # search still runs, unfiltered, and the reply says so. A person filter
    # needs no tags.
    tags = tag_states(dbs) if (asked or names) else None
    tagged = tags in ("ok", "partial")
    filters = asked if tagged else None
    people = resolve_people(dbs, names) if names else []
    handles = [handle for person in people for handle in person["handles"]]
    # A name no contact has is searched as words, so nothing asked is dropped.
    spoken = [person["asked"] for person in people if not person["handles"]]
    if spoken:
        question = " ".join([question] + spoken).strip()
    session_db = request.get("session_db")
    have_passages = bool(session_db and Path(str(session_db)).exists())
    windows = {}
    deadline = started + budget * SHARE_FIRST_HAND

    def reply(stores, browsed=False):
        out = {"ok": True, "took_ms": int((time.monotonic() - started) * 1000), "tags": tags,
               "browse": browsed, "stores": stores}
        if people:
            out["people"] = [{key: person[key] for key in ("asked", "state", "matched", "total")}
                             for person in people]
        return out

    def skipped_passages():
        return store("session_passages", started, skipped=True) if have_passages \
            else store("session_passages", started, "unavailable")

    if (asked or handles) and not question:
        # No search words: list what the archive's tags hold inside the filter,
        # newest first. The whole archive is listed, sessions included.
        first_hand = None
        if not dbs:
            first_hand = store("life_archive", started, "unavailable")
        elif not tagged:
            if not handles:
                first_hand = store("life_archive", started, skipped=True)  # no tags to list by
        else:
            first_hand = archive_pass(
                "life_archive", dbs, "", limit + 5, deadline, None, filters, windows, browse=True, handles=handles,
            )
            if handles and first_hand["state"] == "ok" and not first_hand["rows"]:
                first_hand = None
                narrows = bool(filters and (filters.get("since") is not None or filters.get("until") is not None
                                            or filters.get("channels")))
                if narrows:
                    # Nothing with them inside the window or channel: their newest
                    # records from outside it, marked, as a word search does.
                    wider = archive_pass(
                        "life_archive", dbs, "", limit + 5, deadline, None, {}, None, browse=True, handles=handles,
                    )
                    if wider["state"] != "ok" or wider["rows"]:
                        for row in wider["rows"]:
                            row["in_filter"] = False
                        wider["window_counts"] = None
                        first_hand = wider
                if first_hand is None:
                    # No record lists them as a participant: search their names.
                    for person in people:
                        if person["handles"]:
                            person["state"] = "no_records"
                    handles = []
        if first_hand is not None:
            return reply([first_hand, skipped_passages()], browsed=True)
        # Every asked person had handles (a name searched as words would have
        # made this a word search already): search their names as words.
        question = " ".join(person["asked"] for person in people)

    # Run order: quick stores first. Reply order: first-hand evidence first.
    if have_passages:
        passages = passages_pass(
            "session_passages", str(session_db), question, limit, started + budget * SHARE_PASSAGES, filters,
            people=bool(handles),
        )
    else:
        passages = store("session_passages", started, "unavailable")
    stores = []
    if dbs:
        archived_sessions = None
        if own:
            archived_sessions = archive_pass(
                "life_archive_sessions", dbs, question, limit,
                started + budget * SHARE_ARCHIVE_SESSIONS, ("AND", own), filters, windows, handles=handles,
            )
        stores.append(archive_pass(
            "life_archive", dbs, question, max(limit * 5, 25),
            deadline, ("NOT", own) if own else None, filters, windows, handles=handles,
        ))
        if archived_sessions:
            stores.append(archived_sessions)
    else:
        stores.append(store("life_archive", started, "unavailable"))
    stores.append(passages)
    return reply(stores)


def reply_to(text):
    try:
        reply = answer(json.loads(text))
    except Exception as exc:  # the caller must always get a line back
        reply = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "stores": []}
    # ASCII output survives any console code page; the caller parses JSON.
    return json.dumps(reply, ensure_ascii=True)


def main():
    sys.stdout.write(reply_to(sys.stdin.buffer.read().decode("utf-8", errors="replace")) + "\n")


if __name__ == "__main__":
    main()
