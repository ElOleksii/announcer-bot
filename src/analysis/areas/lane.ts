import type { OdPlayer } from '../opendota.js';
import { laneFact } from '../scoring.js';
import { scoreArea, versus, type AreaScore, type RatingInput } from './common.js';

/** Lane at 10 minutes: our side of the map lane against the enemies who actually stood in it. */
export function lane(p: OdPlayer, input: RatingInput): AreaScore {
  const m = input.ctx.lanes.get(p.player_slot) ?? null;
  // Uneven lanes are not compared at all; say why for the one who stood alone.
  const notes = input.position(p) !== 2 && m && m.allies.length === 1 && m.enemies.length >= 2 ? ['стояв сам проти двох на лайні'] : [];
  const gold = m?.gold ? laneFact(m, m.gold, 'золота', input.heroName) : undefined;
  const xp = m?.xp ? laneFact(m, m.xp, 'досвіду', input.heroName) : undefined;
  return scoreArea(
    'lane',
    [
      { weight: 0.6, value: m?.gold ? versus(m.gold[0], m.gold[1], 0.1, 0.5) : null, good: gold, bad: gold },
      { weight: 0.4, value: m?.xp ? versus(m.xp[0], m.xp[1], 0.1, 0.5) : null, good: xp, bad: xp },
    ],
    notes,
  );
}
