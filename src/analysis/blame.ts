import type { AreaKey } from './areas/common.js';
import type { Confidence } from './confidence.js';
import type { MatchContext } from './context.js';
import type { DraftOutlook } from './draft.js';
import type { KeyFight } from './keyfight.js';
import type { HeroInfo, OdMatch } from './opendota.js';
import { AREA_LABELS, rateTeam, type PlayerRating } from './rating.js';
import type { ReferenceData } from './reference.js';
import { mapLane, round1, type CategoryScore as Scored } from './scoring.js';

export { assignPositions, isLeaver, plural, ramp } from './scoring.js';

/**
 * Deterministic "who lost us the game", from the shared rating (see rating.ts):
 * - everyone is rated in six areas against expectations for their hero, role and opponent;
 * - blame is what went wrong, weighted by role, minus half of what went right (0–100);
 * - a leaver gets 100 and everyone else is halved;
 * - a single culprit only with a parsed replay, enough points and a clear lead, otherwise the
 *   whole team (every lane lost, not enough data, or simply no clear culprit).
 * The AI only phrases the result; it never decides who is to blame.
 */

export type CategoryKey = AreaKey;
export const CATEGORY_LABELS: Record<CategoryKey, string> = AREA_LABELS;

/**
 * A culprit needs this many points and this lead over the next player. On 32 ranked All Pick
 * matches without a leaver this names one in a third of the losses, spread over every position;
 * closer than 10 points is a near-tie, where "the whole team" is the fair answer.
 */
export const CULPRIT_MIN_SCORE = 25;
export const CULPRIT_MIN_GAP = 10;
const LEAVER_MITIGATION = 0.5;
/** A lane whose gold at 10:00 is below this share of the enemies' was lost. */
const LANE_LOST_SHARE = 0.85;
/** A teammate offline at least this long (but not flagged a leaver) is noted for everyone. */
const NOTABLE_DISCONNECT_SEC = 180;

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
  | { kind: 'team'; reason: 'behind-everywhere' | 'no-clear-culprit' | 'not-enough-data' };

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
  confidence: Confidence;
  keyFight: KeyFight | null;
}

/** Each area's share of what went wrong, as table points. */
export function categories(rating: PlayerRating, sign: 1 | -1): Array<Scored<AreaKey>> {
  return rating.areas
    .filter((a) => a.roleWeight > 0)
    .map((a) => ({
      key: a.key,
      points: round1(a.weight * Math.max(0, sign * (a.value ?? 0))),
      max: round1(a.weight),
      outOfTen: round1(10 * Math.max(0, sign * (a.value ?? 0))),
      available: a.weight > 0,
      evidence: (sign === 1 ? a.good : a.bad).map((f) => f.text),
    }));
}

export function computeBlame(match: OdMatch, heroes: Map<number, HeroInfo>, ourTeamIsRadiant: boolean, ref?: ReferenceData): BlameReport {
  const { context, players: ratings, draft, confidence, keyFight } = rateTeam(match, heroes, ourTeamIsRadiant, ref);
  const anyLeaver = ratings.some((r) => r.leaver);
  const minutesAway = (r: PlayerRating) => Math.round((context.disconnectedSec.get(r.slot) ?? 0) / 60);
  const disconnected = ratings.filter((r) => !r.leaver && (context.disconnectedSec.get(r.slot) ?? 0) >= NOTABLE_DISCONNECT_SEC);

  const players: PlayerBlame[] = ratings.map((r) => {
    const mitigations = [...r.notes];
    if (!r.leaver && anyLeaver) mitigations.push('грав без лівера');
    for (const d of disconnected) mitigations.push(d === r ? `відключався на ${minutesAway(d)} хв` : `грав без ${d.hero} ${minutesAway(d)} хв`);
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
    verdict: decideVerdict(players, context, confidence),
    draft,
    confidence,
    keyFight,
  };
}

/** Players sorted by score, highest first. */
export function decideVerdict(players: Array<Pick<PlayerBlame, 'slot' | 'score' | 'leaver'>>, context: MatchContext, confidence: Confidence): Verdict {
  const leaver = players.find((p) => p.leaver);
  if (leaver) return { kind: 'culprit', slot: leaver.slot };
  if (confidence.level === 'low') return { kind: 'team', reason: 'not-enough-data' };
  if (lostEveryLane(context)) return { kind: 'team', reason: 'behind-everywhere' };

  const [first, second] = players;
  if (first && first.score >= CULPRIT_MIN_SCORE && first.score - (second?.score ?? 0) >= CULPRIT_MIN_GAP) {
    return { kind: 'culprit', slot: first.slot };
  }
  return { kind: 'team', reason: 'no-clear-culprit' };
}

/** Every lane that can be compared (at least two) was lost at 10:00, against the enemies who stood in it. */
export function lostEveryLane(context: MatchContext): boolean {
  const byLane = new Map<number, boolean>();
  for (const p of context.ours) {
    const lane = mapLane(p);
    const m = context.lanes.get(p.player_slot);
    if (lane === null || !m?.gold || byLane.has(lane)) continue;
    byLane.set(lane, m.gold[0] < m.gold[1] * LANE_LOST_SHARE);
  }
  return byLane.size >= 2 && [...byLane.values()].every(Boolean);
}

/** Which team "we" were on: by account id (from GSI), else by hero id. */
export function findOurTeam(match: OdMatch, { accountId, heroId }: { accountId?: number | null; heroId?: number | null }): boolean | null {
  const byAccount = accountId ? match.players.find((p) => p.account_id === accountId) : undefined;
  if (byAccount) return byAccount.isRadiant;
  const byHero = heroId ? match.players.find((p) => p.hero_id === heroId) : undefined;
  return byHero ? byHero.isRadiant : null;
}
