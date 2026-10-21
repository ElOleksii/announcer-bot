import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeBlame } from '../src/analysis/blame.js';
import { computeMvp } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { formatMvpChat } from '../src/analysis/report.js';
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

describe('one 0–100 scale for every role', () => {
  const match = load('opendota-ranked-parsed');
  const sumPoints = (cats: Array<{ points: number }>) => cats.reduce((s, c) => s + c.points, 0);

  it.each([
    ['blame', computeBlame(match, heroes, false).players],
    ['MVP', computeMvp(match, heroes, true).players],
  ] as const)('%s: supports are rescaled by 100/80 because farm does not apply, cores are not', (_name, players) => {
    for (const p of players) {
      const farm = p.categories.find((c) => c.key === 'farm')!;
      expect(farm.applicable).toBe(p.position <= 3);
      expect(p.raw).toBeCloseTo(sumPoints(p.categories) * (p.position >= 4 ? 100 / 80 : 1), 0);
    }
  });

  it('a support with the same category points as a core gets the higher score', () => {
    const report = computeMvp(match, heroes, true);
    const support = report.players.find((p) => p.position === 5)!;
    expect(support.score).toBeGreaterThan(sumPoints(support.categories));
  });

  it('explains the rescaling under the chat table', () => {
    const text = formatMvpChat(computeMvp(match, heroes, true));
    expect(text).toContain('Саппортам фарм не рахується, тому їхні бали перераховано на 100 (×1.25)');
    expect(text.indexOf('×1.25')).toBeGreaterThan(text.lastIndexOf('```'));
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
