#!/usr/bin/env node
'use strict';

// Example direct script for the hello-lessons scheduled skill. It reads the
// lessons earlier runs recorded, prints a short status, and exits 0. The skill
// runner turns the last output lines into the next LESSONS.md entry.
//
// The public build moves this file to scripts/examples/, next to the skill
// runner, so the lessons module resolves one directory up.

const path = require('node:path');

const lessons = require(path.join(__dirname, '..', 'skill-lessons.js'));

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const previous = lessons.readRecentLessons('hello-lessons', 10);

console.log(`hello-lessons ran for ${date}`);
console.log(`lessons recorded before this run: ${previous.length}`);
if (previous.length) console.log(`most recent outcome: ${previous[previous.length - 1].outcome}`);
