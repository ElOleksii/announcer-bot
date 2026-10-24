import type { PlayerRating } from './rating.js';
import { ROLE_WEIGHTS } from './rating.js';
import { sum } from './scoring.js';

/**
 * How sure the analysis can be: the share of our players' ratings that had data. A parsed replay
 * usually covers 85–95% (uneven lanes, a team that never hit buildings, a private profile drop
 * parts); a match OpenDota has not parsed yet covers about two thirds. A single culprit is named
 * only with a parsed replay and enough data.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Confidence {
  level: ConfidenceLevel;
  /** 0–1: average share of the role weight that had data. */
  coverage: number;
}

export const HIGH_COVERAGE = 0.85;
export const MEDIUM_COVERAGE = 0.7;

export function confidence(players: PlayerRating[], parsed: boolean): Confidence {
  const shares = players.map((p) => {
    const roleTotal = sum(Object.values(ROLE_WEIGHTS[p.position]!));
    return sum(p.areas.filter((a) => a.weight > 0).map((a) => a.roleWeight)) / roleTotal;
  });
  const coverage = shares.length ? sum(shares) / shares.length : 0;
  const level: ConfidenceLevel = !parsed ? 'low' : coverage >= HIGH_COVERAGE ? 'high' : coverage >= MEDIUM_COVERAGE ? 'medium' : 'low';
  return { level, coverage };
}
