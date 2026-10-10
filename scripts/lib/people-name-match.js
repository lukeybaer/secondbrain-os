
const { loadOperatorIdentity } = require('./operator-identity');
const COMMON_FIRST_NAME_FAMILIES = [
  ['alex', 'alexander', 'alexandra', 'alexandria', 'alessandra'],
  ['andy', 'andrew'],
  ['bill', 'will', 'william', 'PRIVATE_NAME'],
  ['bob', 'rob', 'robert', 'bobby'],
  ['chris', 'christopher', 'christine', 'christina'],
  ['dan', 'daniel', 'danny'],
  ['dave', 'david'],
  ['ed', 'eddie', 'edward', 'PRIVATE_NAME'],
  ['frank', 'francis', 'franklin'],
  ['glen', 'PRIVATE_NAME'],
  ['PRIVATE_NAME', 'john', 'jon', 'jonathan'],
  ['jake', 'jacob'],
  ['jim', 'james', 'jimmy'],
  ['joe', 'joseph'],
  ['katie', 'katherine', 'kate', 'kathy'],
  ['matt', 'matthew'],
  ['mike', 'michael'],
  ['nick', 'nicholas'],
  ['rick', 'rich', 'richard', 'ricky'],
  ['sam', 'samuel', 'samantha'],
  ['steve', 'steven', 'stephen'],
  ['tom', 'thomas', 'tommy'],
  ['zach', 'zack', 'zak', 'zachary'],
];

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function firstNameToken(value) {
  return normalizeName(value).split(/\s+/)[0] || '';
}

function commonFirstNameRoot(first) {
  for (const family of COMMON_FIRST_NAME_FAMILIES) {
    if (family.includes(first)) return family[0];
  }
  return '';
}

function heardNameFamily(value) {
  const n = normalizeName(value);
  if (!n) return '';
  const first = n.split(/\s+/)[0] || n;
  const compact = n.replace(/\s+/g, '');
  // Operator-specific heard-name families (a contact's first name and the
  // ways ASR mishears it) are identity data, not source: they come from
  // memory/reference_operator_identity.json through operator-identity.js, so
  // the public shell carries none of them and falls back to the common roots
  // (Codex public-mirror review 5403c39a1aee, 2026-09-07).
  for (const family of loadOperatorIdentity().voiceNameFamilies || []) {
    if (!family || typeof family.canonical !== 'string') continue;
    const byFirst = Array.isArray(family.first) && family.first.includes(first);
    const byCompact = Array.isArray(family.compact) && family.compact.includes(compact);
    if (byFirst || byCompact) return family.canonical;
  }
  return commonFirstNameRoot(first) || first;
}

function soundex(value) {
  const first = firstNameToken(value);
  if (!first) return '';
  const codes = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  let last = codes[first[0]] || '';
  let out = first[0].toUpperCase();
  for (const ch of first.slice(1)) {
    const code = codes[ch] || '';
    if (code && code !== last) out += code;
    last = code;
  }
  return (out + '000').slice(0, 4);
}

function editDistance(a, b) {
  const left = firstNameToken(a);
  const right = firstNameToken(b);
  if (!left || !right) return Math.max(left.length, right.length);
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[left.length][right.length];
}

function firstNamesCompatible(left, right) {
  const a = firstNameToken(left);
  const b = firstNameToken(right);
  if (!a || !b) return false;
  const fa = heardNameFamily(a);
  const fb = heardNameFamily(b);
  if (fa && fb && fa === fb) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (minLen >= 4 && editDistance(a, b) <= 1) return true;
  return minLen >= 4 && a[0] === b[0] && soundex(a) === soundex(b);
}

module.exports = {
  heardNameFamily,
  firstNamesCompatible,
};
