'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseRegistryBlock,
  matchComponents,
  extractRulesOfTheRoad,
} = require('./core-component-registry.js');
const { parseGravityBlock, matchLaws } = require('./gravity-registry.js');

const MAX_COMPONENTS = 3;
const MAX_LAWS = 3;
const LESSONS_CAP_BYTES = 5000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function boundedTail(text, capBytes = LESSONS_CAP_BYTES) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= capBytes) return buffer.toString('utf8');
  return buffer.subarray(buffer.length - capBytes).toString('utf8').replace(/^\uFFFD+/, '');
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function buildPeerReviewContextPacket({ repo, reviewText } = {}) {
  const root = path.resolve(repo || process.cwd());
  const memoryText = readOptional(path.join(root, 'memory', 'MEMORY.md'));
  const registry = parseRegistryBlock(memoryText);
  const components = matchComponents(reviewText, registry.rows, MAX_COMPONENTS).map((row) => {
    const docFile = path.join(root, row.docPath);
    const docText = readOptional(docFile);
    const rules = extractRulesOfTheRoad(docText);
    const lessonsPath = row.docPath.replace(/\.md$/, '.LESSONS.md');
    const lessonsText = readOptional(path.join(root, lessonsPath));
    return {
      id: row.id,
      docPath: row.docPath,
      docSha256: sha256(docText),
      rules: rules.text,
      rulesSource: rules.source,
      rulesTruncated: rules.truncated,
      lessonsPath: lessonsText ? lessonsPath : null,
      lessonsSha256: lessonsText ? sha256(lessonsText) : null,
      recentLessons: lessonsText ? boundedTail(lessonsText) : '',
    };
  });

  const gravityText = readOptional(path.join(root, 'memory', 'AMY_GRAVITY.md'));
  const gravity = parseGravityBlock(gravityText);
  const laws = matchLaws(reviewText, gravity.rows, MAX_LAWS).map((row) => ({
    id: row.id,
    law: row.law,
    authority: row.authority,
    status: row.status,
  }));

  const text = [
    'FRESH COMPONENT CONTEXT PACKET',
    'Treat these current component rules and recent lessons as authoritative review context.',
    'Reject a proposal that conflicts with them or presents an existing mechanism as new.',
    '',
    ...components.flatMap((component) => [
      `COMPONENT: ${component.id}`,
      `DOC: ${component.docPath} (sha256 ${component.docSha256})`,
      component.rules,
      ...(component.recentLessons
        ? [
            `RECENT LESSONS: ${component.lessonsPath} (sha256 ${component.lessonsSha256})`,
            component.recentLessons,
          ]
        : []),
      '',
    ]),
    ...(laws.length
      ? [
          'MATCHED LAWS OF AMY GRAVITY',
          ...laws.map(
            (law) =>
              `${law.id} [${law.status}] ${law.law} (authority: ${law.authority})`,
          ),
        ]
      : []),
  ].join('\n');

  return {
    schema: 'peer-review-context-packet@1',
    components,
    laws,
    text,
    sha256: sha256(text),
  };
}

module.exports = {
  MAX_COMPONENTS,
  MAX_LAWS,
  LESSONS_CAP_BYTES,
  boundedTail,
  buildPeerReviewContextPacket,
};
