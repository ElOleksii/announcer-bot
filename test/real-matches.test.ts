import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeBlame } from '../src/analysis/blame.js';
import { computeMvp } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { LANE_MINUTE, laneMatchup, mapLane } from '../src/analysis/scoring.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const load = (name: string): OdMatch => matchSchema.parse(fixture(name));
const heroes = new Map((fixture('opendota-heroes') as HeroInfo[]).map((h) => [h.id, h]));
const slot = (match: OdMatch, s: number) => match.players.find((p) => p.player_slot === s)!;
const side = (match: OdMatch, radiant: boolean) => match.players.filter((p) => p.isRadiant === radiant);

describe('lane matchups', () => {
  it('compares a lane with the enemies who stood in it, not with the same position', () => {
    const match = load('opendota-match');
    // Radiant safe lane (bottom): Kez pos1 + Hoodwink pos5 against Dire's offlane pos3 + pos4.
    const m = laneMatchup(slot(match, 0), side(match, true), side(match, false), LANE_MINUTE)!;
    expect(m.allies.map((p) => p.player_slot)).toEqual([0, 2]);
    expect(m.enemies.map((p) => p.player_slot)).toEqual([129, 131]);
    expect(m.gold).toEqual([3980 + 1795, 3529 + 1790]);
  });

  it('does not compare uneven lanes, and ignores roamers', () => {
    const match = load('opendota-match');
    // Dire pos1 stood alone at the top: their pos5 is marked as roaming.
    expect(mapLane(slot(match, 128))).toBeNull();
    const m = laneMatchup(slot(match, 132), side(match, false), side(match, true), LANE_MINUTE)!;
    expect(m.allies).toHaveLength(1);
    expect(m.enemies).toHaveLength(2);
    expect(m.gold).toBeNull();
  });

  it('blames a lost lane on both players of the duo with the real lane opponents named', () => {
    const match = load('opendota-match');
    // Dire offlane (bottom) far behind Radiant's safe lane.
    for (const s of [129, 131]) slot(match, s).gold_t = slot(match, s).gold_t!.map((g) => Math.round(g * 0.4));
    const report = computeBlame(match, heroes, false);
    for (const s of [129, 131]) {
      const lane = report.players.find((p) => p.slot === s)!.categories.find((c) => c.key === 'lane')!;
      expect(lane.points).toBeGreaterThan(0);
      expect(lane.evidence.join(' ')).toMatch(/лінія мала \d+ золота проти \d+ у (Kez і Hoodwink|Hoodwink і Kez)/);
    }
    // The support's share is halved.
    const [core, support] = [129, 131].map((s) => report.players.find((p) => p.slot === s)!.categories.find((c) => c.key === 'lane')!.points);
    expect(support).toBeCloseTo(core! / 2, 0);
  });
});

describe('real parsed ranked All Pick match (Radiant won)', () => {
  const match = load('opendota-ranked-parsed');
  const radiant = side(match, true);
  const dire = side(match, false);

  it('is a parsed ranked All Pick game', () => {
    expect([match.lobby_type, match.game_mode]).toEqual([7, 22]);
    expect(match.version).not.toBeNull();
  });

  it('only ever matches players from the same map lane on opposite teams', () => {
    for (const p of match.players) {
      const m = laneMatchup(p, side(match, p.isRadiant), side(match, !p.isRadiant), LANE_MINUTE);
      if (!m) continue;
      for (const x of [...m.allies, ...m.enemies]) expect(mapLane(x)).toBe(mapLane(p));
      expect(m.allies.every((x) => x.isRadiant === p.isRadiant)).toBe(true);
      expect(m.enemies.every((x) => x.isRadiant !== p.isRadiant)).toBe(true);
    }
  });

  it('compares the mid lane one on one, with gold and experience', () => {
    const mid = radiant.find((p) => mapLane(p) === 2)!;
    const m = laneMatchup(mid, radiant, dire, LANE_MINUTE)!;
    expect(m.enemies).toHaveLength(1);
    expect(m.gold).not.toBeNull();
    expect(m.xp).toEqual([mid.xp_t![LANE_MINUTE], m.enemies[0]!.xp_t![LANE_MINUTE]]);
  });

  it('does not score the lane of the Dire offlaner who stood alone against two', () => {
    const report = computeBlame(match, heroes, false);
    expect(report.lost).toBe(true);
    const offlaner = report.players.find((p) => p.position === 3)!;
    expect(offlaner.categories.find((c) => c.key === 'lane')!.points).toBe(0);
    expect(offlaner.mitigations).toContain('стояв сам проти двох на лайні');
  });

  it.each([true, false])('keeps both reports in range for radiant=%s', (isRadiant) => {
    const blame = computeBlame(match, heroes, isRadiant);
    const mvp = computeMvp(match, heroes, isRadiant);
    expect(new Set(blame.players.map((p) => p.position))).toEqual(new Set([1, 2, 3, 4, 5]));
    for (const p of [...blame.players, ...mvp.players]) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
      for (const c of p.categories) expect(c.points).toBeLessThanOrEqual(c.max);
    }
    expect(blame.players.some((p) => p.categories.find((c) => c.key === 'lane')!.available)).toBe(true);
  });
});

describe('supports are judged on support work, not farm', () => {
  const match = load('opendota-ranked-parsed');
  const supportCategory = (p: { categories: Array<{ key: string; points: number; evidence: string[] }> }) =>
    p.categories.find((c) => c.key === 'support')!;

  it('a support can be MVP: Radiant pos4 out-warded and out-levelled the enemy pos4', () => {
    const report = computeMvp(match, heroes, true);
    const pos4 = report.players.find((p) => p.position === 4)!;
    expect(report.mvpSlots).toContain(pos4.slot);
    const support = supportCategory(pos4);
    expect(support.points).toBeGreaterThan(10);
    expect(support.evidence).toEqual(expect.arrayContaining(['18 вардів проти 0 у hero 9', 'XPM 630 проти 80 у hero 9']));
  });

  it('a support is blamed for being under-levelled even with more wards than the enemy support', () => {
    const pos5 = computeBlame(match, heroes, false).players.find((p) => p.position === 5)!;
    const support = supportCategory(pos5);
    expect(support.points).toBeGreaterThan(0);
    expect(support.evidence).toEqual(['XPM 449 проти 667 у hero 100']);
  });

  it("judges a support's hero damage against the same hero in other games", () => {
    const copy = load('opendota-ranked-parsed');
    const pos5 = copy.players.find((p) => !p.isRadiant && p.position_est === 5)!;
    pos5.benchmarks = { ...pos5.benchmarks, hero_damage_per_min: { pct: 0.1 } };
    const blamed = computeBlame(copy, heroes, false).players.find((p) => p.position === 5)!;
    expect(blamed.categories.find((c) => c.key === 'contribution')!.evidence).toContain('урон по героях кращий лише за 10% ігор на цьому героєві');
  });
});

describe('real ranked All Pick match, not parsed yet', () => {
  const match = load('opendota-ranked-unparsed');

  it('is a ranked All Pick game with basic stats only', () => {
    expect(match.lobby_type).toBe(7);
    expect(match.game_mode).toBe(22);
    expect(match.version ?? null).toBeNull();
  });

  it.each([true, false])('scores both reports for radiant=%s without lane or log data', (radiant) => {
    const blame = computeBlame(match, heroes, radiant);
    const mvp = computeMvp(match, heroes, radiant);
    expect(blame.parsed).toBe(false);
    expect(new Set(blame.players.map((p) => p.position)).size).toBe(5);
    for (const p of [...blame.players, ...mvp.players]) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
      expect(p.categories.find((c) => c.key === 'lane')?.available).toBe(false);
    }
  });
});
