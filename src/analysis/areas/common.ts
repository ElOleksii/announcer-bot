import type { MatchContext } from '../context.js';
import type { OdPlayer } from '../opendota.js';
import { ramp } from '../scoring.js';

/** The six areas every player is rated in; the role decides how much each one weighs. */
export type AreaKey = 'lane' | 'farm' | 'fights' | 'survival' | 'objectives' | 'support';

export const AREA_KEYS: readonly AreaKey[] = ['lane', 'farm', 'fights', 'survival', 'objectives', 'support'];

export interface Part {
  weight: number;
  /** −1 (worst) … +1 (best), 0 = as expected; null when the match lacks the data. */
  value: number | null;
  /** The fact with numbers, shown when the part counts against the player… */
  bad?: string | undefined;
  /** …or in their favour. */
  good?: string | undefined;
}

export interface Fact {
  text: string;
  /** Share of the area's value this fact accounts for (0…1), to rank facts across areas. */
  weight: number;
}

export interface AreaScore {
  key: AreaKey;
  /** Weighted average of the available parts, −1…+1; null when no part is available. */
  value: number | null;
  good: Fact[];
  bad: Fact[];
  /** Context that explains a missing or softened score, e.g. "alone against two in lane". */
  notes: string[];
}

/** What an area needs besides the player: the match context and lookups into it. */
export interface RatingInput {
  ctx: MatchContext;
  position(p: OdPlayer): number;
  /** The enemy on the same position. */
  opponent(p: OdPlayer): OdPlayer | null;
  heroName(p: OdPlayer): string;
  /** Sum of a stat over our team. */
  teamTotal(stat: (p: OdPlayer) => number | null | undefined): number;
  /** Minutes (end of a 2-minute window) where our gold lead jumped by SURGE_GAIN or more. */
  surges: number[];
}

/** 0 inside ±lo, ±1 beyond ±hi, linear in between. */
export function signedRamp(x: number, lo: number, hi: number): number {
  return Math.sign(x) * ramp(Math.abs(x), lo, hi);
}

/** Relative difference to the opponent's value (0.2 = 20% more), as a signed score. */
export function versus(mine: number | null | undefined, theirs: number | null | undefined, lo: number, hi: number): number | null {
  if (mine == null || theirs == null) return null;
  return signedRamp((mine - theirs) / Math.max(Math.abs(theirs), 1), lo, hi);
}

/**
 * Typical OpenDota benchmark percentiles (same hero in other public games) in ranked All Pick.
 * They sit well below 0.5 because the comparison games are mostly Turbo, with more gold and
 * damage per minute; centring on these medians makes "as usual for the hero" score 0.
 * Medians over 32 ranked All Pick matches; `npm run calibrate` prints them for a re-check.
 */
export const BENCHMARK_MEDIAN: Record<string, number> = {
  gold_per_min: 0.32,
  last_hits_per_min: 0.35,
  hero_damage_per_min: 0.24,
  tower_damage: 0.41,
  deaths_per_min: 0.59,
};

/** A benchmark percentile (higher is always better, deaths included) as a signed score. */
export function benchmarkScore(pct: number | null, key: string): number | null {
  return pct === null ? null : signedRamp(pct - (BENCHMARK_MEDIAN[key] ?? 0.5), 0.1, 0.35);
}

/**
 * A player's typical share of their own team's total, by position (index 1–5). Shares hardly depend
 * on the result (winners and losers have the same medians), so they compare teammates fairly where
 * comparing with the enemy would only show who won. Medians over 32 ranked All Pick matches.
 */
export const ROLE_SHARE: Record<'netWorth' | 'heroDamage' | 'killParticipation' | 'towerDamage' | 'deaths' | 'pickoffs' | 'xpm', readonly number[]> = {
  netWorth: [0, 0.25, 0.23, 0.23, 0.146, 0.138],
  // Supports die more than cores in every game: compared with the team average they would always look worse.
  deaths: [0, 0.154, 0.167, 0.194, 0.217, 0.231],
  pickoffs: [0, 0.174, 0.174, 0.188, 0.211, 0.24],
  xpm: [0, 0.23, 0.241, 0.209, 0.162, 0.165],
  heroDamage: [0, 0.174, 0.251, 0.218, 0.162, 0.176],
  killParticipation: [0, 0.41, 0.52, 0.52, 0.57, 0.51],
  towerDamage: [0, 0.237, 0.318, 0.166, 0.034, 0.033],
};

/** Share of the team total against the typical share for the position, as a signed score. */
export function shareScore(share: number | null, typical: number, lo = 0.1, hi = 0.4): number | null {
  return share === null ? null : signedRamp((share - typical) / typical, lo, hi);
}

export const pctOf = (share: number) => Math.round(share * 100);

/** "урон по героях: краще, ніж у 70% ігор на цьому героєві" (good) / "…гірше, ніж у 80%…" (bad). */
export function heroPercentileFacts(label: string, pct: number | null): Pick<Part, 'good' | 'bad'> {
  if (pct === null) return {};
  return {
    good: `${label}: краще, ніж у ${pctOf(pct)}% ігор на цьому героєві`,
    bad: `${label}: гірше, ніж у ${pctOf(1 - pct)}% ігор на цьому героєві`,
  };
}

/** "26% нетворсу команди (зазвичай 23% на позиції 3)". */
export function shareFact(share: number | null, typical: number, what: string, position: number): string | undefined {
  return share === null ? undefined : `${pctOf(share)}% ${what} (зазвичай ${pctOf(typical)}% на позиції ${position})`;
}

/** Weighted average of the available parts; facts keep their share of it for ranking. */
export function scoreArea(key: AreaKey, parts: Part[], notes: string[] = []): AreaScore {
  const available = parts.filter((p) => p.value !== null);
  const total = available.reduce((s, p) => s + p.weight, 0);
  if (available.length === 0 || total === 0) return { key, value: null, good: [], bad: [], notes };
  const value = available.reduce((s, p) => s + p.weight * p.value!, 0) / total;
  const facts = (sign: 1 | -1, text: (p: Part) => string | undefined): Fact[] =>
    available
      .filter((p) => Math.sign(p.value!) === sign && text(p))
      .map((p) => ({ text: text(p)!, weight: (p.weight * Math.abs(p.value!)) / total }))
      .sort((a, b) => b.weight - a.weight);
  return { key, value, good: facts(1, (p) => p.good), bad: facts(-1, (p) => p.bad), notes };
}
