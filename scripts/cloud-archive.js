#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  uploadFile,
  isGitUntracked,
} = require('./lib/cloud-archive.js');

function parseArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-stdin') opts.fromStdin = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--delete-untracked-after-upload') opts.deleteUntracked = true;
    else if (arg === '--domain') opts.domain = argv[++i];
    else if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--manifest') opts.manifest = argv[++i];
    else if (arg === '--prefix') opts.prefix = argv[++i];
    else if (arg === '--relative-to') opts.relativeTo = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`PRIVATE_NAME option: ${arg}`);
    else opts.files.push(arg);
  }
  return opts;
}

function stdinFiles() {
  if (process.stdin.isTTY) return [];
  return fs.readFileSync(0, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = [...opts.files, ...(opts.fromStdin ? stdinFiles() : [])];
  if (!files.length) throw new Error('No files supplied to archive');

  const receipts = files.map((file) => {
    const receipt = uploadFile(file, opts);
    if (opts.deleteUntracked && !opts.dryRun) {
      if (!isGitUntracked(file)) throw new Error(`Refusing to delete tracked or modified file after archive: ${file}`);
      fs.unlinkSync(path.resolve(file));
    }
    return { localPath: path.resolve(file), ...receipt };
  });

  const manifest = {
    createdAt: new Date().toISOString(),
    dryRun: Boolean(opts.dryRun),
    receipts,
  };
  if (opts.manifest) {
    fs.mkdirSync(path.dirname(opts.manifest), { recursive: true });
    fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, count: receipts.length, manifest: opts.manifest || null }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
