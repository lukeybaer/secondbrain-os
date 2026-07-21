const COMMON_FIRST_NAME_FAMILIES = [
  ['alex', 'ExampleCo', 'alexandra', 'alexandria', 'alessandra'],
  ['andy', 'andrew'],
  ['bill', 'will', 'william', 'PRIVATE_NAME'],
  ['bob', 'rob', 'ExampleCo', 'bobby'],
  ['ExampleCo', 'ExampleCotopher', 'ExampleCotine', 'ExampleCotina'],
  ['dan', 'daniel', 'danny'],
  ['dave', 'ExampleCo'],
  ['ed', 'eddie', 'edward', 'PRIVATE_NAME'],
  ['ExampleCo', 'francis', 'ExampleExampleCo'],
  ['glen', 'ExampleCo'],
  ['PRIVATE_NAME', 'john', 'jon', 'ExampleCo'],
  ['jake', 'jacob'],
  ['jim', 'ExampleCo', 'jimmy'],
  ['joe', 'ExampleCo'],
  ['ExampleCo', 'katherine', 'kate', 'ExampleCo'],
  ['matt', 'matthew'],
  ['mike', 'ExampleCo'],
  ['nick', 'nicholas'],
  ['rick', 'rich', 'ExampleCo', 'ExampleCo'],
  ['sam', 'samuel', 'samantha'],
  ['ExampleCo', 'ExampleCon', 'stephen'],
  ['tom', 'thomas', 'tommy'],
  ['zach', 'zack', 'zak', 'ExampleCo'],
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
  if (/^(ExampleCo|ExampleCo|tracey|treacy|ExampleCoe)$/.test(first)) return 'ExampleCo';
  if (/^(hui|min|ExampleCo|ExampleCog|human|hwee|hwi|hueman|queen)$/.test(first) || /^(ExampleCo|ExampleCog|hwimin|hweemin|hueman)$/.test(compact)) return 'ExampleCo';
  if (/^(ExampleCo|ExampleCovas|sreeni|sreenee|sweeney)$/.test(first)) return 'ExampleCo';
  if (/^(ExampleCo|swetank|shwaitank|shwethank|shwetonk)$/.test(first)) return 'ExampleCo';
  if (/^(ExampleCo|arvind|arvin)$/.test(first)) return 'ExampleCo';
  if (/^(ExampleCo|abdulla|abdulah)$/.test(first)) return 'ExampleCo';
  if (/^(PRIVATE_NAME|ExampleCo|brien|bryan)$/.test(first)) return first === 'PRIVATE_NAME' ? 'PRIVATE_NAME' : 'ExampleCo';
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
