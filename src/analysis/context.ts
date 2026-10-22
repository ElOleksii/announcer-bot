import type { OdMatch, OdPlayer } from './opendota.js';
import { LANE_MINUTE, THROW_DROP, assignPositions, laneMatchup, num, sum, swingMinutes, type LaneMatchup } from './scoring.js';

/**
 * What the scoring needs to know about a match beyond each player's totals, worked out once and
 * from one team's point of view ("ours"): who stood where, how every teamfight went and who was in
 * it, and what kind of death each of our deaths was.
 */

export type GameMode = 'ranked-all-pick' | 'turbo' | 'other';

/** A fight whose gold swing is smaller than this either way was even. */
export const FIGHT_EVEN_GOLD = 500;

export interface FightPlayer {
  slot: number;
  /** Dealt hero damage, died or got a kill. Healing alone does not count: it is mostly regeneration. */
  present: boolean;
  /** Alive when the fight started, so missing it was not because of the tavern. */
  aliveAtStart: boolean;
  deaths: number;
  damage: number;
  goldDelta: number;
  buybacks: number;
  /** Items used in the fight, by item key (e.g. black_king_bar). */
  itemUses: Record<string, number>;
}

export interface Fight {
  start: number;
  end: number;
  /** Gold our team gained in the fight minus what theirs gained. */
  goldSwing: number;
  outcome: 'won' | 'lost' | 'even';
  ourDeaths: number;
  theirDeaths: number;
  /** Our first player to die in the fight, if any of ours died. */
  firstOurDeath: number | null;
  /** Both teams, by player slot. */
  players: Map<number, FightPlayer>;
}

export interface Death {
  slot: number;
  time: number;
  /** Unit key of the killer, e.g. "npc_dota_hero_pudge". */
  killer: string | null;
  goldFed: number;
  /** Unspent gold lost on this death. */
  goldLost: number;
  timeDead: number;
  /** In a teamfight, or a pickoff outside of one. */
  kind: 'fight' | 'pickoff';
  /** Index into MatchContext.fights; null for a pickoff. */
  fight: number | null;
  /** The first of our team to die in a fight we lost. */
  firstInLostFight: boolean;
  /** While our gold lead dropped by THROW_DROP or more within two minutes. */
  duringThrow: boolean;
}

export interface MatchContext {
  ourTeamIsRadiant: boolean;
  won: boolean | null;
  /** Game length in seconds. */
  duration: number;
  mode: GameMode;
  /** OpenDota parsed the replay: fights, logs and per-minute data exist. */
  parsed: boolean;
  /** The team gold lead per minute is known (throws and surges can be found). */
  hasGoldGraph: boolean;
  /** 1 Herald … 8 Immortal, from the average rank of players who show one; null when nobody does. */
  bracket: number | null;
  ours: OdPlayer[];
  theirs: OdPlayer[];
  /** Positions 1–5 of both teams, by player slot. */
  positions: Map<number, number>;
  /** Our players' lane at LANE_MINUTE, by slot; null for roamers and junglers. */
  lanes: Map<number, LaneMatchup | null>;
  fights: Fight[];
  /** Our players' deaths, in time order. */
  deaths: Death[];
}

export function gameMode(match: OdMatch): GameMode {
  if (match.game_mode === 23) return 'turbo';
  return match.lobby_type === 7 && match.game_mode === 22 ? 'ranked-all-pick' : 'other';
}

/** rank_tier is medal × 10 + stars (54 = Legend 4); the bracket is the medal of the average. */
export function rankBracket(players: OdPlayer[]): number | null {
  const ranks = players.map((p) => num(p.rank_tier)).filter((r): r is number => r !== null && r > 0);
  if (ranks.length === 0) return null;
  return Math.min(8, Math.max(1, Math.floor(sum(ranks) / ranks.length / 10)));
}

/** Dead at `time`: died before it and still waiting to respawn. */
function deadAt(p: OdPlayer, time: number): boolean {
  return (p.deaths_log ?? []).some((d) => d.time < time && d.time + (d.time_dead ?? 0) > time);
}

export function buildContext(match: OdMatch, ourTeamIsRadiant: boolean): MatchContext {
  const ours = match.players.filter((p) => p.isRadiant === ourTeamIsRadiant);
  const theirs = match.players.filter((p) => p.isRadiant !== ourTeamIsRadiant);
  const isOurs = (p: OdPlayer) => p.isRadiant === ourTeamIsRadiant;
  const positions = new Map([...assignPositions(ours), ...assignPositions(theirs)]);
  const lanes = new Map(ours.map((p) => [p.player_slot, laneMatchup(p, ours, theirs, LANE_MINUTE)]));

  // Teamfight players are listed in the same order as match.players.
  const fights: Fight[] = (match.teamfights ?? []).map((tf) => {
    const players = new Map<number, FightPlayer>();
    let goldSwing = 0;
    let ourDeaths = 0;
    let theirDeaths = 0;
    match.players.forEach((p, i) => {
      const tp = tf.players[i];
      if (!tp) return;
      const deaths = tp.deaths ?? 0;
      const goldDelta = tp.gold_delta ?? 0;
      players.set(p.player_slot, {
        slot: p.player_slot,
        present: (tp.damage ?? 0) > 0 || deaths > 0 || Object.keys(tp.killed ?? {}).length > 0,
        aliveAtStart: !deadAt(p, tf.start),
        deaths,
        damage: tp.damage ?? 0,
        goldDelta,
        buybacks: tp.buybacks ?? 0,
        itemUses: tp.item_uses ?? {},
      });
      goldSwing += isOurs(p) ? goldDelta : -goldDelta;
      if (isOurs(p)) ourDeaths += deaths;
      else theirDeaths += deaths;
    });
    const firstDeath = ours
      .flatMap((p) => (p.deaths_log ?? []).filter((d) => d.time >= tf.start && d.time <= tf.end).map((d) => ({ slot: p.player_slot, time: d.time })))
      .sort((a, b) => a.time - b.time)[0];
    return {
      start: tf.start,
      end: tf.end,
      goldSwing,
      outcome: goldSwing >= FIGHT_EVEN_GOLD ? 'won' : goldSwing <= -FIGHT_EVEN_GOLD ? 'lost' : 'even',
      ourDeaths,
      theirDeaths,
      firstOurDeath: firstDeath?.slot ?? null,
      players,
    };
  });

  const throwMinutes = swingMinutes(match, ourTeamIsRadiant, -THROW_DROP);
  const deaths: Death[] = ours
    .flatMap((p) =>
      (p.deaths_log ?? []).map((d): Death => {
        const fightIndex = fights.findIndex((f) => d.time >= f.start && d.time <= f.end);
        const fight = fightIndex >= 0 ? fights[fightIndex]! : null;
        return {
          slot: p.player_slot,
          time: d.time,
          killer: d.key ?? null,
          goldFed: d.gold_fed ?? 0,
          goldLost: d.gold_lost ?? 0,
          timeDead: d.time_dead ?? 0,
          kind: fight ? 'fight' : 'pickoff',
          fight: fight ? fightIndex : null,
          firstInLostFight: !!fight && fight.outcome === 'lost' && fight.firstOurDeath === p.player_slot && isFirstDeathOf(p, fight, d.time),
          duringThrow: throwMinutes.some((t) => d.time >= (t - 2) * 60 && d.time <= t * 60),
        };
      }),
    )
    .sort((a, b) => a.time - b.time);

  return {
    ourTeamIsRadiant,
    won: match.radiant_win == null ? null : match.radiant_win === ourTeamIsRadiant,
    duration: match.duration,
    mode: gameMode(match),
    parsed: match.version != null,
    hasGoldGraph: match.radiant_gold_adv != null,
    bracket: rankBracket(match.players),
    ours,
    theirs,
    positions,
    lanes,
    fights,
    deaths,
  };
}

/** The player may die twice in one fight (after a buyback); only the earlier death opened it. */
function isFirstDeathOf(p: OdPlayer, fight: Fight, time: number): boolean {
  const inFight = (p.deaths_log ?? []).filter((d) => d.time >= fight.start && d.time <= fight.end).map((d) => d.time);
  return time === Math.min(...inFight);
}
