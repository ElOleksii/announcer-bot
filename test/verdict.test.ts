import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CULPRIT_MIN_GAP, CULPRIT_MIN_SCORE, computeBlame, decideVerdict, lostEveryLane } from '../src/analysis/blame.js';
import { HIGH_COVERAGE, MEDIUM_COVERAGE, confidence } from '../src/analysis/confidence.js';
import { buildContext, disconnectedSec } from '../src/analysis/context.js';
import { computeMvp } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo, type OdMatch, type OdPlayer } from '../src/analysis/opendota.js';
import { ROLE_WEIGHTS, rateTeam, type PlayerRating } from '../src/analysis/rating.js';
import { fallbackVerdict, formatChatReport, formatMvpChat, verdictUserPrompt } from '../src/analysis/report.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const load = (name = 'opendota-match'): OdMatch => matchSchema.parse(fixture(name));
const heroes = new Map((fixture('opendota-heroes') as HeroInfo[]).map((h) => [h.id, h]));
const DIRE = false;
const dire = (m: OdMatch) => m.players.filter((p) => !p.isRadiant);

/** Makes a Dire player feed hard: many deaths, little farm, damage or kills. */
function feeder(p: OdPlayer, deaths = 18) {
  Object.assign(p, {
    deaths,
    deaths_log: Array.from({ length: deaths }, (_, i) => ({ time: 120 + i * 150, gold_fed: 300, time_dead: 40 })),
    gold_per_min: 250,
    xp_per_min: 300,
    hero_damage: 2000,
    kills: 0,
    assists: 2,
    net_worth: 4000,
    tower_damage: 0,
  });
}

describe('culprit', () => {
  it(`needs ${CULPRIT_MIN_SCORE}+ points and a ${CULPRIT_MIN_GAP}-point lead`, () => {
    const m = load();
    feeder(dire(m).find((p) => p.position_est === 2)!);
    const report = computeBlame(m, heroes, DIRE);
    const [first, second] = report.players;
    expect(first!.score).toBeGreaterThanOrEqual(CULPRIT_MIN_SCORE);
    expect(first!.score - second!.score).toBeGreaterThanOrEqual(CULPRIT_MIN_GAP);
    expect(report.verdict).toEqual({ kind: 'culprit', slot: first!.slot });
  });

  it('a near-tie or a low top score is the whole team, not one player', () => {
    const context = buildContext(load(), DIRE);
    const high = { level: 'high', coverage: 0.9 } as const;
    const team = (...scores: number[]) => scores.map((score, i) => ({ slot: i, score, leaver: false }));
    expect(decideVerdict(team(40, 40 - CULPRIT_MIN_GAP), context, high)).toEqual({ kind: 'culprit', slot: 0 });
    expect(decideVerdict(team(40, 40 - CULPRIT_MIN_GAP + 1), context, high)).toEqual({ kind: 'team', reason: 'no-clear-culprit' });
    expect(decideVerdict(team(CULPRIT_MIN_SCORE - 1, 5), context, high)).toEqual({ kind: 'team', reason: 'no-clear-culprit' });
    expect(decideVerdict(team(40, 10), context, { level: 'medium', coverage: 0.75 })).toEqual({ kind: 'culprit', slot: 0 });
    expect(decideVerdict(team(40, 10), context, { level: 'low', coverage: 0.5 })).toEqual({ kind: 'team', reason: 'not-enough-data' });
  });

  it('is never named from basic stats alone, before the replay is parsed', () => {
    const m = load();
    feeder(dire(m).find((p) => p.position_est === 2)!);
    m.version = null;
    const report = computeBlame(m, heroes, DIRE);
    expect(report.confidence.level).toBe('low');
    expect(report.verdict).toEqual({ kind: 'team', reason: 'not-enough-data' });
    expect(formatChatReport(report)).toContain('Поки без головного винного');
    expect(verdictUserPrompt(report)).toContain('головного винного не названо');
    expect(fallbackVerdict(report, 'harsh')).toContain('головного винного не називаю');
  });

  it('a leaver is still the culprit without a parsed replay: leaving needs no detail', () => {
    const report = computeBlame(load('opendota-ranked-unparsed'), heroes, true);
    expect(report.verdict).toEqual({ kind: 'culprit', slot: 2 });
  });
});

describe('lost every lane', () => {
  it('every comparable lane behind by 15%+ gold at 10:00 → the whole team', () => {
    const m = load();
    // Dire's comparable lanes: bottom (pos3 + pos4) and mid; top is pos1 alone against two.
    for (const p of dire(m)) p.gold_t = p.gold_t!.map((g) => Math.round(g * 0.5));
    expect(lostEveryLane(buildContext(m, DIRE))).toBe(true);
    expect(computeBlame(m, heroes, DIRE).verdict).toEqual({ kind: 'team', reason: 'behind-everywhere' });
  });

  it('one even lane is enough to rule it out', () => {
    const m = load();
    for (const p of dire(m).filter((x) => x.lane === 1)) p.gold_t = p.gold_t!.map((g) => Math.round(g * 0.5));
    expect(lostEveryLane(buildContext(m, DIRE))).toBe(false);
  });

  it('needs at least two lanes to compare', () => {
    const m = load();
    for (const p of dire(m)) {
      p.gold_t = p.gold_t!.map((g) => Math.round(g * 0.5));
      if (p.lane === 2) p.is_roaming = true;
    }
    expect(lostEveryLane(buildContext(m, DIRE))).toBe(false);
  });
});

describe('confidence', () => {
  const rating = (position: number, missing: string[]): PlayerRating =>
    ({
      position,
      areas: rateTeam(load(), heroes, DIRE).players[0]!.areas.map((a) => ({
        ...a,
        roleWeight: ROLE_WEIGHTS[position]![a.key],
        weight: missing.includes(a.key) ? 0 : 1,
      })),
    }) as PlayerRating;

  it('is the share of role weight that had data, and needs a parsed replay to be more than low', () => {
    // Position 1 without lane (15): 85 of 100.
    expect(confidence([rating(1, ['lane'])], true)).toEqual({ level: 'high', coverage: HIGH_COVERAGE });
    // Position 1 without lane (15) and objectives (12): 73 of 100.
    expect(confidence([rating(1, ['lane', 'objectives'])], true).level).toBe('medium');
    expect(confidence([rating(1, ['lane', 'objectives', 'farm'])], true).coverage).toBeLessThan(MEDIUM_COVERAGE);
    expect(confidence([rating(1, [])], false).level).toBe('low');
  });

  it('a real parsed match is rated with high confidence', () => {
    expect(computeBlame(load(), heroes, DIRE).confidence.level).toBe('high');
  });
});

describe('disconnects', () => {
  it('adds up time offline after the horn; a disconnect without reconnect lasts to the end', () => {
    const p = { connection_log: [{ time: -30, event: 'disconnect' }, { time: 60, event: 'reconnect' }, { time: 900, event: 'disconnect' }] } as OdPlayer;
    expect(disconnectedSec(p, 1000)).toBe(60 + 100);
    expect(disconnectedSec({} as OdPlayer, 1000)).toBe(0);
  });

  it('notes a teammate who was offline for minutes, for him and for the rest', () => {
    const m = load();
    const ember = dire(m).find((p) => p.position_est === 2)!;
    ember.connection_log = [
      { time: 600, event: 'disconnect' },
      { time: 900, event: 'reconnect' },
    ];
    const report = computeBlame(m, heroes, DIRE);
    const self = report.players.find((p) => p.slot === ember.player_slot)!;
    expect(self.mitigations).toContain('відключався на 5 хв');
    for (const p of report.players.filter((x) => x !== self)) expect(p.mitigations).toContain(`грав без ${self.hero} 5 хв`);
  });
});

describe('key fight', () => {
  /** The ranked fixture with fight 2 (Radiant +1653) doubled, so it decides the game. */
  function bigFight(): OdMatch {
    const m = load('opendota-ranked-parsed');
    for (const p of m.teamfights![2]!.players) p.gold_delta = (p.gold_delta ?? 0) * 2;
    return m;
  }

  it('in a loss: the most lost fight, with our first player to fall', () => {
    const report = computeBlame(bigFight(), heroes, DIRE);
    expect(report.keyFight).toMatchObject({ start: 944, goldSwing: -3306, ourDeaths: 3, theirDeaths: 1, standout: { hero: 'hero 73' } });
    expect(formatChatReport(report)).toContain('⚔️ Ключовий файт на 15:44: −3306 золота, наших загинуло 3, їхніх 1; першим упав наш hero 73');
    expect(verdictUserPrompt(report)).toContain('Ключовий файт на 15:44');
  });

  it('in a win: the most won fight, with our biggest damage dealer in it', () => {
    const report = computeMvp(bigFight(), heroes, true);
    expect(report.keyFight?.goldSwing).toBe(3306);
    expect(formatMvpChat(report)).toMatch(/⚔️ Ключовий файт на 15:44: \+3306 золота, їхніх загинуло 3, наших 1; найбільше урону — наш .+ \(\d+\)/);
  });

  it('no line when no fight moved 2000 gold', () => {
    const report = computeBlame(load('opendota-ranked-parsed'), heroes, DIRE);
    expect(report.keyFight).toBeNull();
    expect(formatChatReport(report)).not.toContain('Ключовий файт');
  });
});
