import type { AreaKey } from './areas/common.js';
import type { DraftOutlook } from './draft.js';
import type { HeroInfo, OdMatch, OdPlayer } from './opendota.js';
import { AREA_LABELS, rateTeam, type PlayerRating } from './rating.js';
import type { ReferenceData } from './reference.js';
import { at, round1, type CategoryScore as Scored } from './scoring.js';

export { assignPositions, isLeaver, plural, ramp } from './scoring.js';

/**
 * Deterministic "who lost us the game", from the shared rating (see rating.ts):
 * - everyone is rated in six areas against expectations for their hero, role and opponent;
 * - blame is what went wrong, weighted by role, minus half of what went right (0–100);
 * - a leaver gets 100 and everyone else is halved;
 * - a single culprit only with enough points and a clear lead, otherwise the whole team.
 * The AI only phrases the result; it never decides who is to blame.
 */

export type CategoryKey = AreaKey;
export const CATEGORY_LABELS: Record<CategoryKey, string> = AREA_LABELS;

export const CULPRIT_MIN_SCORE = 45;
export const CULPRIT_MIN_GAP = 10;
const LEAVER_MITIGATION = 0.5;

export type CategoryScore = Scored<CategoryKey>;

export interface PlayerBlame {
  slot: number;
  hero: string;
  position: number;
  /** Blame from the rating, before the leaver rule. */
  raw: number;
  /** Final score 0–100. */
  score: number;
  /** Areas that apply to the role: blame points out of what the area can move. */
  categories: CategoryScore[];
  /** What softens the verdict: context, and the strongest facts in the player's favour. */
  mitigations: string[];
  /** The strongest facts against this player (up to 3). */
  evidence: string[];
  leaver: boolean;
}

export type Verdict =
  | { kind: 'culprit'; slot: number }
  | { kind: 'team'; reason: 'behind-everywhere' | 'no-clear-culprit' };

export interface BlameReport {
  matchId: number;
  durationSec: number;
  ourTeam: 'radiant' | 'dire';
  lost: boolean;
  /** true when OpenDota parsed the replay; otherwise several areas are unavailable. */
  parsed: boolean;
  /** Our players, highest score first. */
  players: PlayerBlame[];
  verdict: Verdict;
  /** Rough read of the draft, shown as context; null without hero stats. */
  draft: DraftOutlook | null;
}

/** Each area's share of what went wrong, as table points. */
export function categories(rating: PlayerRating, sign: 1 | -1): Array<Scored<AreaKey>> {
  return rating.areas
    .filter((a) => a.roleWeight > 0)
    .map((a) => ({
      key: a.key,
      points: round1(a.weight * Math.max(0, sign * (a.value ?? 0))),
      max: round1(a.weight),
      available: a.weight > 0,
      evidence: (sign === 1 ? a.good : a.bad).map((f) => f.text),
    }));
}

export function computeBlame(match: OdMatch, heroes: Map<number, HeroInfo>, ourTeamIsRadiant: boolean, ref?: ReferenceData): BlameReport {
  const { context, players: ratings, opponentOf, draft } = rateTeam(match, heroes, ourTeamIsRadiant, ref);
  const anyLeaver = ratings.some((r) => r.leaver);

  const players: PlayerBlame[] = ratings.map((r) => {
    const mitigations = [...r.notes];
    if (!r.leaver && anyLeaver) mitigations.push('грав без лівера');
    mitigations.push(...r.good.slice(0, 2));
    const score = r.leaver ? 100 : Math.round(anyLeaver ? r.blame * LEAVER_MITIGATION : r.blame);
    const evidence = r.bad.slice(0, 3);
    if (r.leaver) evidence.unshift('покинув гру');
    return { slot: r.slot, hero: r.hero, position: r.position, raw: r.blame, score, categories: categories(r, -1), mitigations, evidence, leaver: r.leaver };
  });
  players.sort((a, b) => b.score - a.score || b.raw - a.raw);

  return {
    matchId: match.match_id,
    durationSec: match.duration,
    ourTeam: ourTeamIsRadiant ? 'radiant' : 'dire',
    lost: context.won === false,
    parsed: context.parsed,
    players,
    verdict: decideVerdict(players, context.ours, opponentOf, context.positions),
    draft,
  };
}

function decideVerdict(
  players: PlayerBlame[],
  ours: OdPlayer[],
  opponentOf: (p: OdPlayer) => OdPlayer | null,
  positions: Map<number, number>,
): Verdict {
  const leaver = players.find((p) => p.leaver);
  if (leaver) return { kind: 'culprit', slot: leaver.slot };

  // Every core behind its opponent by ≥ 15% net worth at 15 minutes → the whole team lost it.
  const cores = ours.filter((p) => (positions.get(p.player_slot) ?? 5) <= 3);
  const comparisons = cores.map((p) => {
    const mine = at(p.gold_t, 15);
    const theirs = at(opponentOf(p)?.gold_t, 15);
    return mine === null || theirs === null ? null : mine < theirs * 0.85;
  });
  if (comparisons.length > 0 && comparisons.every((c) => c === true)) return { kind: 'team', reason: 'behind-everywhere' };

  const [first, second] = players;
  if (first && first.score >= CULPRIT_MIN_SCORE && first.score - (second?.score ?? 0) >= CULPRIT_MIN_GAP) {
    return { kind: 'culprit', slot: first.slot };
  }
  return { kind: 'team', reason: 'no-clear-culprit' };
}

/** Which team "we" were on: by account id (from GSI), else by hero id. */
export function findOurTeam(match: OdMatch, { accountId, heroId }: { accountId?: number | null; heroId?: number | null }): boolean | null {
  const byAccount = accountId ? match.players.find((p) => p.account_id === accountId) : undefined;
  if (byAccount) return byAccount.isRadiant;
  const byHero = heroId ? match.players.find((p) => p.hero_id === heroId) : undefined;
  return byHero ? byHero.isRadiant : null;
}
