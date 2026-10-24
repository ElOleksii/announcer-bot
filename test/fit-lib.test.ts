import { describe, expect, it } from 'vitest';
import { auc, bootstrap, logisticFit, quantile, seededRandom, suggestWeights } from '../scripts/fit-lib.js';

describe('auc', () => {
  it('is the chance a random winner value beats a random loser value', () => {
    expect(auc([3, 4], [1, 2])).toBe(1);
    expect(auc([1, 2], [3, 4])).toBe(0);
    expect(auc([1, 2], [1, 2])).toBe(0.5);
    expect(auc([], [1])).toBeNaN();
  });
});

describe('logisticFit', () => {
  // y follows the first feature; the second is noise.
  const random = seededRandom(7);
  const x = Array.from({ length: 300 }, () => [random() * 2 - 1, random() * 2 - 1]);
  const y = x.map(([a]) => (a! + (random() - 0.5) * 0.5 > 0 ? 1 : 0));

  it('finds the feature that drives the result, and leaves the noise near zero', () => {
    const [signal, noise] = logisticFit(x, y);
    expect(signal).toBeGreaterThan(1);
    expect(Math.abs(noise!)).toBeLessThan(signal! / 4);
  });

  it('a stronger penalty pulls the weights towards zero', () => {
    expect(Math.abs(logisticFit(x, y, { l2: 50 })[0]!)).toBeLessThan(Math.abs(logisticFit(x, y, { l2: 1 })[0]!));
  });

  it('no data, no weights', () => {
    expect(logisticFit([], [])).toEqual([]);
  });
});

describe('bootstrap and quantile', () => {
  it('resamples deterministically for a given seed', () => {
    const items = [1, 2, 3, 4, 5];
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(bootstrap(items, 20, mean, 3)).toEqual(bootstrap(items, 20, mean, 3));
    expect(bootstrap(items, 20, mean, 3)).toHaveLength(20);
  });

  it('quantile interpolates between sorted values and ignores NaN', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, Number.NaN, 3], 0.5)).toBe(2);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('suggestWeights', () => {
  const current = { lane: 20, farm: 50, fights: 30 };

  it('with no matches keeps today’s weights', () => {
    expect(suggestWeights(current, { lane: 1, farm: 0, fights: 0 }, 0, 300)).toEqual(current);
  });

  it('with only data, splits the same total by the positive coefficients; negatives count as zero', () => {
    const fitted = suggestWeights(current, { lane: 1, farm: 3, fights: -2 }, 1000, 0);
    expect(fitted).toEqual({ lane: 25, farm: 75, fights: 0 });
  });

  it('blends the two by how many matches the data has against the prior', () => {
    const blended = suggestWeights(current, { lane: 1, farm: 3, fights: -2 }, 100, 300);
    expect(blended.lane).toBeCloseTo((100 * 25 + 300 * 20) / 400);
    expect(Object.values(blended).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });
});
