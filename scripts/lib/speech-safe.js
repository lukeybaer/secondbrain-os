// speech-safe.js
//
// Strip things that must never be read aloud over a phone (TTS): URLs, GitHub
// references, and auto/dispatch-* branch tokens. Amy was phoning ExampleCo and
// reading raw command results that contained PR URLs and branch names
// ("Done on branch auto/dispatch-358713721fbeel, open a PR https://github.com/...").
// Any string headed to a Vapi say (inline answer or callback) goes through this.
// 2026-06-02.
function speechSafe(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/\S+/gi, ' ')      // any URL
    .replace(/\bgithub\.com\/\S+/gi, ' ')  // bare github refs
    .replace(/\bauto\/dispatch-\S+/gi, ' ') // autodev branch tokens
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { speechSafe };
