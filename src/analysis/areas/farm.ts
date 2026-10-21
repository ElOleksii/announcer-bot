import type { OdPlayer } from '../opendota.js';
import { benchmarkPct, num } from '../scoring.js';
import { ROLE_SHARE, benchmarkScore, heroPercentileFacts, scoreArea, shareFact, shareScore, versus, type AreaScore, type RatingInput } from './common.js';

/**
 * Farm: the share of the team's net worth against what the position usually gets (fair to every
 * teammate whatever the result), GPM against the enemy on the same position, and last hits
 * against the same hero in other games.
 */
export function farm(p: OdPlayer, input: RatingInput): AreaScore {
  const position = input.position(p);
  const opp = input.opponent(p);
  const teamNetWorth = input.teamTotal((x) => x.net_worth);
  const netWorth = num(p.net_worth);
  const share = netWorth === null || teamNetWorth === 0 ? null : netWorth / teamNetWorth;
  const typical = ROLE_SHARE.netWorth[position]!;
  const lastHits = benchmarkPct(p, 'last_hits_per_min');
  const gpm = opp ? `GPM ${p.gold_per_min} проти ${opp.gold_per_min} у ${input.heroName(opp)}` : undefined;
  const nw = shareFact(share, typical, 'нетворсу команди', position);
  return scoreArea('farm', [
    { weight: 0.45, value: shareScore(share, typical), good: nw, bad: nw },
    { weight: 0.25, value: opp ? versus(p.gold_per_min, opp.gold_per_min, 0.1, 0.45) : null, good: gpm, bad: gpm },
    { weight: 0.3, value: benchmarkScore(lastHits, 'last_hits_per_min'), ...heroPercentileFacts('добивання', lastHits) },
  ]);
}
