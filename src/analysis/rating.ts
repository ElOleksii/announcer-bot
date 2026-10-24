import { farm } from './areas/farm.js';
import { fights } from './areas/fights.js';
import { items } from './areas/items.js';
import { lane } from './areas/lane.js';
import { objectives } from './areas/objectives.js';
import { pick } from './areas/pick.js';
import { support } from './areas/support.js';
import { survival } from './areas/survival.js';
import { AREA_KEYS, type AreaKey, type AreaScore, type Fact, type RatingInput } from './areas/common.js';
import { confidence, type Confidence } from './confidence.js';
import { buildContext, type MatchContext } from './context.js';
import { draftOutlook, type DraftOutlook } from './draft.js';
import { keyFight, type KeyFight } from './keyfight.js';
import type { HeroInfo, OdMatch, OdPlayer } from './opendota.js';
import { NO_REFERENCE, type ReferenceData } from './reference.js';
import { isLeaver, num, round1, sum, swingMinutes } from './scoring.js';

/**
 * One rating for wins and losses alike. Every player is rated in eight areas (−1…+1, 0 = as
 * expected); their role decides how much each area weighs. A loss is explained by what went wrong
 * (blame), a win by what went right (contribution), each partly offset by the other: the same
 * numbers and thresholds either way.
 */

/**
 * How much each area weighs per position (1–5); areas without data drop out and the rest scale to
 * 100. Checked on 132 ranked All Pick matches (npm run fit-weights): items showed almost no link to
 * winning except for pos4 (10 → 7 elsewhere), fights none for supports (pos4 25 → 21, pos5 18 → 15),
 * and survival a clear link at every position, so it gets the freed points.
 */
export const ROLE_WEIGHTS: Record<number, Record<AreaKey, number>> = {
  1: { lane: 15, farm: 25, fights: 18, survival: 18, objectives: 12, support: 0, items: 7, pick: 5 },
  2: { lane: 18, farm: 18, fights: 22, survival: 17, objectives: 10, support: 3, items: 7, pick: 5 },
  3: { lane: 15, farm: 10, fights: 25, survival: 11, objectives: 12, support: 15, items: 7, pick: 5 },
  4: { lane: 12, farm: 3, fights: 21, survival: 16, objectives: 3, support: 30, items: 10, pick: 5 },
  5: { lane: 12, farm: 0, fights: 15, survival: 18, objectives: 5, support: 38, items: 7, pick: 5 },
};

export const AREA_LABELS: Record<AreaKey, string> = {
  lane: 'лайн',
  farm: 'фарм',
  fights: 'бійки',
  survival: 'виживання',
  objectives: 'об’єкти',
  support: 'підтримка',
  items: 'предмети',
  pick: 'пік',
};

/**
 * What went right offsets what went wrong at this rate in a loss, and the reverse in a win. Small
 * enough that feeding is not cancelled out by good work elsewhere; calibration barely moves with it.
 */
export const OFFSET = 0.3;
/** A jump of our gold lead this big within two minutes is a surge. */
export const SURGE_GAIN = 5000;

export interface RatedArea extends AreaScore {
  /** Points of the 0–100 score this area can move for this player; 0 when it does not apply or lacks data. */
  weight: number;
  /** The role weight before scaling; 0 when the area does not apply to the position. */
  roleWeight: number;
}

export interface PlayerRating {
  slot: number;
  hero: string;
  position: number;
  leaver: boolean;
  areas: RatedArea[];
  /** 0–100: what went wrong, minus OFFSET × what went right. */
  blame: number;
  /** 0–100: what went right, minus OFFSET × what went wrong. */
  contribution: number;
  /** Facts in the player's favour and against them, strongest first, across all areas. */
  good: string[];
  bad: string[];
  /** Context such as "alone against two in lane". */
  notes: string[];
}

export interface TeamRating {
  context: MatchContext;
  players: PlayerRating[];
  /** Context only: never part of anyone's score. */
  draft: DraftOutlook | null;
  /** How much of the rating had data. */
  confidence: Confidence;
  /** The fight that swung the game most towards its result; context only. */
  keyFight: KeyFight | null;
  opponentOf(p: OdPlayer): OdPlayer | null;
}

const AREAS: Record<AreaKey, (p: OdPlayer, input: RatingInput) => AreaScore> = { lane, farm, fights, survival, objectives, support, items, pick };

export function rateTeam(match: OdMatch, heroes: Map<number, HeroInfo>, ourTeamIsRadiant: boolean, ref: ReferenceData = NO_REFERENCE): TeamRating {
  const context = buildContext(match, ourTeamIsRadiant);
  const position = (p: OdPlayer) => context.positions.get(p.player_slot) ?? 5;
  const opponentOf = (p: OdPlayer) => context.theirs.find((e) => position(e) === position(p)) ?? null;
  const input: RatingInput = {
    ctx: context,
    ref,
    position,
    opponent: opponentOf,
    heroName: (p) => heroes.get(p.hero_id)?.localized_name ?? `hero ${p.hero_id}`,
    teamTotal: (stat) => sum(context.ours.map((p) => num(stat(p)) ?? 0)),
    surges: swingMinutes(match, ourTeamIsRadiant, SURGE_GAIN),
  };
  const players = context.ours.map((p) => ratePlayer(p, input));
  return {
    context,
    players,
    opponentOf,
    draft: draftOutlook(context, ref),
    confidence: confidence(players, context.parsed),
    keyFight: keyFight(context, input.heroName),
  };
}

function ratePlayer(p: OdPlayer, input: RatingInput): PlayerRating {
  const pos = input.position(p);
  const roleWeights = ROLE_WEIGHTS[pos]!;
  const scores = AREA_KEYS.map((key) => AREAS[key](p, input));
  const total = sum(scores.filter((a) => a.value !== null).map((a) => roleWeights[a.key]));
  const areas: RatedArea[] = scores.map((a) => ({
    ...a,
    roleWeight: roleWeights[a.key],
    weight: a.value === null || total === 0 ? 0 : (100 * roleWeights[a.key]) / total,
  }));
  const negative = sum(areas.map((a) => a.weight * Math.max(0, -(a.value ?? 0))));
  const positive = sum(areas.map((a) => a.weight * Math.max(0, a.value ?? 0)));
  const ranked = (pick: (a: RatedArea) => Fact[]) =>
    [...new Set(areas.flatMap((a) => pick(a).map((f) => ({ text: f.text, weight: f.weight * a.weight }))).sort((x, y) => y.weight - x.weight).map((f) => f.text))];
  return {
    slot: p.player_slot,
    hero: input.heroName(p),
    position: pos,
    leaver: isLeaver(p),
    areas,
    blame: round1(clamp(negative - OFFSET * positive)),
    contribution: round1(clamp(positive - OFFSET * negative)),
    good: ranked((a) => (a.weight > 0 ? a.good : [])),
    bad: ranked((a) => (a.weight > 0 ? a.bad : [])),
    notes: areas.flatMap((a) => a.notes),
  };
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));
