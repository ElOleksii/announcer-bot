import type { OdMatch, OdPlayer } from './opendota.js';

/** Shared building blocks for the blame (loss) and MVP (win) scoring. */

export interface CategoryScore<K extends string = string> {
  key: K;
  points: number;
  max: number;
  /** false when the match lacks the data for this category (e.g. not parsed). */
  available: boolean;
  /** Facts with numbers that explain the points. */
  evidence: string[];
}

export interface Part {
  weight: number;
  /** 0..1, or null when the data is missing. */
  value: number | null;
  evidence?: string;
}

/** 0 below `lo`, 1 above `hi`, linear in between. */
export function ramp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
}

/** Weighted average of the available parts, scaled to `max` points. Missing parts don't count. */
export function scoreCategory<K extends string>(key: K, max: number, parts: Part[], factor = 1): CategoryScore<K> {
  const available = parts.filter((p) => p.value !== null);
  if (available.length === 0) return { key, points: 0, max, available: false, evidence: [] };
  const totalWeight = available.reduce((s, p) => s + p.weight, 0);
  const share = available.reduce((s, p) => s + p.weight * (p.value ?? 0), 0) / totalWeight;
  return {
    key,
    points: round1(share * max * factor),
    max,
    available: true,
    evidence: available.filter((p) => (p.value ?? 0) > 0 && p.evidence).map((p) => p.evidence!),
  };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (n: number) => Math.round(n * 100);
export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
export const num = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Ukrainian plural: 1 смерть, 2 смерті, 5 смертей. */
export function plural(n: number, [one, few, many]: readonly [string, string, string]): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}

export const DEATHS = ['смерть', 'смерті', 'смертей'] as const;
export const KILLS = ['кіл', 'кіли', 'кілів'] as const;

/** Positions 1–5 from OpenDota's estimate; falls back to net worth order if missing or duplicated. */
export function assignPositions(team: OdPlayer[]): Map<number, number> {
  const estimates = team.map((p) => num(p.position_est));
  const valid = estimates.every((e) => e !== null && e >= 1 && e <= 5) && new Set(estimates).size === team.length;
  if (valid) return new Map(team.map((p, i) => [p.player_slot, estimates[i]!]));
  const byNetWorth = [...team].sort((a, b) => (num(b.net_worth) ?? b.gold_per_min) - (num(a.net_worth) ?? a.gold_per_min));
  return new Map(byNetWorth.map((p, i) => [p.player_slot, i + 1]));
}

export function isLeaver(p: OdPlayer): boolean {
  return (num(p.abandons) ?? 0) > 0 || (num(p.leaver_status) ?? 0) >= 2;
}

/** Index `minute` of a per-minute series, if present. */
export function at(series: number[] | null | undefined, minute: number): number | null {
  return series && series.length > minute ? (series[minute] ?? null) : null;
}

/** Enemy wards destroyed (observers and sentries). */
export function dewardCount(p: OdPlayer): number | null {
  const obs = num(p.observer_kills);
  const sen = num(p.sentry_kills);
  return obs === null && sen === null ? null : (obs ?? 0) + (sen ?? 0);
}

/** 0..1: where this game ranks among recent public games on the same hero (OpenDota benchmarks). */
export function benchmarkPct(p: OdPlayer, key: string): number | null {
  return num(p.benchmarks?.[key]?.pct);
}

export const WARDS = ['вард', 'варди', 'вардів'] as const;
export const DEWARDS = ['дівард', 'діварди', 'дівардів'] as const;

export function wardCount(p: OdPlayer): number | null {
  const obs = num(p.obs_placed);
  const sen = num(p.sen_placed);
  return obs === null && sen === null ? null : (obs ?? 0) + (sen ?? 0);
}

/** Splits a match into our team and theirs, with positions and direct (same position) opponents. */
export function teams(match: OdMatch, ourTeamIsRadiant: boolean) {
  const ours = match.players.filter((p) => p.isRadiant === ourTeamIsRadiant);
  const theirs = match.players.filter((p) => p.isRadiant !== ourTeamIsRadiant);
  const ourPos = assignPositions(ours);
  const theirPos = assignPositions(theirs);
  const opponentOf = (p: OdPlayer) => theirs.find((e) => theirPos.get(e.player_slot) === ourPos.get(p.player_slot)) ?? null;
  return { ours, theirs, ourPos, opponentOf };
}

/** The lane stage is judged at this minute. */
export const LANE_MINUTE = 10;

/** "на 10-й хвилині лінія мала 5200 золота проти 6100 у Lion і Juggernaut" ("лінія мала" only for a duo). */
export function laneFact(m: LaneMatchup, totals: [number, number], unit: string, heroName: (p: OdPlayer) => string): string {
  const duo = m.allies.length > 1 ? 'лінія мала ' : '';
  return `на ${LANE_MINUTE}-й хвилині ${duo}${totals[0]} ${unit} проти ${totals[1]} у ${m.enemies.map(heroName).join(' і ')}`;
}

/** Map lane (1 bottom, 2 middle, 3 top) of a player who laned rather than roamed or jungled. */
export function mapLane(p: OdPlayer): number | null {
  const lane = num(p.lane);
  return lane !== null && lane >= 1 && lane <= 3 && !p.is_roaming ? lane : null;
}

export interface LaneMatchup {
  /** Our players in that lane, the player included. */
  allies: OdPlayer[];
  enemies: OdPlayer[];
  /** Lane totals [ours, theirs] at the minute; null when missing or the sides are uneven (1 vs 2). */
  gold: [number, number] | null;
  xp: [number, number] | null;
}

/**
 * Who actually stood against whom in the player's lane. Lanes are geographic, so our safe lane meets
 * their offlane: comparing position 1 with their position 1 would compare players who never met.
 */
export function laneMatchup(p: OdPlayer, ours: OdPlayer[], theirs: OdPlayer[], minute: number): LaneMatchup | null {
  const lane = mapLane(p);
  if (lane === null) return null;
  const allies = ours.filter((x) => mapLane(x) === lane);
  const enemies = theirs.filter((x) => mapLane(x) === lane);
  const even = enemies.length > 0 && allies.length === enemies.length;
  const total = (side: OdPlayer[], series: (x: OdPlayer) => number[] | null | undefined): number | null => {
    const values = side.map((x) => at(series(x), minute));
    return values.every((v) => v !== null) ? sum(values as number[]) : null;
  };
  const pair = (series: (x: OdPlayer) => number[] | null | undefined): [number, number] | null => {
    if (!even) return null;
    const mine = total(allies, series);
    const theirsTotal = total(enemies, series);
    return mine === null || theirsTotal === null ? null : [mine, theirsTotal];
  };
  return { allies, enemies, gold: pair((x) => x.gold_t), xp: pair((x) => x.xp_t) };
}

/** A drop of our gold lead this big within two minutes is a throw. */
export const THROW_DROP = 5000;

/** Minutes (end of a 2-minute window) where our gold lead changed by at least `delta` (negative = dropped). */
export function swingMinutes(match: OdMatch, ourTeamIsRadiant: boolean, delta: number): number[] {
  const sign = ourTeamIsRadiant ? 1 : -1;
  const adv = match.radiant_gold_adv?.map((g) => g * sign);
  if (!adv) return [];
  const minutes: number[] = [];
  for (let t = 2; t < adv.length; t++) {
    const change = (adv[t] ?? 0) - (adv[t - 2] ?? 0);
    if (delta < 0 ? change <= delta : change >= delta) minutes.push(t);
  }
  return minutes;
}
