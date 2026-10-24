import type { MatchContext } from './context.js';
import type { OdPlayer } from './opendota.js';

/** A fight smaller than this either way did not decide much. */
export const KEY_FIGHT_GOLD = 2000;

/** The fight that swung the game most towards its result. */
export interface KeyFight {
  start: number;
  /** Our gold gained minus theirs: negative in a loss, positive in a win. */
  goldSwing: number;
  ourDeaths: number;
  theirDeaths: number;
  /** Loss: our first player to fall. Win: our biggest damage dealer in the fight. */
  standout: { hero: string; damage: number } | null;
}

/** The most lost fight in a loss, the most won fight in a win; null when none moved KEY_FIGHT_GOLD. */
export function keyFight(ctx: MatchContext, heroName: (p: OdPlayer) => string): KeyFight | null {
  if (ctx.won === null || ctx.fights.length === 0) return null;
  const sign = ctx.won ? 1 : -1;
  const fight = [...ctx.fights].sort((a, b) => sign * (b.goldSwing - a.goldSwing))[0]!;
  if (sign * fight.goldSwing < KEY_FIGHT_GOLD) return null;
  const player = (slot: number | null | undefined) => ctx.ours.find((p) => p.player_slot === slot);
  let standout: KeyFight['standout'] = null;
  if (!ctx.won) {
    const first = player(fight.firstOurDeath);
    if (first) standout = { hero: heroName(first), damage: fight.players.get(first.player_slot)?.damage ?? 0 };
  } else {
    const top = ctx.ours.map((p) => fight.players.get(p.player_slot)!).sort((a, b) => b.damage - a.damage)[0];
    const p = player(top?.slot);
    if (p && top && top.damage > 0) standout = { hero: heroName(p), damage: top.damage };
  }
  return { start: fight.start, goldSwing: fight.goldSwing, ourDeaths: fight.ourDeaths, theirDeaths: fight.theirDeaths, standout };
}
