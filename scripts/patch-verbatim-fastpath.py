#!/usr/bin/env python3
"""Idempotently insert the Layer 2 verbatim fast-path into a live ec2-server.js.

Patches the running EC2 file in place (it drifts ahead of origin/master, so a
whole-file deploy would regress it). Each insertion is applied only if its
result marker is absent, and aborts if an anchor is not found exactly once, so a
partial or double patch is impossible. Re-runnable.
"""
import sys

f = sys.argv[1]
s = open(f, encoding="utf-8").read()

# (name, presence_marker, anchor, replacement). Skip if marker already present.
INSERTIONS = [
    (
        "require",
        "verbatim-fastpath.js')",
        "const { tryTranscriptFastPath } = require('./scripts/transcript-fastpath.js');",
        "const { tryTranscriptFastPath } = require('./scripts/transcript-fastpath.js');\n"
        "const { tryVerbatimFastPath } = require('./scripts/verbatim-fastpath.js');",
    ),
    (
        "region1",
        "          return verbatimAnswer;",
        "          console.log('[query_knowledge] FAST: transcript inventory hit');\n"
        "          return transcriptAnswer;\n"
        "        }",
        "          console.log('[query_knowledge] FAST: transcript inventory hit');\n"
        "          return transcriptAnswer;\n"
        "        }\n\n"
        "        // Fast-path 0.5: verbatim recall over raw session transcripts (Layer 2).\n"
        "        const verbatimAnswer = tryVerbatimFastPath(question);\n"
        "        if (verbatimAnswer) {\n"
        "          console.log('[query_knowledge] FAST: verbatim FTS hit');\n"
        "          return verbatimAnswer;\n"
        "        }",
    ),
    (
        "region2",
        "            jsonOk(res, { result: verbatimAnswer });",
        "            console.log('[query_knowledge] FAST: transcript inventory hit');\n"
        "            jsonOk(res, { result: transcriptAnswer });\n"
        "            return;\n"
        "          }",
        "            console.log('[query_knowledge] FAST: transcript inventory hit');\n"
        "            jsonOk(res, { result: transcriptAnswer });\n"
        "            return;\n"
        "          }\n"
        "          // Verbatim recall over raw session transcripts (Layer 2).\n"
        "          const verbatimAnswer = tryVerbatimFastPath(question);\n"
        "          if (verbatimAnswer) {\n"
        "            console.log('[query_knowledge] FAST: verbatim FTS hit');\n"
        "            jsonOk(res, { result: verbatimAnswer });\n"
        "            return;\n"
        "          }",
    ),
    (
        "memory-query",
        "source: 'verbatim-fts'",
        "      const result = await queryAmyMemory(question, {",
        "      // Verbatim recall (Layer 2): a verbatim ask returns the literal passage.\n"
        "      const verbatimAnswer = tryVerbatimFastPath(question);\n"
        "      if (verbatimAnswer) {\n"
        "        jsonOk(res, { ok: true, source: 'verbatim-fts', result: verbatimAnswer });\n"
        "        return;\n"
        "      }\n"
        "      const result = await queryAmyMemory(question, {",
    ),
]

applied = []
for name, marker, anchor, repl in INSERTIONS:
    if marker in s:
        continue  # already applied
    n = s.count(anchor)
    if n != 1:
        print("ABORT: anchor %s found %d times (need exactly 1)" % (name, n))
        sys.exit(1)
    s = s.replace(anchor, repl, 1)
    applied.append(name)

open(f, "w", encoding="utf-8").write(s)
print("patched OK; applied: %s" % (",".join(applied) if applied else "none (all present)"))
