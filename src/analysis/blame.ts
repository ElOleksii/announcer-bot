import type { HeroInfo, OdMatch, OdPlayer } from './opendota.js';
import {
  DEATHS,
  DEWARDS,
  LANE_MINUTE,
  THROW_DROP,
  WARDS,
  assignPositions,
  at,
  avg,
  benchmarkPct,
  dewardCount,
  isLeaver,
  laneFact,
  laneMatchup,
  mmss,
  num,
  pct,
  plural,
  ramp,
  round1,
  scoreCategory,
  sum,
  wardCount,
  type CategoryScore as Scored,
  type Part,
} from './scoring.js';

export { assignPositions, isLeaver, plural, ramp } from './scoring.js';

/**
 * Deterministic "who lost us the game" scoring. The rules (agreed with the user):
 * - everyone is judged against their role (position 1–5) and their direct opponent;
 * - six penalty categories add up to at most 100 points; cores are judged on farm, supports on
 *   support work (wards, dewards) instead, so neither role starts with a 20-point head start;
 * - mitigations reduce the score (carried the game, solo vs two in lane, leaver on the team);
 * - a single culprit only with ≥ 45 points and a 10-point lead, otherwise the whole team.
 * The AI only phrases the result; it never decides who is to blame.
 */

/** `farm` applies to positions 1–3, `support` to 4–5: each player gets six categories. */
export type CategoryKey = 'feed' | 'lane' | 'farm' | 'support' | 'contribution' | 'endgame' | 'throw';

export const CATEGORY_MAX: Record<CategoryKey, number> = {
  feed: 25,
  lane: 15,
  farm: 20,
  support: 20,
  contribution: 20,
  endgame: 10,
  throw: 10,
};

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  feed: 'фід',
  lane: 'лайн',
  farm: 'фарм',
  support: 'підтримка',
  contribution: 'внесок',
  endgame: 'кінець гри',
  throw: 'троу',
};

export const CULPRIT_MIN_SCORE = 45;
export const CULPRIT_MIN_GAP = 10;
const SUPPORT_DEATH_FACTOR = 0.6;
const SUPPORT_LANE_FACTOR = 0.5;
const CARRY_MITIGATION = 0.7;
const LEAVER_MITIGATION = 0.5;

export type CategoryScore = Scored<CategoryKey>;

export interface PlayerBlame {
  slot: number;
  hero: string;
  position: number;
  /** Sum of categories before mitigations. */
  raw: number;
  /** Final score 0–100. */
  score: number;
  categories: CategoryScore[];
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
  /** true when OpenDota parsed the replay; otherwise several categories are unavailable. */
  parsed: boolean;
  /** Our players, highest score first. */
  players: PlayerBlame[];
  verdict: Verdict;
}

function category(key: CategoryKey, parts: Part[], factor = 1): CategoryScore {
  return scoreCategory(key, CATEGORY_MAX[key], parts, factor);
}

export function computeBlame(match: OdMatch, heroes: Map<number, HeroInfo>, ourTeamIsRadiant: boolean): BlameReport {
  const ours = match.players.filter((p) => p.isRadiant === ourTeamIsRadiant);
  const theirs = match.players.filter((p) => p.isRadiant !== ourTeamIsRadiant);
  const ourPos = assignPositions(ours);
  const theirPos = assignPositions(theirs);
  const heroName = (p: OdPlayer) => heroes.get(p.hero_id)?.localized_name ?? `hero ${p.hero_id}`;
  const opponentOf = (p: OdPlayer) => theirs.find((e) => theirPos.get(e.player_slot) === ourPos.get(p.player_slot)) ?? null;
  const parsed = match.version != null;
  const duration = match.duration;

  // Team-wide reference values.
  const avgDeaths = avg(ours.map((p) => p.deaths));
  const deadTimes = ours.map((p) => num(p.life_state_dead)).filter((x): x is number => x !== null);
  const avgDead = avg(deadTimes);
  const teamHeroDamage = sum(ours.map((p) => num(p.hero_damage) ?? 0));
  const teamTowerDamage = sum(ours.map((p) => num(p.tower_damage) ?? 0));
  const sign = ourTeamIsRadiant ? 1 : -1;
  const ourAdv = match.radiant_gold_adv?.map((g) => g * sign) ?? null;

  // Minutes (end of a 2-minute window) where our gold lead dropped by ≥ THROW_DROP.
  const throwMinutes: number[] = [];
  if (ourAdv) {
    for (let t = 2; t < ourAdv.length; t++) {
      if ((ourAdv[t - 2] ?? 0) - (ourAdv[t] ?? 0) >= THROW_DROP) throwMinutes.push(t);
    }
  }

  const leavers = ours.filter(isLeaver);
  const topDamageSlot = [...ours].sort((a, b) => (num(b.hero_damage) ?? 0) - (num(a.hero_damage) ?? 0))[0]?.player_slot;
  const topNetWorthSlot = [...ours].sort((a, b) => (num(b.net_worth) ?? 0) - (num(a.net_worth) ?? 0))[0]?.player_slot;

  const players: PlayerBlame[] = ours.map((p) => {
    const position = ourPos.get(p.player_slot) ?? 5;
    const support = position >= 4;
    const opp = opponentOf(p);
    const oppName = opp ? heroName(opp) : 'суперника';
    const deathsLog = p.deaths_log ?? null;
    const mitigations: string[] = [];

    // A. Feed
    const early = deathsLog ? deathsLog.filter((d) => d.time < 600).length : null;
    const goldFed = deathsLog ? sum(deathsLog.map((d) => d.gold_fed ?? 0)) : 0;
    const dead = num(p.life_state_dead);
    const feed = category(
      'feed',
      [
        {
          weight: 12,
          value: ramp(p.deaths - avgDeaths, 0, 6),
          evidence: `${plural(p.deaths, DEATHS)} при середньому ${avgDeaths.toFixed(1)} по команді${goldFed > 0 ? `, віддав ворогу ${goldFed} золота` : ''}`,
        },
        { weight: 8, value: early === null ? null : ramp(early, 1, 5), evidence: `${plural(early ?? 0, DEATHS)} до 10-ї хвилини` },
        {
          weight: 5,
          value: dead === null || avgDead === 0 ? null : ramp(dead / avgDead, 1, 2),
          evidence: dead === null ? '' : `${mmss(dead)} у таверні — найбільше в команді`,
        },
      ],
      support ? SUPPORT_DEATH_FACTOR : 1,
    );
    // The "longest in tavern" text is only true for the actual maximum.
    if (dead !== null && dead < Math.max(...deadTimes)) feed.evidence = feed.evidence.filter((e) => !e.includes('у таверні'));

    // B. Lane at 10 minutes: our side of the lane against the enemies who actually stood in it.
    const matchup = laneMatchup(p, ours, theirs, LANE_MINUTE);
    const behind = (t: [number, number] | null | undefined) => (t ? ramp((t[1] - t[0]) / Math.max(t[1], 1), 0.1, 0.5) : null);
    const lane = category(
      'lane',
      [
        { weight: 0.6, value: behind(matchup?.gold), evidence: matchup?.gold ? laneFact(matchup, matchup.gold, 'золота', heroName) : '' },
        { weight: 0.4, value: behind(matchup?.xp), evidence: matchup?.xp ? laneFact(matchup, matchup.xp, 'досвіду', heroName) : '' },
      ],
      support ? SUPPORT_LANE_FACTOR : 1,
    );
    // Uneven lanes are not compared at all; say why for the one who stood alone.
    if (position !== 2 && matchup && matchup.allies.length === 1 && matchup.enemies.length >= 2) {
      mitigations.push('стояв сам проти двох на лайні');
    }

    // C. Farm for cores; support work (vision) for supports, against the enemy on the same position.
    let farmOrSupport: CategoryScore;
    if (!support) {
      farmOrSupport = category('farm', [
        {
          weight: 0.6,
          value: opp ? ramp((opp.gold_per_min - p.gold_per_min) / Math.max(opp.gold_per_min, 1), 0.1, 0.45) : null,
          evidence: `GPM ${p.gold_per_min} проти ${opp?.gold_per_min} у ${oppName}`,
        },
        {
          weight: 0.4,
          value: opp ? ramp((opp.xp_per_min - p.xp_per_min) / Math.max(opp.xp_per_min, 1), 0.1, 0.45) : null,
          evidence: `XPM ${p.xp_per_min} проти ${opp?.xp_per_min} у ${oppName}`,
        },
      ]);
    } else {
      const wards = wardCount(p);
      const oppWards = opp ? wardCount(opp) : null;
      const dewards = dewardCount(p);
      const oppDewards = opp ? dewardCount(opp) : null;
      farmOrSupport = category('support', [
        {
          weight: 0.45,
          value: wards === null || oppWards === null ? null : ramp((oppWards - wards) / Math.max(oppWards, 1), 0.2, 0.7),
          evidence: `${plural(wards ?? 0, WARDS)} проти ${oppWards} у ${oppName}`,
        },
        {
          weight: 0.25,
          value: dewards === null || oppDewards === null ? null : ramp(oppDewards - dewards, 1, 4),
          evidence: `${plural(dewards ?? 0, DEWARDS)} проти ${oppDewards} у ${oppName}`,
        },
        // Levels, not gold: a support's gold goes into wards, and taking farm from cores is no merit.
        {
          weight: 0.3,
          value: opp ? ramp((opp.xp_per_min - p.xp_per_min) / Math.max(opp.xp_per_min, 1), 0.1, 0.45) : null,
          evidence: `XPM ${p.xp_per_min} проти ${opp?.xp_per_min} у ${oppName}`,
        },
      ]);
    }

    // D. Contribution
    const tp = num(p.teamfight_participation);
    const tpPart: Part = {
      weight: 0.4,
      value: tp === null ? null : ramp(0.55 - tp, 0, 0.35),
      evidence: `участь у файтах лише ${tp === null ? '?' : pct(tp)}%`,
    };
    let contribution: CategoryScore;
    if (!support) {
      const dmg = num(p.hero_damage);
      const tower = num(p.tower_damage);
      const dmgShare = dmg === null || teamHeroDamage === 0 ? null : dmg / teamHeroDamage;
      const towerShare = tower === null || teamTowerDamage === 0 ? null : tower / teamTowerDamage;
      contribution = category('contribution', [
        tpPart,
        {
          weight: 0.4,
          value: dmgShare === null ? null : ramp(0.18 - dmgShare, 0, 0.11),
          evidence: `лише ${dmgShare === null ? '?' : pct(dmgShare)}% урону команди по героях`,
        },
        {
          weight: 0.2,
          value: towerShare === null ? null : ramp(0.12 - towerShare, 0, 0.1),
          evidence: `лише ${towerShare === null ? '?' : pct(towerShare)}% урону команди по будівлях`,
        },
      ]);
    } else {
      // Hero damage against the same hero in other games: a support's damage share depends on the hero.
      const dmgPct = benchmarkPct(p, 'hero_damage_per_min');
      const stuns = num(p.stuns);
      const oppStuns = opp ? num(opp.stuns) : null;
      contribution = category('contribution', [
        tpPart,
        {
          weight: 0.3,
          value: dmgPct === null ? null : ramp(0.5 - dmgPct, 0, 0.35),
          evidence: `урон по героях кращий лише за ${pct(dmgPct ?? 0)}% ігор на цьому героєві`,
        },
        {
          weight: 0.3,
          value: stuns === null || oppStuns === null ? null : ramp((oppStuns - stuns) / Math.max(oppStuns, 1), 0.3, 0.8),
          evidence: `${Math.round(stuns ?? 0)} с стану проти ${Math.round(oppStuns ?? 0)} у ${oppName}`,
        },
      ]);
    }

    // E. End of the game
    let endgame: CategoryScore;
    if (deathsLog) {
      const lateDeaths = deathsLog.filter((d) => d.time >= duration - 180).length;
      const last = deathsLog.at(-1);
      const boughtBack = last ? (p.buyback_log ?? []).some((b) => b.time >= last.time) : false;
      const deadAtEnd = !!last && !boughtBack && last.time + (last.time_dead ?? 0) >= duration;
      endgame = category('endgame', [
        { weight: 0.5, value: ramp(lateDeaths, 0, 2), evidence: `${plural(lateDeaths, DEATHS)} за останні 3 хвилини` },
        {
          weight: 0.5,
          value: deadAtEnd ? 1 : 0,
          evidence: last ? `помер на ${mmss(last.time)} і був у таверні без байбеку, коли падав трон` : '',
        },
      ]);
    } else {
      endgame = category('endgame', []);
    }

    // F. Throw
    let throwCat: CategoryScore;
    if (deathsLog && ourAdv) {
      const throwDeaths = deathsLog.filter((d) => throwMinutes.some((t) => d.time >= (t - 2) * 60 && d.time <= t * 60));
      const first = throwDeaths[0];
      throwCat = category('throw', [
        {
          weight: 1,
          value: ramp(throwDeaths.length, 0, 3),
          evidence: first ? `${plural(throwDeaths.length, DEATHS)}, поки перевага обвалювалась (перша на ${mmss(first.time)})` : '',
        },
      ]);
    } else {
      throwCat = category('throw', []);
    }

    const categories = [feed, lane, farmOrSupport, contribution, endgame, throwCat];
    const raw = round1(sum(categories.map((c) => c.points)));

    let factor = 1;
    if (p.player_slot === topDamageSlot || p.player_slot === topNetWorthSlot) {
      factor *= CARRY_MITIGATION;
      mitigations.push(p.player_slot === topDamageSlot ? 'найбільший урон у команді' : 'найбільший нетворс у команді');
    }
    const leaver = isLeaver(p);
    if (!leaver && leavers.length > 0) {
      factor *= LEAVER_MITIGATION;
      mitigations.push('грав без лівера');
    }
    const score = leaver ? 100 : Math.round(Math.min(100, raw * factor));

    const evidence = [...categories]
      .sort((a, b) => b.points - a.points)
      .flatMap((c) => c.evidence)
      .filter(Boolean)
      .slice(0, 3);
    if (leaver) evidence.unshift('покинув гру');

    return { slot: p.player_slot, hero: heroName(p), position, raw, score, categories, mitigations, evidence, leaver };
  });

  players.sort((a, b) => b.score - a.score || b.raw - a.raw);

  const lost = match.radiant_win !== null && match.radiant_win !== ourTeamIsRadiant;
  return {
    matchId: match.match_id,
    durationSec: duration,
    ourTeam: ourTeamIsRadiant ? 'radiant' : 'dire',
    lost,
    parsed,
    players,
    verdict: decideVerdict(players, ours, opponentOf, ourPos),
  };
}

function decideVerdict(
  players: PlayerBlame[],
  ours: OdPlayer[],
  opponentOf: (p: OdPlayer) => OdPlayer | null,
  ourPos: Map<number, number>,
): Verdict {
  const leaver = players.find((p) => p.leaver);
  if (leaver) return { kind: 'culprit', slot: leaver.slot };

  // Every core behind its opponent by ≥ 15% net worth at 15 minutes → the whole team lost it.
  const cores = ours.filter((p) => (ourPos.get(p.player_slot) ?? 5) <= 3);
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
