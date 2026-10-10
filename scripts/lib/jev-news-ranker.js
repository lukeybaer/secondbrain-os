'use strict';

const { oneDecision, choiceProbability } = require('./jev-decision-gate.js');
const {
  newsStoriesDuplicate,
  newsStoryTitleTokens,
  tokenOverlap,
} = require('./news-story-identity.js');

const NEWS_POOL_TARGET = 300;
const DUPLICATE_CONFIDENCE = 0.9;
const TOPIC_MATCH_CONFIDENCE = 0.9;
const DUPLICATE_CANDIDATE_LIMIT = 40;
const SCORE_LEVELS = 10;
const NEWS_SCORE_WEIGHTS = Object.freeze({
  domainImportance: 0.3,
  ExampleCoRelevance: 0.35,
  depth: 0.2,
  originality: 0.15,
});
const ExampleCo_RELEVANCE_EXCLUDED_CATEGORIES = new Set(['science', 'policy', 'finance', 'ExampleCo', 'other', 'ExampleCo']);

const ExampleCo_CONTEXT = [
  'The owner is a technology professional; describe their work and interests here.',
  'Do not infer a political belief, ideology, approval, or disapproval. Political coverage is evaluated only as neutral factual news and for decision relevance to the stated work and interests.',
].join(' ');

function clean(value, max = 6000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function scoreCriteria(low, middle, high) {
  return Array.from({ length: SCORE_LEVELS }, (_, index) => {
    const value = Math.round(1 + (index / (SCORE_LEVELS - 1)) * 99);
    if (index === 0) return `0: ${low}`;
    if (index === 4 || index === 5) return `${value}: ${middle}`;
    if (index === SCORE_LEVELS - 1) return `100: ${high}`;
    return `${value}: interpolate proportionally between the nearest anchors.`;
  });
}

function scoreTo100(answer) {
  if (!answer || answer.type !== 'score' || !Number.isFinite(Number(answer.score))) return null;
  return Math.max(
    1,
    Math.min(100, Math.round(1 + (Number(answer.score) / (SCORE_LEVELS - 1)) * 99)),
  );
}

function duplicateQuestionKey(index) {
  return `duplicate_candidate_${index + 1}`;
}

function articleQuestions(shortlist = [], topics = [], { includeExampleCoRelevance = true } = {}) {
  const topicCriteria = { none: 'The article does not materially match any supplied interest instruction.' };
  for (const topic of topics) topicCriteria[topic.id] = `The article materially matches interest instruction ${topic.id}.`;
  const questions = {
    domain_importance: {
      type: 'score',
      instructions:
        'Rate the news significance of this article inside its own domain. Judge the article and reported development, not whether any politician, official, party, policy, or legislation is good or bad.',
      criteria: scoreCriteria(
        'trivial or routine within the domain',
        'meaningful development for practitioners or informed readers',
        'field-shaping, highly consequential, or unusually important development',
      ),
    },
    depth: {
      type: 'score',
      instructions: 'Rate the article itself for depth and substance based on the supplied title, excerpt, and body.',
      criteria: scoreCriteria(
        'thin rewrite, announcement fragment, or little supporting evidence',
        'substantive reporting with useful facts and context',
        'deep original reporting, primary evidence, rigorous analysis, and important context',
      ),
    },
    originality: {
      type: 'score',
      instructions:
        'Rate how much genuinely new information or a non-obvious insight this article adds beyond what ExampleCo is likely to know and what the other candidate titles already cover.',
      criteria: scoreCriteria(
        'fully familiar, derivative, or adds no new information',
        'some new facts, framing, or useful synthesis',
        'materially new, surprising, exclusive, or decision-changing information',
      ),
    },
  };
  shortlist.forEach((row, index) => {
    questions[duplicateQuestionKey(index)] = {
      type: 'noul',
      instructions:
        `Does the candidate article cover the same underlying reported event or development as duplicate candidate ${row.id}? Similar topic alone is not a duplicate.`,
    };
  });
  if (includeExampleCoRelevance) {
    questions.ExampleCo_relevance = {
      type: 'score',
      instructions: 'Rate how relevant this article is to ExampleCo using only the supplied explicit profile, projects, responsibilities, and ranked interest instructions. Higher-priority matching instructions should increase this score more than lower-priority ones. Do not infer political beliefs or optimize for persuasion.',
      criteria: scoreCriteria('no credible connection to ExampleCo', 'useful context for a stated interest or project', 'likely to change a near-term decision, opportunity, risk, or action for ExampleCo'),
    };
  }
  if (topics.length && includeExampleCoRelevance) {
    questions.matched_interest = {
      type: 'choice',
      instructions:
        'Select the single closest ranked interest instruction that this article materially matches. Select none when no instruction matches. The instruction text is authoritative; its separate display title is intentionally not supplied.',
      criteria: topicCriteria,
    };
  }
  return questions;
}

function duplicateShortlist(candidate, pool, max = DUPLICATE_CANDIDATE_LIMIT) {
  const leftTokens = newsStoryTitleTokens(candidate.title);
  return pool
    .filter((row) => row.id !== candidate.id)
    .map((row) => ({
      ...row,
      similarity:
        (newsStoriesDuplicate(candidate, row) ? 100 : 0) +
        tokenOverlap(leftTokens, newsStoryTitleTokens(row.title)),
    }))
    .filter((row) => row.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, max);
}

function composite(scores, matchedTopicPriority = 0, rankingMode = 'enforce') {
  const available = Object.entries(NEWS_SCORE_WEIGHTS).filter(
    ([key]) => scores[key] != null && Number.isFinite(Number(scores[key])),
  );
  const weightTotal = available.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(weightTotal > 0)) throw new Error('No finite Jev news scores were available for the composite.');
  const editorial = Math.round(available.reduce((sum, [key, weight]) => sum + Number(scores[key]) * weight, 0) / weightTotal);
  const priority = Math.max(0, Math.min(100, Number(matchedTopicPriority) || 0));
  if (!priority || rankingMode !== 'enforce') return editorial;
  return Math.min(100, editorial + Math.max(1, Math.round(priority * 0.1)));
}

async function scoreArticle(candidate, pool, deps = {}, topics = [], rankingMode = 'enforce') {
  const shortlist = duplicateShortlist(candidate, pool);
  const includeExampleCoRelevance = !ExampleCo_RELEVANCE_EXCLUDED_CATEGORIES.has(candidate.category);
  const personalizedTopics = includeExampleCoRelevance ? topics : [];
  const result = await oneDecision({
    state: {
      candidate: {
        id: candidate.id,
        category: candidate.category,
        title: clean(candidate.title, 500),
        source: clean(candidate.source, 200),
        excerpt: clean(candidate.excerpt, 1200),
        article_body: clean(candidate.sourceText, 6000),
        ...(candidate.categoryInstruction ? { category_instruction: clean(candidate.categoryInstruction, 500) } : {}),
      },
      ...(includeExampleCoRelevance ? { ExampleCo_context: ExampleCo_CONTEXT, ranked_interest_instructions: personalizedTopics } : {}),
      duplicate_candidates: shortlist.map((row, index) => ({
        id: row.id,
        category: row.category,
        title: clean(row.title, 300),
        question: duplicateQuestionKey(index),
      })),
    },
    questions: articleQuestions(shortlist, personalizedTopics, { includeExampleCoRelevance }),
    surface: 'news-candidate-ranking',
    deps,
  });
  const answers = result.answers || {};
  const scores = {
    domainImportance: scoreTo100(answers.domain_importance),
    ExampleCoRelevance: includeExampleCoRelevance ? scoreTo100(answers.ExampleCo_relevance) : null,
    depth: scoreTo100(answers.depth),
    originality: scoreTo100(answers.originality),
  };
  if (Object.entries(scores).some(([key, value]) => value == null && !(key === 'ExampleCoRelevance' && !includeExampleCoRelevance))) {
    const error = new Error(`Jev returned an incomplete article score for ${candidate.id}`);
    error.code = 'jev_incomplete_score';
    throw error;
  }
  const duplicateMatches = shortlist
    .map((row, index) => ({
      id: row.id,
      probability: Number(answers[duplicateQuestionKey(index)]?.noul || 0),
    }))
    .filter((row) => row.probability >= DUPLICATE_CONFIDENCE)
    .sort((a, b) => b.probability - a.probability);
  const duplicateProbability = duplicateMatches[0]?.probability || 0;
  const duplicateChoice = duplicateMatches[0]?.id || '';
  const duplicateChoiceConfidence = duplicateProbability;
  const matchedTopicId = String(answers.matched_interest?.choice || 'none');
  const matchedTopicConfidence = choiceProbability(answers.matched_interest, matchedTopicId);
  const matchedTopic = matchedTopicConfidence >= TOPIC_MATCH_CONFIDENCE
    ? personalizedTopics.find((row) => row.id === matchedTopicId)
    : null;
  const matchedTopicPriority = matchedTopic ? Number(matchedTopic.priority || 0) : 0;
  return {
    ...scores,
    baseComposite: composite(scores),
    composite: composite(scores, matchedTopicPriority, rankingMode),
    duplicate: duplicateMatches.length > 0,
    duplicateProbability,
    duplicateOf: duplicateChoice,
    duplicateIds: duplicateMatches.map((row) => row.id),
    duplicateRelations: duplicateMatches,
    duplicateDecisionVersion: 'pairwise-set-v2',
    duplicateRelationConfidence: duplicateProbability,
    // Deprecated compatibility alias for pre-v2 receipts. This is now the
    // strongest pairwise noul confidence, not a Choice softmax probability.
    duplicateChoiceConfidence,
    matchedTopicId: matchedTopic ? matchedTopic.id : '',
    matchedTopicPriority,
    matchedTopicConfidence,
    model: result.model,
  };
}

function confirmedDuplicateEdges(scored = []) {
  const rows = new Map(scored.map((row) => [row.id, row]));
  const edges = new Map();
  const positiveAdjacency = new Map();
  for (const row of scored) {
    if (!row.jevNews || row.jevNews.error) continue;
    positiveAdjacency.set(
      row.id,
      new Set((row.jevNews?.duplicateRelations || []).map((relation) => relation.id)),
    );
    for (const relation of row.jevNews?.duplicateRelations || []) {
      const target = rows.get(relation.id);
      if (!target || target.jevNews?.error) continue;
      const ids = [row.id, target.id].sort();
      const key = ids.join('\u0000');
      const edge = edges.get(key) || { a: ids[0], b: ids[1], aToB: 0, bToA: 0 };
      if (row.id === edge.a) edge.aToB = Number(relation.probability || 0);
      else edge.bToA = Number(relation.probability || 0);
      edges.set(key, edge);
    }
  }

  const triangleEdges = [];
  const unsupportedEdges = [];
  for (const edge of edges.values()) {
    const left = positiveAdjacency.get(edge.a) || new Set();
    const right = positiveAdjacency.get(edge.b) || new Set();
    const hasCommonNeighbor = [...left].some((id) => right.has(id));
    const reciprocal = edge.aToB >= DUPLICATE_CONFIDENCE && edge.bToA >= DUPLICATE_CONFIDENCE;
    const candidate = {
      ...edge,
      confidence: reciprocal
        ? Math.min(edge.aToB, edge.bToA)
        : Math.max(edge.aToB, edge.bToA),
    };
    if (hasCommonNeighbor) triangleEdges.push(candidate);
    else if (reciprocal) unsupportedEdges.push(candidate);
  }

  // A reciprocal pair is sufficient on its own. A one-way relation survives
  // only when both endpoints independently name the same third article. This
  // absorbs provider threshold asymmetry without allowing one unsupported
  // adjacent-event mistake to bridge coherent sets. Preserve the strongest
  // isolated reciprocal pairs.
  const confirmed = triangleEdges.slice();
  const connected = new Set(triangleEdges.flatMap((edge) => [edge.a, edge.b]));
  unsupportedEdges
    .sort((a, b) => b.confidence - a.confidence || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))
    .forEach((edge) => {
      if (connected.has(edge.a) || connected.has(edge.b)) return;
      confirmed.push(edge);
      connected.add(edge.a);
      connected.add(edge.b);
    });

  // Provider answers near the 0.90 floor can vary by direction. Once a
  // corroborated set exists, attach a remaining singleton only when it has
  // above-threshold relations with at least two members of that same set.
  // Never use this expansion to merge two already non-singleton components.
  const parent = new Map(scored.map((row) => [row.id, row.id]));
  const find = (id) => {
    let value = parent.get(id);
    while (value && value !== parent.get(value)) value = parent.get(value);
    return value || id;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  confirmed.forEach((edge) => union(edge.a, edge.b));
  const components = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(id);
  }
  const nonSingletons = [...components.values()].filter((members) => members.length > 1);
  for (const members of [...components.values()].filter((group) => group.length === 1)) {
    const id = members[0];
    const candidates = nonSingletons
      .map((group) => {
        const links = group
          .map((member) => {
            const ids = [id, member].sort();
            const edge = edges.get(ids.join('\u0000'));
            return edge
              ? { ...edge, confidence: Math.max(edge.aToB, edge.bToA) }
              : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.confidence - a.confidence);
        // newsStoryTitleTokens removes stopwords, normalizes event phrases,
        // and stems inflections. Two independent four-token matches into an
        // already-corroborated set supplement one semantic Jev relation when
        // the reverse provider answer fluctuates just below the 0.90 floor.
        const singletonTokens = newsStoryTitleTokens(rows.get(id)?.title);
        const lexicalSupport = group.filter((member) =>
          tokenOverlap(singletonTokens, newsStoryTitleTokens(rows.get(member)?.title)) >= 4,
        ).length;
        return { group, links, lexicalSupport };
      })
      .filter((candidate) =>
        candidate.links.length >= 2 ||
        (candidate.links.length >= 1 && candidate.lexicalSupport >= 2),
      )
      .sort((a, b) =>
        b.links.length - a.links.length ||
        b.lexicalSupport - a.lexicalSupport ||
        b.links[0].confidence - a.links[0].confidence,
      );
    if (!candidates.length) continue;
    // Exactly one winning set is selected from the frozen component snapshot;
    // a singleton can never bridge two established non-singleton components.
    confirmed.push(candidates[0].links[0]);
  }
  return confirmed;
}

function interleaveCards(cards, keys, limit = NEWS_POOL_TARGET) {
  const queues = keys.map((key) =>
    (cards[key]?.items || []).map((item, index) => ({
      ...item,
      id: `${key}:${index}`,
      category: key,
      originalIndex: index,
    })),
  );
  const pool = [];
  let depth = 0;
  while (pool.length < limit && queues.some((queue) => depth < queue.length)) {
    for (const queue of queues) {
      if (pool.length >= limit) break;
      if (queue[depth]) pool.push(queue[depth]);
    }
    depth += 1;
  }
  return pool;
}

async function mapLimit(rows, limit, fn) {
  const output = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor++;
      try {
        output[index] = await fn(rows[index], index);
      } catch (error) {
        output[index] = {
          error: String(error.message || error),
          errorCode: error.code || '',
          errorStatus: Number(error.status || 0),
          errorBody: String(error.body || '').slice(0, 500),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, () => worker()));
  return output;
}

async function rankNewsCards(cards = {}, { deps = {}, concurrency = 12, topics = [], rankingMode = 'enforce' } = {}) {
  const keys = ['aitech', 'us', 'world', 'policy', 'finance', 'science', 'ExampleCo', 'other'].filter(
    (key) => cards[key] && Array.isArray(cards[key].items),
  );
  const pool = interleaveCards(cards, keys, NEWS_POOL_TARGET);
  const judgments = await mapLimit(pool, concurrency, (row) => scoreArticle(row, pool, deps, topics, rankingMode));
  const scored = pool.map((row, index) => ({ ...row, jevNews: judgments[index] }));
  const byId = new Map(scored.map((row) => [row.id, row]));
  const parent = new Map(scored.map((row) => [row.id, row.id]));
  const find = (id) => {
    let value = parent.get(id);
    while (value && value !== parent.get(value)) value = parent.get(value);
    return value || id;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const edge of confirmedDuplicateEdges(scored)) {
    if (byId.has(edge.a) && byId.has(edge.b)) join(edge.a, edge.b);
  }
  const groups = new Map();
  for (const row of scored) {
    const root = find(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  }
  const winners = new Set();
  const duplicateClusters = [];
  for (const group of groups.values()) {
    const winner = group
      .slice()
      .sort(
        (a, b) =>
          Number(b.jevNews?.composite || -1) - Number(a.jevNews?.composite || -1) ||
          a.originalIndex - b.originalIndex,
      )[0];
    if (winner && !winner.jevNews?.error) winners.add(winner.id);
    if (winner) {
      const clusterId = `cluster-${duplicateClusters.length + 1}`;
      const members = group.map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        url: row.url || row.link || '',
        composite: Number(row.jevNews?.composite || 0),
      }));
      duplicateClusters.push({
        clusterId,
        duplicateSet: members.length > 1,
        winnerId: winner.id,
        members,
      });
      for (const row of group) {
        row.jevNews = {
          ...row.jevNews,
          duplicateClusterId: clusterId,
          duplicateSetSize: members.length,
          duplicateSetWinner: winner.id,
        };
      }
    }
  }
  for (const key of keys) {
    const ranked = scored
      .filter((row) => row.category === key && winners.has(row.id))
      .sort(
        (a, b) =>
          Number(b.jevNews?.composite || -1) - Number(a.jevNews?.composite || -1) ||
          a.originalIndex - b.originalIndex,
      )
      .map(({ id, category, originalIndex, ...row }) => row);
    cards[key] = {
      ...cards[key],
      items: ranked,
      count: ranked.length,
      jevRanking: {
        status: 'complete',
        poolSize: pool.length,
        targetPoolSize: NEWS_POOL_TARGET,
        model: ranked.find((row) => row.jevNews?.model)?.jevNews?.model || null,
      },
    };
  }
  return {
    cards,
    poolSize: pool.length,
    scored: scored.filter((row) => !row.jevNews?.error).length,
    duplicateClusters,
    candidates: scored.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      url: row.url || row.link || '',
      jevNews: row.jevNews,
      selectedAsClusterWinner: winners.has(row.id),
    })),
  };
}

module.exports = {
  NEWS_POOL_TARGET,
  DUPLICATE_CONFIDENCE,
  TOPIC_MATCH_CONFIDENCE,
  DUPLICATE_CANDIDATE_LIMIT,
  NEWS_SCORE_WEIGHTS,
  ExampleCo_RELEVANCE_EXCLUDED_CATEGORIES,
  ExampleCo_CONTEXT,
  scoreCriteria,
  scoreTo100,
  duplicateQuestionKey,
  articleQuestions,
  duplicateShortlist,
  composite,
  scoreArticle,
  confirmedDuplicateEdges,
  interleaveCards,
  rankNewsCards,
};
