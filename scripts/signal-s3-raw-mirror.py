#!/usr/bin/env python3
"""Mirror immutable Signal raw evidence from its canonical S3 archive.

The Life Archive indexer consumes the local mirror on its ordinary five-minute
cadence.  This script never deletes an S3 object, never uses ``--delete`` on
the local mirror, and never writes an index itself.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = "s3://ExampleCo-secondbrain-backups/data-lake/secondbrain/life-archive/data/signal/raw/"
DEFAULT_DESTINATION = Path(os.environ.get("SECONDBRAIN_DATA_DIR") or (REPO / "data")) / "signal" / "raw"


def command(source, destination, quiet=False):
    args = ["aws", "s3", "sync", source, str(destination), "--only-show-errors", "--no-progress"]
    if quiet:
        args.append("--no-follow-symlinks")
    return args


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.environ.get("SECONDBRAIN_SIGNAL_S3_RAW_SOURCE", DEFAULT_SOURCE))
    parser.add_argument("--destination", default=os.environ.get("SECONDBRAIN_SIGNAL_RAW_DIR", str(DEFAULT_DESTINATION)))
    parser.add_argument("--dry-run", action="store_true", help="print the immutable pull command without contacting S3")
    parser.add_argument("--quiet", action="store_true", help="suppress the successful mirror summary")
    args = parser.parse_args(argv)

    destination = Path(args.destination).resolve()
    sync = command(args.source, destination, args.quiet)
    if args.dry_run:
        print("[signal-s3-raw-mirror] dry run: " + " ".join(sync))
        return 0

    destination.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(sync, check=False)
    except FileNotFoundError:
        print("[signal-s3-raw-mirror] aws CLI is required for the canonical Signal raw mirror", file=sys.stderr)
        return 127
    if result.returncode != 0:
        print(f"[signal-s3-raw-mirror] S3 mirror failed with exit {result.returncode}; Life Archive indexing was not started", file=sys.stderr)
        return result.returncode
    if not args.quiet:
        print(f"[signal-s3-raw-mirror] mirrored immutable Signal raw evidence to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
