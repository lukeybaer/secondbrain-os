#!/usr/bin/env python3
"""
northwest-ocr.py -- text from an image-only mail scan.

  /opt/secondbrain-shared/venv-ocr/bin/python scripts/northwest-ocr.py <file.pdf|file.png>

PRIVATE_NAME mail scans are usually photographs with no text layer, so pdftotext
returns nothing. Pages are rendered with pdftoppm and read with RapidOCR (CPU,
installed only in the isolated /opt/secondbrain-shared/venv-ocr venv). Prints the
text, pages separated by form feeds. Exit 2 when the engine is missing.
"""
import subprocess
import sys
import tempfile
from pathlib import Path


def pages(src, workdir):
    if src.suffix.lower() != ".pdf":
        return [src]
    subprocess.run(["pdftoppm", "-r", "200", "-png", str(src), str(Path(workdir) / "page")], check=True, timeout=300)
    return sorted(Path(workdir).glob("page*.png"))


def main(argv):
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        sys.stderr.write("rapidocr_onnxruntime is not installed\n")
        return 2
    engine = RapidOCR()
    out = []
    with tempfile.TemporaryDirectory() as workdir:
        for page in pages(Path(argv[1]), workdir):
            result, _ = engine(str(page))
            out.append("\n".join(line[1] for line in (result or [])))
    sys.stdout.write("\f".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
