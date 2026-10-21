import type { AreaKey } from './areas/common.js';
import { categories } from './blame.js';
import type { HeroInfo, OdMatch } from './opendota.js';
import { AREA_LABELS, rateTeam } from './rating.js';
import type { CategoryScore } from './scoring.js';

/**
 * Deterministic "who won us the game", the mirror of the blame from the same rating (rating.ts):
 * contribution is what went right, weighted by role, minus half of what went wrong (0–100);
 * a leaver gets nothing; MVP is the top score, shared when the top two are within MVP_SHARE_GAP.
 * The AI only phrases the result.
 */

export type MvpCategoryKey = AreaKey;
export const MVP_CATEGORY_LABELS: Record<MvpCategoryKey, string> = AREA_LABELS;

/** Two players within this many points share the MVP title. */
export const MVP_SHARE_GAP = 5;

export interface PlayerContribution {
  slot: number;
  hero: string;
  position: number;
  /** Contribution from the rating, before the leaver rule. */
  raw: number;
  /** Final score 0–100. */
  score: number;
  /** Areas that apply to the role: contribution points out of what the area can move. */
  categories: Array<CategoryScore<MvpCategoryKey>>;
  /** The strongest facts against the player, which held their score down. */
  modifiers: string[];
  /** The strongest facts in this player's favour (up to 3). */
  evidence: string[];
  leaver: boolean;
}

export interface MvpReport {
  matchId: number;
  durationSec: number;
  ourTeam: 'radiant' | 'dire';
  parsed: boolean;
  /** Our players, highest score first. */
  players: PlayerContribution[];
  /** One slot, or two when the top scores are within MVP_SHARE_GAP. */
  mvpSlots: number[];
}

export function computeMvp(match: OdMatch, heroes: Map<number, HeroInfo>, ourTeamIsRadiant: boolean): MvpReport {
  const { context, players: ratings } = rateTeam(match, heroes, ourTeamIsRadiant);
  const players: PlayerContribution[] = ratings.map((r) => ({
    slot: r.slot,
    hero: r.hero,
    position: r.position,
    raw: r.contribution,
    score: r.leaver ? 0 : Math.round(r.contribution),
    categories: categories(r, 1),
    modifiers: r.bad.slice(0, 2),
    evidence: r.good.slice(0, 3),
    leaver: r.leaver,
  }));

  players.sort((a, b) => b.score - a.score || b.raw - a.raw);
  const [first, second] = players;
  const mvpSlots = first ? [first.slot] : [];
  if (first && second && !second.leaver && first.score - second.score < MVP_SHARE_GAP) mvpSlots.push(second.slot);

  return {
    matchId: match.match_id,
    durationSec: match.duration,
    ourTeam: ourTeamIsRadiant ? 'radiant' : 'dire',
    parsed: context.parsed,
    players,
    mvpSlots,
  };
}
