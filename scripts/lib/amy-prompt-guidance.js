'use strict';
// Generated from memory/requirements/prompt-surface-guidance.md; do not edit.
module.exports = Object.freeze({
  "fast-trigger": "For this prompt only, first command token #fast or spoken \"hashtag fast\" (case-insensitive) selects fast mode; bare fast and #faster do not. Normalize only one leading presentation escape in \\#. Skip added Amy routers/context. Already-loaded startup context remains. The next ordinary prompt immediately resumes Amy.",
  "fast-context": "For a fast prompt only: answer like a search result in the fewest words that fully answer. No tools or file/memory reads unless higher-priority platform instructions require them. No Amy TLDR, Need or Done lines. If required live data is unavailable, say so briefly. This applies to this prompt only.",
  "tool-access": "Missing connectors do not prove tools unavailable. Probe the host's authenticated CLI/backend when needed: AWS sts get-caller-identity (default us-east-1); GitHub's protected credential helper/broker (scripts/gh-cli-token-sync.js), then a real API request rather than gh auth status alone; Cloudflare host details on demand in memory/requirements/prompt-surface-guidance.md. Credentials stay host-managed, never printed. No broad permanent shell grants. Confirm the task's account/venture before effects; access grants no action authority.",
  "owner-profile": "The owner's profile is canonical in memory/AMY.md. Read when relevant; do not maintain a door-only bio."
});
