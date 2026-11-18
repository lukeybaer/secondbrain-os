#!/usr/bin/env bash
# Dated snapshot of every file the speaker-naming rule change can write.
#
# Usage: voice-naming-rule-snapshot.sh <dest-dir> <data-dir> <contacts-dir>
#
# Writes <dest-dir>/snapshot.tar.zst, <dest-dir>/manifest.sha256 (one line per
# file, paths relative to the archive root) and <dest-dir>/summary.txt. Takes
# no locks and changes nothing under <data-dir>. Point <data-dir> at a reflink
# copy so the manifest and the archive describe one instant, not a moving tree.
#
# Audio and the envelope folders are left out on purpose: the change never
# writes them.
set -euo pipefail

DEST="${1:?dest dir}"
DATA="${2:?data dir}"
CONTACTS="${3:?contacts dir}"

mkdir -p "$DEST"
LIST="$DEST/files.list"
: > "$LIST"

cd "$DATA"
# Everything under recorder except audio.
find otter -type f \( -path 'otter/audio/*' -o -path 'otter/audio-full/*' \) -prune -o -type f -print >> "$LIST"
[ -f life-archive/voice-identity-registry.json ] && echo life-archive/voice-identity-registry.json >> "$LIST"
[ -d life-archive/people ] && find life-archive/people -type f >> "$LIST"
# Top-level voiceprint state, without the append-only journals over 200 MB.
find life-archive/voiceprints -maxdepth 1 -type f -size -200M >> "$LIST"
[ -d agent ] && find agent -maxdepth 1 -type f -name 'voice*' >> "$LIST"

sort -u "$LIST" -o "$LIST"

# Journals too big to copy: record their size, so a restore can cut them back.
find life-archive/voiceprints -maxdepth 1 -type f -size +200M -printf '%s %p\n' > "$DEST/journals.sizes"

xargs -a "$LIST" -d '\n' sha256sum > "$DEST/manifest.sha256"
(cd "$(dirname "$CONTACTS")" && find "$(basename "$CONTACTS")" -type f -print0 | xargs -0 sha256sum | sed 's#  #  memory/#') >> "$DEST/manifest.sha256"

tar --zstd -cf "$DEST/snapshot.tar.zst" \
  -C "$DATA" -T "$LIST" \
  -C "$(dirname "$(dirname "$CONTACTS")")" "memory/$(basename "$CONTACTS")"

(cd "$DEST" && sha256sum snapshot.tar.zst > snapshot.tar.zst.sha256)
{
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "data_dir=$DATA"
  echo "contacts_dir=$CONTACTS"
  echo "files=$(wc -l < "$DEST/manifest.sha256")"
  echo "archive_bytes=$(stat -c %s "$DEST/snapshot.tar.zst")"
  echo "enriched_files=$(grep -c '^otter/enriched/' "$LIST" || true)"
  echo "raw_files=$(grep -c '^otter/raw/' "$LIST" || true)"
} > "$DEST/summary.txt"
cat "$DEST/summary.txt"
