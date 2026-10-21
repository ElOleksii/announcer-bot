import type { OdPlayer } from '../opendota.js';
import { DEATHS, benchmarkPct, mmss, plural, ramp, sum } from '../scoring.js';
import { ROLE_SHARE, benchmarkScore, pctOf, scoreArea, shareFact, shareScore, type AreaScore, type RatingInput } from './common.js';

const TIMES = ['раз', 'рази', 'разів'] as const;
/** Fewer pickoffs than this in the whole team and shares are noise. */
const MIN_TEAM_PICKOFFS = 3;

/**
 * Survival: deaths against the same hero in other games, the share of the team's deaths and
 * pickoffs (outside fights) against what the position usually has, and the deaths that cost the
 * most: first to fall in a lost fight, during a throw, and in the tavern without buyback while the
 * throne fell.
 */
export function survival(p: OdPlayer, input: RatingInput): AreaScore {
  const { ctx } = input;
  const position = input.position(p);
  const deathsPct = benchmarkPct(p, 'deaths_per_min');
  const teamDeaths = sum(ctx.ours.map((x) => x.deaths));
  const deathShare = teamDeaths === 0 ? null : p.deaths / teamDeaths;
  const mine = ctx.deaths.filter((d) => d.slot === p.player_slot);
  const goldFed = sum(mine.map((d) => d.goldFed));
  const pickoffs = mine.filter((d) => d.kind === 'pickoff').length;
  const teamPickoffs = ctx.deaths.filter((d) => d.kind === 'pickoff').length;
  const pickoffShare = ctx.parsed && teamPickoffs >= MIN_TEAM_PICKOFFS ? pickoffs / teamPickoffs : null;
  const firstInLost = mine.filter((d) => d.firstInLostFight).length;
  const throwDeaths = mine.filter((d) => d.duringThrow);
  const last = p.deaths_log?.at(-1);
  const boughtBack = last ? (p.buyback_log ?? []).some((b) => b.time >= last.time) : false;
  const deadAtEnd = !!last && !boughtBack && last.time + (last.time_dead ?? 0) >= ctx.duration;
  const deathsFact = `${plural(p.deaths, DEATHS)}: ${shareFact(deathShare, ROLE_SHARE.deaths[position]!, 'смертей команди', position)}`;
  const pickoffsFact = `${plural(pickoffs, TIMES)} помер поодинці, поза файтами: ${shareFact(pickoffShare, ROLE_SHARE.pickoffs[position]!, 'таких смертей команди', position)}`;

  return scoreArea('survival', [
    {
      weight: 0.2,
      value: benchmarkScore(deathsPct, 'deaths_per_min'),
      good: deathsPct === null ? undefined : `смертей менше, ніж у ${pctOf(deathsPct)}% ігор на цьому героєві`,
      bad: deathsPct === null ? undefined : `смертей більше, ніж у ${pctOf(1 - deathsPct)}% ігор на цьому героєві`,
    },
    // A smaller share of the team's deaths than the position usually has is good, hence the minus.
    {
      weight: 0.2,
      value: deathShare === null ? null : -shareScore(deathShare, ROLE_SHARE.deaths[position]!, 0.15, 0.6)!,
      good: deathsFact,
      bad: goldFed > 0 ? `${deathsFact}, віддав ворогу ${goldFed} золота` : deathsFact,
    },
    {
      weight: 0.2,
      value: pickoffShare === null ? null : -shareScore(pickoffShare, ROLE_SHARE.pickoffs[position]!, 0.15, 0.6)!,
      good: pickoffsFact,
      bad: pickoffsFact,
    },
    {
      weight: 0.15,
      value: ctx.parsed ? -ramp(firstInLost, 0, 2) : null,
      bad: `${plural(firstInLost, TIMES)} помер першим у програному файті`,
    },
    {
      weight: 0.1,
      value: ctx.parsed && ctx.hasGoldGraph ? -ramp(throwDeaths.length, 0, 3) : null,
      bad: throwDeaths[0] ? `${plural(throwDeaths.length, DEATHS)}, поки перевага обвалювалась (перша на ${mmss(throwDeaths[0].time)})` : undefined,
    },
    {
      weight: 0.15,
      // Only a loss ends with our throne falling.
      value: ctx.won === false && p.deaths_log ? (deadAtEnd ? -1 : 0) : null,
      bad: last ? `помер на ${mmss(last.time)} і був у таверні без байбеку, коли падав трон` : undefined,
    },
  ]);
}
