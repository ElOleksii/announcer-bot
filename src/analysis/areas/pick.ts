import type { OdPlayer } from '../opendota.js';
import { heroWinRate } from '../reference.js';
import { plural } from '../scoring.js';
import { scoreArea, signedRamp, type AreaScore, type RatingInput } from './common.js';

/** Fewer games than this on the hero and the pick was close to a first try. */
const NEW_HERO_GAMES = 3;

const percent1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * The pick: how strong the hero is right now in this rank bracket, whether it suits the position
 * at all, and whether the player had played it before. A small area: drafts decide little in pub
 * games, and trying a new hero now and then is no crime, so only a near-first try counts against.
 */
export function pick(p: OdPlayer, input: RatingInput): AreaScore {
  const { ctx, ref } = input;
  const position = input.position(p);
  const hero = input.heroName(p);
  const stat = ref.heroStats?.get(p.hero_id);
  const winRate = heroWinRate(stat, ctx.mode, ctx.bracket);
  const roles = stat?.roles ?? null;
  // Only clear mismatches: 91% of pos1 heroes are tagged Carry, and nearly every pos4–5 hero Support or Disabler.
  const misfit =
    roles === null ? null : position === 1 ? !roles.includes('Carry') : position >= 4 ? !roles.includes('Support') && !roles.includes('Disabler') : null;
  const history = typeof p.account_id === 'number' ? ref.playerHeroes.get(p.account_id) : undefined;
  const games = history ? (history.find((h) => h.hero_id === p.hero_id)?.games ?? 0) : null;

  return scoreArea('pick', [
    {
      weight: 0.5,
      value: winRate === null ? null : signedRamp(winRate - 0.5, 0.01, 0.04),
      good: winRate === null ? undefined : `${hero} зараз сильний у цьому ранзі: ${percent1(winRate)} перемог`,
      bad: winRate === null ? undefined : `${hero} зараз слабкий у цьому ранзі: ${percent1(winRate)} перемог`,
    },
    {
      weight: 0.25,
      value: misfit === null ? null : misfit ? -0.6 : 0,
      bad: position === 1 ? `${hero} не керрі, а грав на позиції 1` : `${hero} не саппорт і без контролю, а грав на позиції ${position}`,
    },
    {
      weight: 0.25,
      value: games === null ? null : games < NEW_HERO_GAMES ? -0.6 : 0,
      bad: `лише ${plural(games ?? 0, ['гра', 'гри', 'ігор'])} на цьому героєві за всю історію`,
    },
  ]);
}
