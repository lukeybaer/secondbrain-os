#!/usr/bin/env bash
# Prune merged, clean git worktrees registered on the SecondBrain checkout.
#
# Prepared 2026-10-23 by session/p6-1023 (P6 workstream 4). NOT RUN by the preparer.
# Owner runs it after peer review (it deletes folders).
#
#   bash scripts/ops/prune-worktrees-2026-10-23.sh                    # dry run: prints the plan
#   bash scripts/ops/prune-worktrees-2026-10-23.sh --apply            # removes the session worktrees
#   --include-codex-owned     also the 7 worktrees the Codex app created
#   --include-runtime-owned   also the 8 runtime-side worktrees (call release, skill projections, video skill)
#
# Selection rule (re-checked here at run time for every path, not trusted from the list):
#   1. registered on the main checkout, directory exists, not locked
#   2. HEAD is contained in master (git merge-base --is-ancestor)
#   3. git status --porcelain exits 0 AND prints nothing
#   4. no process command line or executable names the folder
#   5. never today's session worktrees (ops, retire, constitution, p4a, p4b, p4c, p6, audit-deep-dive -1023)
# Fail closed: every git (and grep/awk) read is judged by its exit code, never by empty output.
# A read that fails is a SKIP with the exit code and git's first error line, so a corrupt or
# unreadable worktree can never look clean and reach deletion.
#
# Receipt: every run (plan, apply or abort) writes
#   $APPDATA/secondbrain/data/agent/ops-receipts/prune-worktrees-<UTC date>T<HHMMSS>Z.json
# (PRUNE_RECEIPT_DIR overrides the folder) with the mode, each worktree's action and reason
# (removed, would-remove, skipped, failed, stale) and the post-state re-read from
# git worktree list --porcelain after the run. An unreadable post-state or an unwritable
# receipt makes the run exit non-zero.
#
# Link safety: 20 of the listed worktrees hold a node_modules junction to a shared
# install. Git for Windows is not trusted to unlink it, so this script removes each link
# with Directory.Delete (link only, never the target; throws on a real non-empty folder), then
# refuses the worktree if any link is left. After every removal it confirms the shared
# node_modules still exists and aborts the whole run if not.
#
# Branches: after a worktree goes, its branch (if it had one) is deleted with "git branch -d",
# which git itself refuses unless the branch is fully merged. -D is never used.
#
# NOT handled here on purpose (see the P6 report):
#   - sb-runtime/releases/*            -> scripts/desktop-release.ps1 -Mode Prune (process-aware)
#   - sb-runtime/session-cloud-code    -> after its last consumer is retargeted (workstream 2)
#   - locked worktrees (review-fixes, sess-20260924-baseline2, three amy-call-release-*, one skill-projection)
#   - AppData/Local/Temp/land-category-base-*  (owned by land.js)
#   - worktrees that are dirty or whose HEAD is not in master (6 fix*-1019 branches hold unlanded commits)

set -u

APPLY=0
INCLUDE_CODEX=0
INCLUDE_RUNTIME=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --include-codex-owned) INCLUDE_CODEX=1 ;;
    --include-runtime-owned) INCLUDE_RUNTIME=1 ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

MAIN="${SB_MAIN:-C:/path/to/Documents/GitHub/SecondBrain}"
BASE_REF="${SB_BASE_REF:-master}"

SESSION_WORKTREES=(
  "C:/path/to/Documents/GitHub/sb-sessions/base-check-20260924"
  "C:/path/to/Documents/GitHub/sb-sessions/baseline-check-0923"
  "C:/path/to/Documents/GitHub/sb-sessions/PRIVATE_NAME-call-1018"
  "C:/path/to/Documents/GitHub/sb-sessions/deploy-1019"
  "C:/path/to/Documents/GitHub/sb-sessions/deploy-20260924"
  "C:/path/to/Documents/GitHub/sb-sessions/deploy-people-lock"
  "C:/path/to/Documents/GitHub/sb-sessions/news-resume-progress"
  "C:/path/to/Documents/GitHub/sb-sessions/news-skip-review"
  "C:/path/to/Documents/GitHub/sb-sessions/rung-pin-fallback"
  "C:/path/to/Documents/GitHub/sb-sessions/union-verify-20260824b"
  "C:/path/to/Documents/GitHub/sb-sessions/vm-classifier-20261005"
  "C:/path/to/sb-sessions/briefing-ai-brand-negative-2026-08-30-8f3c2a91"
  "C:/path/to/sb-sessions/briefing-content-fixtures-20260912"
  "C:/path/to/sb-sessions/briefing-five-speed-enhancements-20260913"
  "C:/path/to/sb-sessions/content-gap-healer-20260913"
  "C:/path/to/sb-sessions/deploy-20260823"
  "C:/path/to/sb-sessions/deploy-fix-20260824"
  "C:/path/to/sb-sessions/exact-metric-binding-healer-20260913"
  "C:/path/to/sb-sessions/exact-metric-definitive-verdict-20260913"
  "C:/path/to/sb-sessions/health-post-refresh-20260912"
  "C:/path/to/sb-sessions/otter-report-final-20260806"
  "C:/path/to/sb-sessions/otter-verify-baseline-3095"
  "C:/path/to/sb-sessions/preview-marker-healer-20260913"
  "C:/path/to/sb-sessions/review-marker-6e10e3a"
  "C:/path/to/sb-sessions/review-marker-route-e546d85"
  "C:/path/to/sb-sessions/review-metric-qc-b9d3"
  "C:/path/to/sb-sessions/review-other-credential-0fb8661a"
  "C:/path/to/sb-sessions/review-preview-d89ef791"
  "C:/path/to/sb-sessions/review-preview-race-e1cb9c0"
  "C:/path/to/sb-sessions/review-preview-three-5d6b701"
  "C:/path/to/sb-sessions/review-security-363b5a0f"
  "C:/path/to/sb-sessions/review-stable-20260824"
  "C:/path/to/sb-sessions/studio-category-20260912"
  "C:/path/to/sb-sessions/verify-pretrim-20260823"
  "C:/path/to/sb-sessions/watcher-final-deploy-20260825"
)
CODEX_WORKTREES=(
  "C:/path/to/.codex/worktrees/d535/SecondBrain"
  "C:/path/to/.codex/worktrees/e2ec/SecondBrain"
  "C:/path/to/Documents/Codex/2026-09-09/i-just-sent/work/psychology-baseline"
  "C:/path/to/Documents/Codex/2026-09-12/did/work/ingest-source-audit"
  "C:/path/to/Documents/Codex/2026-09-12/did/work/review-93f866a"
  "C:/path/to/Documents/Codex/2026-09-12/did/work/review-958151b"
  "C:/path/to/Documents/Codex/2026-09-21/comp/work/deploy-f1c8ffa11"
)
RUNTIME_WORKTREES=(
  "C:/path/to/sb-runtime/amy-call-release-9f5978def"
  "C:/path/to/sb-runtime/skill-projections/1efd06916823c7c517a46b2f4e44b3cd2ed2f3f7"
  "C:/path/to/sb-runtime/skill-projections/28dbcecdb64179dc7b4eed97ed46b0649234709f"
  "C:/path/to/sb-runtime/skill-projections/37c1cdc0a9d4be72e1fe805f21d5b293c6970957"
  "C:/path/to/sb-runtime/skill-projections/60d4ea62c11f4bf3ad6beeaf67c13ecc543fda2f"
  "C:/path/to/sb-runtime/skill-projections/6fa37bdeb798a17b05f174102315fc4584d20219"
  "C:/path/to/sb-runtime/skill-projections/d0da902f50251a9d2fe05a835ab252cd90c23647"
  "C:/path/to/sb-runtime/video-skill-20260913-52c08a206"
)

ALLOWED_ROOTS=(
  "C:/path/to/Documents/GitHub/sb-sessions/"
  "C:/path/to/sb-sessions/"
  "C:/path/to/.codex/worktrees/"
  "C:/path/to/Documents/Codex/"
  "C:/path/to/sb-runtime/"
)
TODAY_RE='/(ops|retire|constitution|p4a|p4b|p4c|p6|audit-deep-dive)-1023$'

# Test seams (scripts/__tests__/prune-worktrees-2026-10-23.test.js). Unset in real use.
#   SB_ALLOWED_ROOTS  semicolon-separated roots replacing the built-in list
#   SB_WORKTREE_LIST  file with one worktree path per line replacing the three lists
if [ -n "${SB_ALLOWED_ROOTS:-}" ]; then IFS=';' read -r -a ALLOWED_ROOTS <<< "$SB_ALLOWED_ROOTS"; fi
if [ -n "${SB_WORKTREE_LIST:-}" ]; then
  mapfile -t SESSION_WORKTREES < <(tr -d '\r' < "$SB_WORKTREE_LIST")
  CODEX_WORKTREES=()
  RUNTIME_WORKTREES=()
fi

git_main() { git -C "$MAIN" "$@"; }

# The receipt folder is settled before anything else, so no run can go unrecorded.
if [ -n "${PRUNE_RECEIPT_DIR:-}" ]; then RECEIPT_DIR="$(cygpath -m "$PRUNE_RECEIPT_DIR")"
elif [ -n "${APPDATA:-}" ]; then RECEIPT_DIR="$(cygpath -m "$APPDATA")/secondbrain/data/agent/ops-receipts"
else echo "ABORT: APPDATA is unset, so this run would leave no receipt" >&2; exit 2; fi
RUN_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RECEIPT_STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"

TMPDIR_RUN="$(mktemp -d)"
SNAP="$TMPDIR_RUN/processes.txt"
PORCELAIN="$TMPDIR_RUN/worktrees.porcelain"
ROWS="$TMPDIR_RUN/rows.tsv"
GIT_ERR="$TMPDIR_RUN/git.err"
: > "$ROWS"
ABORT_REASON=""

# One row per worktree decision: action, path, reason (tabs and newlines flattened).
record() { printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\r\n' '   ')" >> "$ROWS"; }
abort() { ABORT_REASON="$2"; echo "ABORT: $2" >&2; exit "$1"; }
first_err() { head -1 "$GIT_ERR" 2>/dev/null | tr -d '\r'; }

cat > "$TMPDIR_RUN/receipt.js" <<'JS'
const fs = require("fs"), p = require("path"), e = process.env;
const rows = fs.readFileSync(e.SB_R_ROWS, "utf8").split("\n").filter(Boolean).map((l) => {
  const [action, wt, ...rest] = l.split("\t");
  return { path: wt, action, reason: rest.join(" ") };
});
const count = (a) => rows.filter((r) => r.action === a).length;
const post = { source: "git worktree list --porcelain, re-read after the run (counts the main checkout)" };
if (e.SB_R_POST_RC === "0") {
  const paths = fs.readFileSync(e.SB_R_POST, "utf8").replace(/\r/g, "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  Object.assign(post, { registered_worktrees: paths.length, paths });
} else {
  const err = (fs.existsSync(e.SB_R_POST_ERR) ? fs.readFileSync(e.SB_R_POST_ERR, "utf8") : "").trim().split("\n")[0];
  Object.assign(post, { registered_worktrees: null, error: `git exit ${e.SB_R_POST_RC}: ${err}` });
}
const receipt = {
  schema: "amy.prune_worktrees_receipt.v1",
  mode: e.SB_R_MODE, started_at: e.SB_R_STARTED, finished_at: new Date().toISOString(),
  main: e.SB_R_MAIN, base_ref: e.SB_R_BASE, exit_code: Number(e.SB_R_EXIT), abort_reason: e.SB_R_ABORT || null,
  counts: { removed: count("removed"), would_remove: count("would-remove"), skipped: count("skipped"), failed: count("failed") },
  worktrees: rows, post_state: post,
};
fs.mkdirSync(e.SB_R_DIR, { recursive: true });
let file;
for (let n = 1; ; n++) {
  file = p.join(e.SB_R_DIR, `prune-worktrees-${e.SB_R_STAMP}${n > 1 ? "-" + n : ""}.json`);
  try { fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); break; } catch (x) { if (x.code !== "EEXIST") throw x; }
}
console.log(file);
if (post.registered_worktrees === null) process.exit(4);
JS

write_receipt() {
  local rc="$1" post_rc
  git -C "$MAIN" worktree list --porcelain > "$TMPDIR_RUN/post.porcelain" 2> "$TMPDIR_RUN/post.err"; post_rc=$?
  SB_R_DIR="$RECEIPT_DIR" SB_R_STAMP="$RECEIPT_STAMP" SB_R_ROWS="$(cygpath -m "$ROWS")" \
    SB_R_POST="$(cygpath -m "$TMPDIR_RUN/post.porcelain")" SB_R_POST_ERR="$(cygpath -m "$TMPDIR_RUN/post.err")" SB_R_POST_RC="$post_rc" \
    SB_R_MODE="$([ "$APPLY" -eq 1 ] && echo apply || echo plan)" SB_R_EXIT="$rc" SB_R_ABORT="$ABORT_REASON" \
    SB_R_MAIN="$MAIN" SB_R_BASE="$BASE_REF" SB_R_STARTED="$RUN_STARTED" \
    node "$(cygpath -w "$TMPDIR_RUN/receipt.js")"
}

# Runs on every exit from here on: the receipt is written, then the temp folder goes.
# A post-state that cannot be read (4) or a receipt that cannot be written (5) fails the run.
finish() {
  local rc=$? out wrc
  out="$(write_receipt "$rc" 2>&1)"; wrc=$?
  case "$wrc" in
    0) echo "receipt: $out" ;;
    4) echo "receipt: $out"; echo "POST-STATE UNREADABLE: git worktree list failed after the run, so its result is unproven" >&2; [ "$rc" -ne 0 ] || rc=4 ;;
    *) echo "RECEIPT FAILED: $out" >&2; [ "$rc" -ne 0 ] || rc=5 ;;
  esac
  rm -rf "$TMPDIR_RUN"
  exit "$rc"
}
trap finish EXIT

[ -d "$MAIN/.git" ] || abort 2 "$MAIN is not a git checkout"
[ -d "$MAIN/node_modules" ] || abort 2 "$MAIN/node_modules is missing before we start"
git_main rev-parse --verify --quiet "$BASE_REF" >/dev/null || abort 2 "$BASE_REF does not resolve"

# One process snapshot (command line plus executable path, backslashes turned into slashes).
cat > "$TMPDIR_RUN/snap.ps1" <<'PS'
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process | ForEach-Object {
  ([string]$_.CommandLine + ' ' + [string]$_.ExecutablePath).Replace('\', '/')
}
PS
if ! powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$TMPDIR_RUN/snap.ps1")" > "$SNAP" 2>/dev/null \
   || [ "$(wc -l < "$SNAP")" -lt 20 ]; then
  abort 2 "could not read the process list, so 'unused' cannot be proven"
fi

# A failed listing aborts instead of leaving an empty registration list behind.
refresh_porcelain() {
  local out
  out="$(git_main worktree list --porcelain 2>&1)" || { printf '%s\n' "$out" | head -1 >&2; return 1; }
  printf '%s\n' "$out" | tr -d '\r' > "$PORCELAIN"
}
refresh_porcelain || abort 2 "git worktree list failed on $MAIN"

is_registered() { grep -Fxq "worktree $1" "$PORCELAIN"; }
is_locked() {
  awk -v wt="$1" 'BEGIN { RS = ""; FS = "\n" } $1 == "worktree " wt { for (i = 1; i <= NF; i++) if ($i ~ /^locked/) { found = 1 } } END { exit found ? 0 : 1 }' "$PORCELAIN"
}
escape_ere() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/]/\\&/g'; }
# 0 = a process names it, 1 = none does, anything else = the check itself failed.
in_use() {
  local pat
  pat="$(escape_ere "$1")" || return 2
  grep -i -E -q -- "${pat}([/ \"']|\$)" "$SNAP"
}
remaining_links() {
  node -e 'const fs=require("fs"),p=require("path");const out=[];const walk=(d,n)=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){if(e.name===".git"&&n===0)continue;const f=p.join(d,e.name);if(e.isSymbolicLink()){out.push(f);continue}if(e.isDirectory()&&n<4)walk(f,n+1)}};walk(process.argv[1],0);if(out.length){console.log(out.join("\n"));process.exit(3)}' "$1"
}

REMOVED=0
SKIPPED=0
FAILED=0
skip() { echo "  SKIP    $1 ($2)"; SKIPPED=$((SKIPPED + 1)); record skipped "$1" "$2"; }

process_one() {
  local wt="$1" ok=0 root head branch rc out bnote
  [ "$wt" != "$MAIN" ] || { skip "$wt" "is the main checkout"; return; }
  for root in "${ALLOWED_ROOTS[@]}"; do case "$wt/" in "$root"*) ok=1 ;; esac; done
  [ "$ok" -eq 1 ] || { skip "$wt" "outside the allowed roots"; return; }
  if printf '%s' "$wt" | grep -Eq "$TODAY_RE"; then skip "$wt" "today's session worktree"; return; fi
  is_registered "$wt" || { skip "$wt" "not registered on the main checkout"; return; }
  [ -d "$wt" ] || { skip "$wt" "directory is gone (see stale registrations)"; return; }
  is_locked "$wt"; rc=$?
  case "$rc" in 0) skip "$wt" "locked"; return ;; 1) ;; *) skip "$wt" "cannot read its lock state (awk exit $rc)"; return ;; esac

  # Every git read below is judged by its exit code, never by empty output. A failed read is a
  # skip with the exit code and git's first error line; only exit 0 lets the worktree go on.
  head="$(git -C "$wt" rev-parse --verify HEAD 2>"$GIT_ERR")"; rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$head" | grep -Eqx '[0-9a-f]{40}([0-9a-f]{24})?'; then
    skip "$wt" "cannot read HEAD (git exit $rc: $(first_err))"; return
  fi
  git_main merge-base --is-ancestor "$head" "$BASE_REF" 2>"$GIT_ERR"; rc=$?
  case "$rc" in
    0) ;;
    1) skip "$wt" "HEAD ${head:0:9} is not in $BASE_REF"; return ;;
    *) skip "$wt" "cannot prove HEAD ${head:0:9} is in $BASE_REF (git exit $rc: $(first_err))"; return ;;
  esac
  # Clean means status exited 0 AND printed nothing. Its stderr stays in the output, so a
  # warning counts as not clean too.
  out="$(git -C "$wt" status --porcelain 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then skip "$wt" "cannot read status (git exit $rc: $(printf '%s' "$out" | head -1))"; return; fi
  if [ -n "$out" ]; then skip "$wt" "has uncommitted or untracked changes: $(printf '%s' "$out" | head -1)"; return; fi
  in_use "$wt"; rc=$?
  case "$rc" in 0) skip "$wt" "a running process names it"; return ;; 1) ;; *) skip "$wt" "cannot check the process list (grep exit $rc)"; return ;; esac

  # symbolic-ref -q exits 1 for a detached HEAD (no branch); any other failure is a skip.
  branch="$(git -C "$wt" symbolic-ref -q --short HEAD 2>"$GIT_ERR")"; rc=$?
  case "$rc" in 0) ;; 1) branch="" ;; *) skip "$wt" "cannot read its branch (git exit $rc: $(first_err))"; return ;; esac

  if [ "$APPLY" -eq 0 ]; then
    local note=""
    [ -n "$branch" ] && note=" then git branch -d $branch"
    echo "  WOULD   git worktree remove $wt$note"
    record would-remove "$wt" "merged, clean, unlocked, unused${note}"
    return
  fi

  # Unlink the shared node_modules junction first. Directory.Delete (not recursive) removes
  # a junction as a link and never its target, and throws on a real non-empty folder.
  if [ -e "$wt/node_modules" ] || [ -L "$wt/node_modules" ]; then
    SB_UNLINK_PATH="$(cygpath -w "$wt/node_modules")" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '[IO.Directory]::Delete($env:SB_UNLINK_PATH)' >/dev/null 2>&1
  fi
  if ! remaining_links "$wt" >"$TMPDIR_RUN/links.txt" 2>&1; then
    skip "$wt" "still holds a link: $(head -1 "$TMPDIR_RUN/links.txt")"
    return
  fi
  if git_main worktree remove "$wt" >"$TMPDIR_RUN/rm.txt" 2>&1; then
    echo "  REMOVED $wt"
    REMOVED=$((REMOVED + 1))
    if [ ! -d "$MAIN/node_modules" ]; then
      record removed "$wt" "worktree removed, then the shared node_modules was found missing"
      abort 9 "shared $MAIN/node_modules vanished after removing $wt"
    fi
    bnote="detached HEAD, no branch to delete"
    if [ -n "$branch" ]; then
      if out="$(git_main branch -d "$branch" 2>&1)"; then bnote="branch $branch deleted"
      else bnote="branch $branch kept by git branch -d: $(printf '%s' "$out" | head -1)"; fi
      printf '%s\n' "$out" | sed 's/^/          /'
    fi
    record removed "$wt" "$bnote"
  else
    echo "  FAILED  $wt: $(head -1 "$TMPDIR_RUN/rm.txt")"
    FAILED=$((FAILED + 1))
    record failed "$wt" "$(head -1 "$TMPDIR_RUN/rm.txt")"
  fi
}

echo "mode: $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)   base: $BASE_REF   main: $MAIN"

echo
echo "== stale registrations (directory missing)"
STALE=0
while IFS= read -r line; do
  wt="${line#worktree }"
  [ -d "$wt" ] && continue
  STALE=$((STALE + 1))
  if [ "$APPLY" -eq 1 ]; then
    if is_locked "$wt"; then git_main worktree unlock "$wt" && echo "  unlocked $wt"; fi
    echo "  stale registration: $wt"
    record stale "$wt" "directory missing; unlocked if locked, then git worktree prune"
  else
    echo "  WOULD   unlock (if locked) and prune stale registration $wt"
    record stale "$wt" "directory missing; would unlock if locked and prune"
  fi
done < <(grep '^worktree ' "$PORCELAIN")
[ "$STALE" -gt 0 ] || echo "  none"
if [ "$APPLY" -eq 1 ] && [ "$STALE" -gt 0 ]; then git_main worktree prune -v; refresh_porcelain || abort 2 "git worktree list failed on $MAIN after pruning stale registrations"; fi

echo
echo "== session worktrees (${#SESSION_WORKTREES[@]})"
for wt in "${SESSION_WORKTREES[@]}"; do process_one "$wt"; done

if [ "$INCLUDE_CODEX" -eq 1 ]; then
  echo
  echo "== codex-owned worktrees (${#CODEX_WORKTREES[@]})"
  for wt in "${CODEX_WORKTREES[@]}"; do process_one "$wt"; done
else
  echo
  echo "== codex-owned worktrees (${#CODEX_WORKTREES[@]}) not included (pass --include-codex-owned)"
fi

if [ "$INCLUDE_RUNTIME" -eq 1 ]; then
  echo
  echo "== runtime-owned worktrees (${#RUNTIME_WORKTREES[@]})"
  for wt in "${RUNTIME_WORKTREES[@]}"; do process_one "$wt"; done
else
  echo
  echo "== runtime-owned worktrees (${#RUNTIME_WORKTREES[@]}) not included (pass --include-runtime-owned)"
fi

if [ "$APPLY" -eq 1 ]; then git_main worktree prune -v; fi

echo
echo "removed: $REMOVED   skipped: $SKIPPED   failed: $FAILED"
[ "$FAILED" -eq 0 ]
