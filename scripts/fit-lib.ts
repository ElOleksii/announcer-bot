/**
 * Small statistics for checking the role weights against data (scripts/fit-weights.ts):
 * AUC, a regularised logistic regression, a seeded bootstrap and the weight suggestion.
 */

/** Probability that a random `pos` value beats a random `neg` value (0.5 = no difference). */
export function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : Number.NaN;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Logistic regression without intercept (the features are differences between two symmetric
 * sides), with an L2 penalty that pulls weights towards 0 when the data is thin. Plain gradient
 * descent: a few dozen features and a few hundred matches.
 */
export function logisticFit(x: number[][], y: number[], { l2 = 1, iterations = 3000, rate = 0.5 } = {}): number[] {
  const features = x[0]?.length ?? 0;
  const w = new Array<number>(features).fill(0);
  const n = x.length;
  if (n === 0) return w;
  for (let it = 0; it < iterations; it++) {
    const grad = w.map((wi) => l2 * wi);
    for (let i = 0; i < n; i++) {
      const row = x[i]!;
      const err = sigmoid(row.reduce((s, v, j) => s + v * w[j]!, 0)) - y[i]!;
      for (let j = 0; j < features; j++) grad[j]! += err * row[j]!;
    }
    for (let j = 0; j < features; j++) w[j]! -= (rate * grad[j]!) / n;
  }
  return w;
}

/** Deterministic random numbers, so bootstrap ranges are the same on every run. */
export function seededRandom(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `stat` over `times` resamples (with replacement) of `items`. */
export function bootstrap<T, R>(items: T[], times: number, stat: (sample: T[]) => R, seed = 1): R[] {
  const random = seededRandom(seed);
  return Array.from({ length: times }, () => stat(items.map(() => items[Math.floor(random() * items.length)]!)));
}

export function quantile(xs: number[], q: number): number {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
}

/**
 * Suggested weights for one position: the model's positive coefficients scaled to the same total
 * as the current weights, then blended with the current ones as if they were worth `prior` matches.
 * With little data the suggestion stays close to today's weights.
 */
export function suggestWeights<K extends string>(current: Record<K, number>, coefficients: Record<K, number>, matches: number, prior: number): Record<K, number> {
  const keys = Object.keys(current) as K[];
  const total = keys.reduce((s, k) => s + current[k], 0);
  const positive = keys.map((k) => Math.max(0, coefficients[k] ?? 0));
  const sum = positive.reduce((s, v) => s + v, 0);
  const fitted = keys.map((k, i) => (sum > 0 ? (positive[i]! / sum) * total : current[k]));
  return Object.fromEntries(keys.map((k, i) => [k, (matches * fitted[i]! + prior * current[k]) / (matches + prior)])) as Record<K, number>;
}
