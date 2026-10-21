import type { HeroInfo, OdMatch, OdPlayer } from './opendota.js';
import {
  DEATHS,
  KILLS,
  LANE_MINUTE,
  avg,
  isLeaver,
  laneFact,
  laneMatchup,
  mmss,
  notApplicable,
  roleScale,
  num,
  pct,
  plural,
  ramp,
  round1,
  scoreCategory,
  sum,
  swingMinutes,
  teams,
  wardCount,
  type CategoryScore,
  type Part,
} from './scoring.js';

/**
 * Deterministic "who won us the game" scoring, the mirror of the blame rules:
 * - everyone is judged against their role (position 1–5) and their direct opponent;
 * - six contribution categories add up to at most 100 points;
 * - many deaths reduce the score, a leaver gets nothing;
 * - MVP is the top score; within 5 points of each other it is shared.
 * The AI only phrases the result.
 */

export type MvpCategoryKey = 'fights' | 'lane' | 'farm' | 'contribution' | 'closing' | 'surge';

export const MVP_CATEGORY_MAX: Record<MvpCategoryKey, number> = {
  fights: 25,
  lane: 15,
  farm: 20,
  contribution: 20,
  closing: 10,
  surge: 10,
};

export const MVP_CATEGORY_LABELS: Record<MvpCategoryKey, string> = {
  fights: 'бійки',
  lane: 'лайн',
  farm: 'фарм',
  contribution: 'внесок',
  closing: 'кінець гри',
  surge: 'ривок',
};

/** Two players within this many points share the MVP title. */
export const MVP_SHARE_GAP = 5;
const SUPPORT_LANE_FACTOR = 0.5;
const MANY_DEATHS_FACTOR = 0.8;
const SURGE_GAIN = 5000;

export interface PlayerContribution {
  slot: number;
  hero: string;
  position: number;
  /** Sum of categories, rescaled to 0–100 for the role (see roleScale), before modifiers. */
  raw: number;
  /** Final score 0–100. */
  score: number;
  categories: Array<CategoryScore<MvpCategoryKey>>;
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
  const { ours, theirs, ourPos, opponentOf } = teams(match, ourTeamIsRadiant);
  const heroName = (p: OdPlayer) => heroes.get(p.hero_id)?.localized_name ?? `hero ${p.hero_id}`;
  const duration = match.duration;

  const teamKills = sum(ours.map((p) => p.kills));
  const avgDeaths = avg(ours.map((p) => p.deaths));
  const teamHeroDamage = sum(ours.map((p) => num(p.hero_damage) ?? 0));
  const teamTowerDamage = sum(ours.map((p) => num(p.tower_damage) ?? 0));
  const surges = swingMinutes(match, ourTeamIsRadiant, SURGE_GAIN);
  const hasGoldGraph = match.radiant_gold_adv != null;

  const players: PlayerContribution[] = ours.map((p) => {
    const position = ourPos.get(p.player_slot) ?? 5;
    const support = position >= 4;
    const opp = opponentOf(p);
    const oppName = opp ? heroName(opp) : 'суперника';
    const killsLog = p.kills_log ?? null;
    const deathsLog = p.deaths_log ?? null;
    const modifiers: string[] = [];

    // Fights: share of the team's kills, and staying alive.
    const kp = teamKills > 0 ? (p.kills + p.assists) / teamKills : null;
    const fights = cat('fights', [
      {
        weight: 0.6,
        value: kp === null ? null : ramp(kp, 0.4, 0.8),
        evidence: `участь у ${kp === null ? '?' : pct(kp)}% кілів команди (${p.kills}/${p.deaths}/${p.assists})`,
      },
      {
        weight: 0.4,
        value: ramp(avgDeaths - p.deaths, 0, 4),
        evidence: `лише ${plural(p.deaths, DEATHS)} при середньому ${avgDeaths.toFixed(1)} по команді`,
      },
    ]);

    // Lane at 10 minutes: our side of the lane ahead of the enemies who actually stood in it.
    const matchup = laneMatchup(p, ours, theirs, LANE_MINUTE);
    const ahead = (t: [number, number] | null | undefined) => (t ? ramp((t[0] - t[1]) / Math.max(t[1], 1), 0.1, 0.5) : null);
    const lane = cat(
      'lane',
      [
        { weight: 0.6, value: ahead(matchup?.gold), evidence: matchup?.gold ? laneFact(matchup, matchup.gold, 'золота', heroName) : '' },
        { weight: 0.4, value: ahead(matchup?.xp), evidence: matchup?.xp ? laneFact(matchup, matchup.xp, 'досвіду', heroName) : '' },
      ],
      support ? SUPPORT_LANE_FACTOR : 1,
    );

    // Farm (cores only), ahead of the direct opponent.
    const farm = support
      ? notApplicable('farm', MVP_CATEGORY_MAX.farm)
      : cat('farm', [
          {
            weight: 0.6,
            value: opp ? ramp((p.gold_per_min - opp.gold_per_min) / Math.max(opp.gold_per_min, 1), 0.1, 0.45) : null,
            evidence: `GPM ${p.gold_per_min} проти ${opp?.gold_per_min} у ${oppName}`,
          },
          {
            weight: 0.4,
            value: opp ? ramp((p.xp_per_min - opp.xp_per_min) / Math.max(opp.xp_per_min, 1), 0.1, 0.45) : null,
            evidence: `XPM ${p.xp_per_min} проти ${opp?.xp_per_min} у ${oppName}`,
          },
        ]);

    // Contribution: damage and fights for cores; fights, vision and control for supports.
    const tp = num(p.teamfight_participation);
    const tpPart: Part = {
      weight: 0.4,
      value: tp === null ? null : ramp(tp, 0.55, 0.85),
      evidence: `участь у файтах ${tp === null ? '?' : pct(tp)}%`,
    };
    let contribution: CategoryScore<MvpCategoryKey>;
    if (!support) {
      const dmg = num(p.hero_damage);
      const tower = num(p.tower_damage);
      const dmgShare = dmg === null || teamHeroDamage === 0 ? null : dmg / teamHeroDamage;
      const towerShare = tower === null || teamTowerDamage === 0 ? null : tower / teamTowerDamage;
      contribution = cat('contribution', [
        tpPart,
        {
          weight: 0.4,
          value: dmgShare === null ? null : ramp(dmgShare, 0.2, 0.32),
          evidence: `${dmgShare === null ? '?' : pct(dmgShare)}% урону команди по героях`,
        },
        {
          weight: 0.2,
          value: towerShare === null ? null : ramp(towerShare, 0.15, 0.35),
          evidence: `${towerShare === null ? '?' : pct(towerShare)}% урону команди по будівлях`,
        },
      ]);
    } else {
      const wards = wardCount(p);
      const oppWards = opp ? wardCount(opp) : null;
      const stuns = num(p.stuns);
      const oppStuns = opp ? num(opp.stuns) : null;
      contribution = cat('contribution', [
        tpPart,
        {
          weight: 0.4,
          value: wards === null || oppWards === null ? null : ramp((wards - oppWards) / Math.max(oppWards, 1), 0.2, 0.7),
          evidence: `${plural(wards ?? 0, ['вард', 'варди', 'вардів'])} проти ${oppWards} у ${oppName}`,
        },
        {
          weight: 0.2,
          value: stuns === null || oppStuns === null ? null : ramp((stuns - oppStuns) / Math.max(oppStuns, 1), 0.3, 0.8),
          evidence: `${Math.round(stuns ?? 0)} с стану проти ${Math.round(oppStuns ?? 0)} у ${oppName}`,
        },
      ]);
    }

    // Closing the game: kills in the last 3 minutes, and not dying there.
    let closing: CategoryScore<MvpCategoryKey>;
    if (killsLog && deathsLog) {
      const lateKills = killsLog.filter((k) => k.time >= duration - 180).length;
      const lateDeaths = deathsLog.filter((d) => d.time >= duration - 180).length;
      closing = cat('closing', [
        { weight: 0.5, value: ramp(lateKills, 0, 3), evidence: `${plural(lateKills, KILLS)} за останні 3 хвилини` },
        { weight: 0.5, value: lateDeaths === 0 ? 1 : 0, evidence: `${plural(0, DEATHS)} за останні 3 хвилини` },
      ]);
    } else {
      closing = cat('closing', []);
    }

    // Surge: kills while the team's lead jumped by SURGE_GAIN+ gold in 2 minutes.
    let surge: CategoryScore<MvpCategoryKey>;
    if (killsLog && hasGoldGraph) {
      const surgeKills = killsLog.filter((k) => surges.some((t) => k.time >= (t - 2) * 60 && k.time <= t * 60));
      const first = surgeKills[0];
      surge = cat('surge', [
        {
          weight: 1,
          value: ramp(surgeKills.length, 0, 3),
          evidence: first ? `${plural(surgeKills.length, KILLS)} під час ривку команди (перший на ${mmss(first.time)})` : '',
        },
      ]);
    } else {
      surge = cat('surge', []);
    }

    const categories = [fights, lane, farm, contribution, closing, surge];
    const raw = round1(sum(categories.map((c) => c.points)) * roleScale(categories));

    const leaver = isLeaver(p);
    let factor = 1;
    if (!leaver && p.deaths >= 6 && p.deaths >= avgDeaths * 1.5) {
      factor *= MANY_DEATHS_FACTOR;
      modifiers.push(`багато смертей (${p.deaths})`);
    }
    const score = leaver ? 0 : Math.round(Math.min(100, raw * factor));

    const evidence = [...categories]
      .sort((a, b) => b.points - a.points)
      .flatMap((c) => c.evidence)
      .filter(Boolean)
      .slice(0, 3);

    return { slot: p.player_slot, hero: heroName(p), position, raw, score, categories, modifiers, evidence, leaver };
  });

  players.sort((a, b) => b.score - a.score || b.raw - a.raw);
  const [first, second] = players;
  const mvpSlots = first ? [first.slot] : [];
  if (first && second && !second.leaver && first.score - second.score < MVP_SHARE_GAP) mvpSlots.push(second.slot);

  return {
    matchId: match.match_id,
    durationSec: duration,
    ourTeam: ourTeamIsRadiant ? 'radiant' : 'dire',
    parsed: match.version != null,
    players,
    mvpSlots,
  };
}

function cat(key: MvpCategoryKey, parts: Part[], factor = 1): CategoryScore<MvpCategoryKey> {
  return scoreCategory(key, MVP_CATEGORY_MAX[key], parts, factor);
}
