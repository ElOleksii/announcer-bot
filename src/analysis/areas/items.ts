import type { OdPlayer } from '../opendota.js';
import { num, plural, ramp } from '../scoring.js';
import { scoreArea, signedRamp, type AreaScore, type RatingInput } from './common.js';

/** Heroes that go invisible on their own: Riki, Clinkz, Bounty Hunter, Weaver, Nyx Assassin. */
const INVISIBLE_HEROES = new Set([32, 56, 62, 63, 88]);
const INVISIBILITY_ITEMS = new Set(['invis_sword', 'silver_edge', 'glimmer_cape']);
/**
 * Typical unspent gold lost per death, by position (index 1–5). It barely depends on the result
 * (winners lose as much per death); medians over 32 ranked All Pick matches.
 */
const GOLD_LOST_PER_DEATH = [0, 100, 145, 140, 73, 72];
/** Typical detection bought against invisible enemies (sentry = 1, dust = 2, gem = 4), positions 4–5. */
const DETECTION_VS_INVISIBLE = [0, 0, 0, 0, 5, 8];
const FIGHTS = ['файті', 'файтах', 'файтах'] as const;

/**
 * Items, as far as the data can show they were used well: BKB actually turned on in the fights
 * where its owner died, unspent gold carried into deaths, detection against invisible enemies
 * (supports), and enough gold for a buyback when the throne fell. Which items "should" have been
 * built has no ground truth in the data, so it is not judged.
 */
export function items(p: OdPlayer, input: RatingInput): AreaScore {
  const { ctx } = input;
  const position = input.position(p);
  const purchases = p.purchase_log ?? null;
  const bought = (key: string) => purchases?.filter((x) => x.key === key).length ?? 0;

  // BKB: fights after buying it where the player died without turning it on.
  const bkb = purchases?.find((x) => x.key === 'black_king_bar');
  const afterBkb = bkb && ctx.parsed ? ctx.fights.filter((f) => f.start >= bkb.time).map((f) => f.players.get(p.player_slot)!) : null;
  const bkbUsed = afterBkb?.filter((f) => (f.itemUses.black_king_bar ?? 0) > 0).length ?? 0;
  const diedWithout = afterBkb?.filter((f) => f.deaths > 0 && !(f.itemUses.black_king_bar ?? 0)).length ?? 0;

  const deaths = ctx.deaths.filter((d) => d.slot === p.player_slot);
  const goldLostPerDeath = ctx.parsed && deaths.length >= 2 ? Math.round(deaths.reduce((s, d) => s + d.goldLost, 0) / deaths.length) : null;
  const usualGoldLost = GOLD_LOST_PER_DEATH[position]!;

  const enemyInvisible = ctx.theirs.some((e) => INVISIBLE_HEROES.has(e.hero_id) || (e.purchase_log ?? []).some((x) => INVISIBILITY_ITEMS.has(x.key)));
  const detection = bought('ward_sentry') + 2 * bought('dust') + 4 * bought('gem');
  const usualDetection = DETECTION_VS_INVISIBLE[position]!;
  const detectionFact = `детект проти невидимих ворогів: ${bought('ward_sentry')} сентрі, ${bought('dust')} порошку${bought('gem') ? ', гем' : ''} (зазвичай ~${usualDetection} на позиції ${position}, сентрі = 1, порошок = 2)`;

  const last = p.deaths_log?.at(-1);
  const boughtBack = last ? (p.buyback_log ?? []).some((b) => b.time >= last.time) : false;
  const deadAtEnd = !!last && !boughtBack && last.time + (last.time_dead ?? 0) >= ctx.duration;
  const gold = num(p.gold);
  // Approximate buyback cost: 200 + net worth / 12.
  const couldBuyBack = gold !== null && gold >= 200 + (num(p.net_worth) ?? 0) / 12;

  return scoreArea('items', [
    {
      weight: 0.4,
      value: afterBkb === null ? null : diedWithout > 0 ? -ramp(diedWithout, 0, 2) : bkbUsed > 0 ? 0.3 : 0,
      good: `увімкнув BKB у ${plural(bkbUsed, FIGHTS)}`,
      bad: `помер у ${plural(diedWithout, FIGHTS)} з BKB, не увімкнувши його`,
    },
    {
      weight: 0.3,
      value: goldLostPerDeath === null ? null : -ramp((goldLostPerDeath - usualGoldLost) / usualGoldLost, 0.5, 2),
      bad: `у середньому втрачав ${goldLostPerDeath} незбереженого золота за смерть (зазвичай ~${usualGoldLost} на позиції ${position})`,
    },
    {
      weight: 0.2,
      value: position >= 4 && enemyInvisible && purchases ? signedRamp((detection - usualDetection) / usualDetection, 0.2, 0.8) : null,
      good: detectionFact,
      bad: detectionFact,
    },
    {
      weight: 0.1,
      // Only a loss ends with our throne falling.
      value: ctx.won === false && p.deaths_log ? (deadAtEnd && couldBuyBack ? -1 : 0) : null,
      bad: `помер наприкінці, маючи ${gold} золота, і не викупився`,
    },
  ]);
}
