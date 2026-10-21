import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIGHT_EVEN_GOLD, buildContext, rankBracket } from '../src/analysis/context.js';
import { matchSchema, type OdMatch, type OdPlayer } from '../src/analysis/opendota.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
const load = (name: string): OdMatch => matchSchema.parse(fixture(name));

describe('match context on a real parsed ranked match (Radiant won)', () => {
  const raw = fixture('opendota-ranked-parsed') as { teamfights: Array<{ players: Array<{ gold_delta: number }> }> };
  const match = load('opendota-ranked-parsed');
  const radiant = buildContext(match, true);
  const dire = buildContext(match, false);

  it('knows the mode, the bracket and the result', () => {
    expect([radiant.mode, radiant.parsed, radiant.won, dire.won]).toEqual(['ranked-all-pick', true, true, false]);
    // Ranks 52 51 51 52 54 44 61 53 51 42: average 51.1 → Legend.
    expect(radiant.bracket).toBe(5);
    expect(new Set([...radiant.positions.values()])).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(radiant.positions.size).toBe(10);
  });

  it('gold swing of a fight is our gold gained minus theirs, the same fight seen from both sides', () => {
    expect(radiant.fights).toHaveLength(5);
    radiant.fights.forEach((f, i) => {
      const deltas = raw.teamfights[i]!.players.map((p) => p.gold_delta);
      expect(f.goldSwing).toBe(deltas.slice(0, 5).reduce((a, b) => a + b, 0) - deltas.slice(5).reduce((a, b) => a + b, 0));
      expect(dire.fights[i]!.goldSwing).toBe(-f.goldSwing);
      expect(f.outcome).toBe(f.goldSwing >= FIGHT_EVEN_GOLD ? 'won' : f.goldSwing <= -FIGHT_EVEN_GOLD ? 'lost' : 'even');
    });
    expect(radiant.fights.map((f) => f.outcome)).toEqual(['even', 'even', 'won', 'lost', 'lost']);
    expect(dire.fights.map((f) => f.outcome)).toEqual(['even', 'even', 'lost', 'won', 'won']);
  });

  it('marks every death as in a fight (inside its window) or a pickoff (outside all of them)', () => {
    for (const context of [radiant, dire]) {
      expect(context.deaths).toHaveLength(context.ours.reduce((s, p) => s + (p.deaths_log?.length ?? 0), 0));
      for (const d of context.deaths) {
        if (d.kind === 'fight') {
          const f = context.fights[d.fight!]!;
          expect(d.time).toBeGreaterThanOrEqual(f.start);
          expect(d.time).toBeLessThanOrEqual(f.end);
        } else {
          expect(context.fights.some((f) => d.time >= f.start && d.time <= f.end)).toBe(false);
        }
      }
      expect(context.deaths.map((d) => d.time)).toEqual([...context.deaths.map((d) => d.time)].sort((a, b) => a - b));
    }
    expect(radiant.deaths.filter((d) => d.kind === 'fight')).toHaveLength(11);
    expect(radiant.deaths.filter((d) => d.kind === 'pickoff')).toHaveLength(16);
  });

  it('first to die in a lost fight: the earliest of our deaths in a fight we lost', () => {
    const firsts = radiant.deaths.filter((d) => d.firstInLostFight);
    expect(firsts.map((d) => [d.slot, d.time])).toEqual([
      [4, 1390],
      [2, 1993],
    ]);
    for (const d of firsts) {
      const f = radiant.fights[d.fight!]!;
      expect(f.outcome).toBe('lost');
      const ourDeathTimes = radiant.deaths.filter((x) => x.fight === d.fight).map((x) => x.time);
      expect(d.time).toBe(Math.min(...ourDeathTimes));
    }
    // A death in a fight we won is never "first in a lost fight".
    expect(dire.deaths.filter((d) => d.firstInLostFight).every((d) => dire.fights[d.fight!]!.outcome === 'lost')).toBe(true);
  });

  it('the Dire leaver was alive but in none of the fights', () => {
    for (const f of dire.fights) {
      const leaver = f.players.get(131)!;
      if (leaver.aliveAtStart) expect(leaver.present).toBe(false);
    }
  });

  it('deaths during a throw only on the side whose gold lead collapsed', () => {
    expect(radiant.deaths.filter((d) => d.duringThrow)).toHaveLength(0);
    expect(dire.deaths.filter((d) => d.duringThrow)).toHaveLength(5);
  });

  it('a player still in the tavern when a fight starts was not alive for it', () => {
    const copy = load('opendota-ranked-parsed');
    const fight = buildContext(copy, true).fights[2]!;
    const p = copy.players.find((x) => x.player_slot === 0)!;
    p.deaths_log = [...(p.deaths_log ?? []), { time: fight.start - 10, time_dead: 40 }].sort((a, b) => a.time - b.time);
    expect(buildContext(copy, true).fights[2]!.players.get(0)!.aliveAtStart).toBe(false);
  });
});

describe('match context without a parsed replay', () => {
  it('has no fights or deaths, but still the mode and positions', () => {
    const context = buildContext(load('opendota-ranked-unparsed'), true);
    expect([context.parsed, context.mode, context.fights, context.deaths]).toEqual([false, 'ranked-all-pick', [], []]);
    expect(new Set([...context.positions.values()])).toEqual(new Set([1, 2, 3, 4, 5]));
  });
});

describe('rankBracket', () => {
  const players = (...ranks: Array<number | null>) => ranks.map((rank_tier) => ({ rank_tier }) as OdPlayer);

  it('averages the ranks players show, as a medal 1–8', () => {
    expect(rankBracket(players(52, 54, null, 0))).toBe(5);
    expect(rankBracket(players(80, 80))).toBe(8);
    expect(rankBracket(players(11, 12))).toBe(1);
  });

  it('is unknown when nobody shows a rank', () => {
    expect(rankBracket(players(null, 0))).toBeNull();
  });
});
