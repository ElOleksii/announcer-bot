import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_MEDIAN, benchmarkScore, shareScore, signedRamp, versus } from '../src/analysis/areas/common.js';
import { computeBlame } from '../src/analysis/blame.js';
import { computeMvp } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { OFFSET, ROLE_WEIGHTS, rateTeam } from '../src/analysis/rating.js';
import { round1, sum } from '../src/analysis/scoring.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const load = (name: string): OdMatch => matchSchema.parse(fixture(name));
const heroes = new Map((fixture('opendota-heroes') as HeroInfo[]).map((h) => [h.id, h]));

describe('signed scores', () => {
  it('signedRamp: 0 inside the dead zone, ±1 beyond, linear between', () => {
    expect(signedRamp(0.05, 0.1, 0.5)).toBe(0);
    expect(signedRamp(0.3, 0.1, 0.5)).toBeCloseTo(0.5);
    expect(signedRamp(-0.3, 0.1, 0.5)).toBeCloseTo(-0.5);
    expect(signedRamp(-2, 0.1, 0.5)).toBe(-1);
  });

  it('versus: relative to the opponent, missing data stays missing', () => {
    expect(versus(130, 100, 0.1, 0.5)).toBeCloseTo(0.5);
    expect(versus(70, 100, 0.1, 0.5)).toBeCloseTo(-0.5);
    expect(versus(null, 100, 0.1, 0.5)).toBeNull();
  });

  it('a benchmark percentile at the ranked All Pick median scores 0, not one at 0.5', () => {
    expect(benchmarkScore(BENCHMARK_MEDIAN.hero_damage_per_min!, 'hero_damage_per_min')).toBe(0);
    expect(benchmarkScore(0.5, 'hero_damage_per_min')).toBeGreaterThan(0);
    expect(benchmarkScore(null, 'hero_damage_per_min')).toBeNull();
  });

  it('a share is judged against the typical share for the position', () => {
    expect(shareScore(0.25, 0.25)).toBe(0);
    expect(shareScore(0.35, 0.25)).toBeGreaterThan(0);
    expect(shareScore(0.15, 0.25)).toBeLessThan(0);
  });
});

describe('role weights', () => {
  it('give every position the same total, so no role starts ahead', () => {
    const totals = [1, 2, 3, 4, 5].map((pos) => sum(Object.values(ROLE_WEIGHTS[pos]!)));
    expect(new Set(totals).size).toBe(1);
  });
});

describe('one rating for wins and losses', () => {
  const match = load('opendota-ranked-parsed');

  it.each([true, false])('blame and contribution follow from the same area values (radiant=%s)', (radiant) => {
    for (const p of rateTeam(match, heroes, radiant).players) {
      const negative = sum(p.areas.map((a) => a.weight * Math.max(0, -(a.value ?? 0))));
      const positive = sum(p.areas.map((a) => a.weight * Math.max(0, a.value ?? 0)));
      expect(p.blame).toBeCloseTo(round1(Math.min(100, Math.max(0, negative - OFFSET * positive))), 5);
      expect(p.contribution).toBeCloseTo(round1(Math.min(100, Math.max(0, positive - OFFSET * negative))), 5);
      // Areas with data share the 100 points; the rest drop out.
      expect(sum(p.areas.map((a) => a.weight))).toBeCloseTo(100, 5);
      for (const a of p.areas) if (a.value === null) expect(a.weight).toBe(0);
    }
  });

  it('a loss and a win report the same areas: blame points where the area is negative, contribution where positive', () => {
    const blame = computeBlame(match, heroes, false);
    const mvp = computeMvp(match, heroes, false);
    for (const b of blame.players) {
      const m = mvp.players.find((x) => x.slot === b.slot)!;
      b.categories.forEach((c, i) => {
        const other = m.categories[i]!;
        expect(other.key).toBe(c.key);
        expect(other.max).toBe(c.max);
        expect(c.points > 0 && other.points > 0).toBe(false);
      });
    }
  });

  it('uneven lanes drop out of the rating instead of counting as zero', () => {
    // Dire's offlaner stood alone against two.
    const offlaner = rateTeam(match, heroes, false).players.find((p) => p.position === 3)!;
    expect(offlaner.areas.find((a) => a.key === 'lane')!.weight).toBe(0);
    expect(offlaner.notes).toContain('стояв сам проти двох на лайні');
  });

  it('without a parsed replay the rating still works from basic stats', () => {
    for (const p of rateTeam(load('opendota-ranked-unparsed'), heroes, true).players) {
      expect(p.areas.find((a) => a.key === 'lane')!.weight).toBe(0);
      expect(p.areas.find((a) => a.key === 'farm')!.value === null).toBe(false);
      expect(p.blame).toBeGreaterThanOrEqual(0);
    }
  });
});
