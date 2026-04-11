"""
briefing-to-docx.py — Convert a daily briefing markdown file into a Word .docx.

Usage: python scripts/briefing-to-docx.py <input.md> <output.docx>

Part of the briefing delivery chain. Called by manual-briefing-v3.js and by the
scheduled daily-briefing task. Uses python-docx + the markdown library.
"""

import sys
import re
from pathlib import Path

import markdown as md_lib
from docx import Document
from docx.shared import Pt, RGBColor
from html.parser import HTMLParser


class DocxBuilder(HTMLParser):
    def __init__(self, doc):
        super().__init__()
        self.doc = doc
        self.current_p = None
        self.list_level = 0
        self.in_pre = False
        self.in_code = False
        self.bold = False
        self.italic = False
        self.link = None
        self.heading_level = 0
        self.buffer = ""

    def _flush_paragraph(self):
        self.current_p = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush_paragraph()
            self.heading_level = int(tag[1])
            self.current_p = self.doc.add_heading("", level=min(self.heading_level, 4))
        elif tag == "p":
            self._flush_paragraph()
            self.current_p = self.doc.add_paragraph()
        elif tag in ("strong", "b"):
            self.bold = True
        elif tag in ("em", "i"):
            self.italic = True
        elif tag == "code":
            self.in_code = True
        elif tag == "pre":
            self.in_pre = True
            self._flush_paragraph()
            self.current_p = self.doc.add_paragraph()
        elif tag == "br":
            if self.current_p is not None:
                self.current_p.add_run().add_break()
        elif tag in ("ul", "ol"):
            self.list_level += 1
        elif tag == "li":
            self._flush_paragraph()
            style = "List Bullet" if self.list_level <= 1 else "List Bullet 2"
            self.current_p = self.doc.add_paragraph(style=style)
        elif tag == "a":
            self.link = a.get("href")
        elif tag == "hr":
            self._flush_paragraph()
            p = self.doc.add_paragraph()
            p.add_run("_" * 60)
        elif tag == "blockquote":
            self._flush_paragraph()
            self.current_p = self.doc.add_paragraph(style="Intense Quote" if "Intense Quote" in [s.name for s in self.doc.styles] else None)

    def handle_endtag(self, tag):
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "blockquote", "li"):
            self._flush_paragraph()
            if tag == "pre":
                self.in_pre = False
            if tag.startswith("h"):
                self.heading_level = 0
        elif tag in ("strong", "b"):
            self.bold = False
        elif tag in ("em", "i"):
            self.italic = False
        elif tag == "code":
            self.in_code = False
        elif tag in ("ul", "ol"):
            self.list_level = max(0, self.list_level - 1)
        elif tag == "a":
            self.link = None

    def handle_data(self, data):
        if not data:
            return
        if self.current_p is None:
            self.current_p = self.doc.add_paragraph()
        text = data
        run = self.current_p.add_run(text)
        run.bold = self.bold or self.heading_level > 0
        run.italic = self.italic
        if self.in_code or self.in_pre:
            run.font.name = "Consolas"
            run.font.size = Pt(9)
        if self.link:
            run.font.color.rgb = RGBColor(0x06, 0x5F, 0xD2)
            run.font.underline = True


def convert(md_path: Path, out_path: Path) -> Path:
    """Render markdown to docx. Returns the actual path written.

    If `out_path` is locked (e.g. Word has it open), falls back to writing
    `<stem>.new.docx` alongside so the briefing still ships a fresh copy.
    """
    text = md_path.read_text(encoding="utf-8")
    html = md_lib.markdown(text, extensions=["extra", "sane_lists", "nl2br"])
    doc = Document()

    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)

    builder = DocxBuilder(doc)
    builder.feed(html)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        doc.save(out_path)
        return out_path
    except PermissionError:
        fallback = out_path.with_name(out_path.stem + ".new" + out_path.suffix)
        doc.save(fallback)
        print(
            f"warning: {out_path} locked (likely open in Word), wrote {fallback} instead",
            file=sys.stderr,
        )
        return fallback


def main():
    if len(sys.argv) != 3:
        print("Usage: briefing-to-docx.py <input.md> <output.docx>", file=sys.stderr)
        sys.exit(2)
    actual = convert(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"wrote {actual}")


if __name__ == "__main__":
    main()
