import type { OdPlayer } from '../opendota.js';
import { benchmarkPct, num } from '../scoring.js';
import { ROLE_SHARE, benchmarkScore, heroPercentileFacts, scoreArea, shareFact, signedRamp, type AreaScore, type RatingInput } from './common.js';

/** Below this the team barely hit buildings and shares are noise (a stomped team). */
const MIN_TEAM_TOWER_DAMAGE = 3000;

/**
 * Objectives: the share of the team's building damage against what the position usually does, and
 * building damage against the same hero in other games. Not judged at all when the team barely hit
 * buildings: then every teammate would score the same low value, which only repeats the result.
 */
export function objectives(p: OdPlayer, input: RatingInput): AreaScore {
  const position = input.position(p);
  const teamTower = input.teamTotal((x) => x.tower_damage);
  if (teamTower < MIN_TEAM_TOWER_DAMAGE) return scoreArea('objectives', []);
  const tower = num(p.tower_damage);
  const share = tower === null ? null : tower / teamTower;
  const typical = ROLE_SHARE.towerDamage[position]!;
  const towerPct = benchmarkPct(p, 'tower_damage');
  const fact = shareFact(share, typical, 'урону команди по будівлях', position);
  return scoreArea('objectives', [
    // Absolute difference: supports usually do ~3%, so relative differences would be noise.
    { weight: 0.6, value: share === null ? null : signedRamp(share - typical, 0.05, 0.2), good: fact, bad: fact },
    { weight: 0.4, value: benchmarkScore(towerPct, 'tower_damage'), ...heroPercentileFacts('урон по будівлях', towerPct) },
  ]);
}
