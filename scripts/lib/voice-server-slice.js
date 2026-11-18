'use strict';

// The phone part of ec2-server.js, as text, for the voice release fingerprint.
// The server file also runs the briefing, videos, chat and most of Amy, so
// hashing it whole re-locked outbound calling on every unrelated change: 91 of
// the 128 server edits between 2026-09-24 and 2026-10-24 never touched phone
// code (Owner decision: "we shouldn't be re-testing and blocking calls when
// we're not changing the calling capability").
//
// The slice is every request-handler branch that serves a phone path, every
// handler-local and top-level declaration those branches reach (transitively,
// by name), every per-request statement that runs before them, and every
// top-level startup statement that touches what they reach, pruned to those
// lines. A name match is over-inclusive on purpose (a shadowed local or a
// same-named property pulls in more, never less). Statements keep source order, so the same tree
// produces the same text on the PC and on EC2. The parser is vendored and
// pinned: a different parser version could change the text.
const acorn = require('../vendor/acorn-8.16.0.js');

// One list of phone paths: what is hashed as the call surface is what the
// phone process serves.
const { PHONE_PATH_RE } = require('./server-role.js');

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out;
}

function identifiers(node, memo) {
  if (memo.has(node)) return memo.get(node);
  const names = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'Identifier') { names.add(n.name); continue; }
    // `a.name` and `{ name: v }` name a property, not a binding.
    if (n.type === 'MemberExpression' && !n.computed) { stack.push(n.object); continue; }
    if ((n.type === 'Property' || n.type === 'PropertyDefinition' || n.type === 'MethodDefinition') && !n.computed && !n.shorthand) {
      if (n.value) stack.push(n.value);
      continue;
    }
    stack.push(...children(n));
  }
  memo.set(node, names);
  return names;
}

function references(node, wanted, memo) {
  for (const name of identifiers(node, memo)) if (wanted.has(name)) return true;
  return false;
}

function declaredNames(statement) {
  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
    return statement.id ? [statement.id.name] : [];
  }
  if (statement.type !== 'VariableDeclaration') return [];
  const names = [];
  for (const declarator of statement.declarations) {
    const stack = [declarator.id];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'Identifier') names.push(n.name);
      else if (n.type === 'ObjectPattern') for (const p of n.properties) stack.push(p.type === 'RestElement' ? p.argument : p.value);
      else if (n.type === 'ArrayPattern') for (const e of n.elements) { if (e) stack.push(e); }
      else if (n.type === 'AssignmentPattern') stack.push(n.left);
      else if (n.type === 'RestElement') stack.push(n.argument);
    }
  }
  return names;
}

function isDeclaration(statement) {
  return statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration' || statement.type === 'VariableDeclaration';
}

// The paths an if-test compares urlPath against, directly or through a
// handler-local flag such as `isBriefingRoute = urlPath.startsWith(...)`, or
// null when the test does not look at the path. A regex test counts as phone
// when its source names a phone word.
function routePaths(source, test, flags) {
  let text = source.slice(test.start, test.end);
  for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) if (flags.has(m[0])) text += '\n' + flags.get(m[0]);
  if (!/\burlPath\b/.test(text)) return null;
  const paths = [];
  for (const m of text.matchAll(/urlPath\s*===?\s*'([^']*)'|urlPath\.(?:startsWith|endsWith)\(\s*'([^']*)'/g)) paths.push(m[1] ?? m[2]);
  for (const m of text.matchAll(/urlPath\.match\(\s*\/((?:\\\/|[^/\n])+)\//g)) paths.push(/vapi|voice|call|chat/.test(m[1]) ? '/vapi/regex' : '/other/regex');
  return paths;
}

function isPhoneRoute(source, statement, flags) {
  if (statement.type !== 'IfStatement') return false;
  const paths = routePaths(source, statement.test, flags);
  return Boolean(paths && paths.some((p) => PHONE_PATH_RE.test(p)));
}

// Handler-local constants computed from urlPath, by name, with their source.
function routeFlags(source, body) {
  const flags = new Map();
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const d of statement.declarations) {
      if (d.id.type !== 'Identifier' || !d.init) continue;
      const text = source.slice(d.init.start, d.init.end);
      if (/\burlPath\b/.test(text) && text.length < 4000) flags.set(d.id.name, text);
    }
  }
  return flags;
}

function findRequestHandler(program) {
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      const init = declarator.init;
      const fn = init && init.type === 'CallExpression' ? init.arguments[0] : null;
      if (declarator.id.type === 'Identifier' && declarator.id.name === 'server' &&
          fn && /FunctionExpression$/.test(fn.type) && fn.body.type === 'BlockStatement') {
        return { statement, body: fn.body.body };
      }
    }
  }
  return null;
}

const MUTATORS = new Set(['set', 'delete', 'clear', 'add', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill']);

function rootName(node) {
  let n = node;
  while (n && (n.type === 'MemberExpression' || n.type === 'ChainExpression')) n = n.type === 'ChainExpression' ? n.expression : n.object;
  return n && n.type === 'Identifier' ? n.name : null;
}

// The names a node writes: assigns, updates, deletes from, or mutates with a
// collection method or Object.assign. A writer changes what a call sees even
// when no phone code calls it (Codex review 2026-10-24: the timer that
// refreshes `cachedAssistantConfig`).
function writtenRoots(node, memo) {
  if (memo.has(node)) return memo.get(node);
  const names = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    let target = null;
    if (n.type === 'AssignmentExpression') target = n.left;
    else if (n.type === 'UpdateExpression') target = n.argument;
    else if (n.type === 'UnaryExpression' && n.operator === 'delete') target = n.argument;
    else if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
      const callee = n.callee;
      const method = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : null;
      if (method && MUTATORS.has(method)) target = callee.object;
      else if (method === 'assign' && rootName(callee.object) === 'Object' && n.arguments[0]) target = n.arguments[0];
    }
    const root = target && rootName(target);
    if (root) names.add(root);
    stack.push(...children(n));
  }
  memo.set(node, names);
  return names;
}

function writes(node, wanted, memo) {
  for (const name of writtenRoots(node, memo)) if (wanted.has(name)) return true;
  return false;
}

function isInnerStatement(n) {
  return (/Statement$/.test(n.type) && n.type !== 'BlockStatement') || /Declaration$/.test(n.type);
}

// A startup statement with every inner statement that does not touch `wanted`
// cut out, so the listen callback contributes its header and its phone lines
// but not the video or chat timers beside them. Returns the kept text and
// the names it still uses. Comments and spacing are dropped, so the blank
// line a removed timer leaves behind does not count.
function prunedStartup(source, node, wanted, memo, comments) {
  const cuts = [];
  const stack = children(node);
  while (stack.length) {
    const n = stack.pop();
    if (isInnerStatement(n) && !references(n, wanted, memo)) { cuts.push(n); continue; }
    stack.push(...children(n));
  }
  const ranges = [...cuts, ...comments.filter((c) => c.start >= node.start && c.end <= node.end)]
    .sort((a, b) => a.start - b.start);
  let text = '';
  let at = node.start;
  for (const range of ranges) {
    if (range.start > at) text += source.slice(at, range.start);
    at = Math.max(at, range.end);
  }
  text += source.slice(at, node.end);
  text = text.replace(/\s+/g, ' ');
  const names = new Set(identifiers(node, memo));
  const cutNames = new Set();
  for (const cut of cuts) for (const name of identifiers(cut, memo)) cutNames.add(name);
  // A name used only inside a cut statement is not kept. Names used both
  // inside and outside stay, because the walk below cannot tell them apart.
  for (const name of cutNames) if (!keptUses(node, cuts, name, memo)) names.delete(name);
  return { start: node.start, end: node.end, text, names };
}

function keptUses(node, cuts, name, memo) {
  const cutSet = new Set(cuts);
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (cutSet.has(n)) continue;
    if (n === node || identifiers(n, memo).has(name)) {
      if (n.type === 'Identifier') return true;
      if (n.type === 'MemberExpression' && !n.computed) { stack.push(n.object); continue; }
      if ((n.type === 'Property' || n.type === 'PropertyDefinition' || n.type === 'MethodDefinition') && !n.computed && !n.shorthand) {
        if (n.value) stack.push(n.value);
        continue;
      }
      stack.push(...children(n));
    }
  }
  return false;
}

function phoneServerSlice(sourceText) {
  const source = String(sourceText).replace(/\r\n/g, '\n');
  const comments = [];
  const program = acorn.parse(source, {
    ecmaVersion: 2025, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true,
    onComment: comments,
  });
  const handler = findRequestHandler(program);
  if (!handler) throw new Error('voice server slice: request handler `server` not found');
  const memo = new WeakMap();
  const writeMemo = new WeakMap();

  const topDecls = new Map();
  for (const statement of program.body) for (const name of declaredNames(statement)) topDecls.set(name, statement);
  const localDecls = new Map();
  for (const statement of handler.body) for (const name of declaredNames(statement)) localDecls.set(name, statement);

  const flags = routeFlags(source, handler.body);
  let lastPhone = -1;
  handler.body.forEach((statement, index) => { if (isPhoneRoute(source, statement, flags)) lastPhone = index; });
  if (lastPhone < 0) throw new Error('voice server slice: no phone route found in the request handler');

  const included = new Set();
  handler.body.forEach((statement, index) => {
    if (isDeclaration(statement)) return;
    if (isPhoneRoute(source, statement, flags)) { included.add(statement); return; }
    // Per-request code before the last phone branch that is not a branch for
    // another path runs on phone requests too.
    const paths = statement.type === 'IfStatement' ? routePaths(source, statement.test, flags) : null;
    if (index < lastPhone && !(paths && paths.length)) included.add(statement);
  });

  // Close over names, then add the startup statements that touch what was
  // reached, pruned to their phone lines, and repeat: a startup line can reach
  // more helpers of its own.
  const reach = (names) => {
    for (const name of names) {
      for (const decl of [localDecls.get(name), topDecls.get(name)]) {
        if (decl && decl !== handler.statement && !included.has(decl)) { included.add(decl); queue.push(decl); }
      }
    }
  };
  const queue = [...included];
  let startup = [];
  for (;;) {
    while (queue.length) reach(identifiers(queue.pop(), memo));
    const reached = new Set();
    for (const decl of included) for (const name of declaredNames(decl)) reached.add(name);
    startup = program.body
      .filter((statement) => !isDeclaration(statement) && references(statement, reached, memo))
      .map((statement) => prunedStartup(source, statement, reached, memo, comments));
    for (const part of startup) reach(part.names);
    // Anything else that writes reached state joins too, with what it reaches.
    for (const statement of [...program.body, ...handler.body]) {
      if (statement === handler.statement || included.has(statement) || !isDeclaration(statement) && program.body.includes(statement)) continue;
      if (writes(statement, reached, writeMemo)) { included.add(statement); queue.push(statement); }
    }
    if (!queue.length) break;
  }

  const parts = [
    ...[...included].map((node) => ({ start: node.start, end: node.end, text: source.slice(node.start, node.end) })),
    ...startup,
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const part of parts) {
    const last = kept[kept.length - 1];
    if (last && part.start >= last.start && part.end <= last.end) continue;
    kept.push(part);
  }
  return kept.map((part) => part.text).join('\n\0\n');
}

module.exports = { phoneServerSlice, PHONE_PATH_RE };
