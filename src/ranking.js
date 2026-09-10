const WORD_PATTERN = /[\p{L}\p{N}_.$:/-]+/gu;

export function tokenize(value) {
  if (typeof value !== "string") return [];
  return (value.match(WORD_PATTERN) || [])
    .flatMap((token) => token
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s/_.:$-]+/))
    .filter((token) => token.length > 1)
    .slice(0, 512);
}

export function reciprocalRankFusion(rankings, { k = 60, weights = [] } = {}) {
  const fused = new Map();
  rankings.forEach((ranking, rankingIndex) => {
    const weight = Number(weights[rankingIndex] ?? 1);
    ranking.forEach((item, index) => {
      const id = typeof item === "string" ? item : item.id;
      if (!id) return;
      const current = fused.get(id) || { id, score: 0, signals: {} };
      const signal = typeof item === "string" ? `rank_${rankingIndex}` : (item.signal || `rank_${rankingIndex}`);
      const contribution = weight / (k + index + 1);
      current.score += contribution;
      current.signals[signal] = contribution;
      fused.set(id, current);
    });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function jaccardSimilarity(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function maxMarginalRelevance(candidates, {
  topK = 8,
  lambda = 0.78,
  text = (item) => `${item.title || ""}\n${item.body || ""}`,
  relevance = (item) => Number(item.score || 0),
} = {}) {
  const remaining = [...candidates];
  const selected = [];
  while (remaining.length && selected.length < topK) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.reduce(
        (maximum, chosen) => Math.max(maximum, jaccardSimilarity(text(candidate), text(chosen))),
        0,
      );
      const score = lambda * relevance(candidate) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

export function freshnessScore({ updated_at, valid_to, expires_at, stale = 0 }, now = Date.now()) {
  if (Number(stale) === 1) return 0;
  const hardEnd = valid_to || expires_at;
  if (hardEnd && Date.parse(hardEnd) <= now) return 0;
  const updated = Date.parse(updated_at || 0);
  if (!Number.isFinite(updated)) return 0.5;
  const ageDays = Math.max(0, (now - updated) / 86_400_000);
  return Math.exp(-Math.log(2) * ageDays / 180);
}

export function normalizeBm25(value) {
  const numeric = Math.abs(Number(value));
  if (!Number.isFinite(numeric)) return 0;
  return numeric / (1 + numeric);
}
