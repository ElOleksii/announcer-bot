import type { OdPlayer } from '../opendota.js';
import { DEWARDS, WARDS, dewardCount, num, plural, wardCount } from '../scoring.js';
import { ROLE_SHARE, scoreArea, shareFact, shareScore, signedRamp, versus, type AreaScore, type RatingInput } from './common.js';

/**
 * Support work against the enemy on the same position (wards, dewards, stacks, stuns) and, for
 * supports, their share of the team's XPM against what the position usually gets. Levels, not
 * gold: a support's gold goes into wards, and taking farm from cores is no merit. A share, not the
 * enemy support's XPM: a winning team out-levels the other everywhere, so that only shows the result.
 */
export function support(p: OdPlayer, input: RatingInput): AreaScore {
  const opp = input.opponent(p);
  const oppName = opp ? input.heroName(opp) : 'суперника';
  const position = input.position(p);
  const isSupport = position >= 4;
  const teamXpm = input.teamTotal((x) => x.xp_per_min);
  const xpmShare = isSupport && teamXpm > 0 ? p.xp_per_min / teamXpm : null;
  const wards = wardCount(p);
  const oppWards = opp ? wardCount(opp) : null;
  const dewards = dewardCount(p);
  const oppDewards = opp ? dewardCount(opp) : null;
  const stacks = num(p.camps_stacked);
  const oppStacks = opp ? num(opp.camps_stacked) : null;
  const stuns = num(p.stuns);
  const oppStuns = opp ? num(opp.stuns) : null;
  const wardsFact = `${plural(wards ?? 0, WARDS)} проти ${oppWards} у ${oppName}`;
  const dewardsFact = `${plural(dewards ?? 0, DEWARDS)} проти ${oppDewards} у ${oppName}`;
  const stacksFact = `${plural(stacks ?? 0, ['стак', 'стаки', 'стаків'])} кемпів проти ${oppStacks} у ${oppName}`;
  const stunsFact = `${Math.round(stuns ?? 0)} с стану проти ${Math.round(oppStuns ?? 0)} у ${oppName}`;
  const xpmFact = xpmShare === null ? undefined : `XPM ${p.xp_per_min}: ${shareFact(xpmShare, ROLE_SHARE.xpm[position]!, 'досвіду команди', position)}`;
  return scoreArea('support', [
    { weight: 0.35, value: versus(wards, oppWards, 0.2, 0.7), good: wardsFact, bad: wardsFact },
    { weight: 0.25, value: dewards === null || oppDewards === null ? null : signedRamp(dewards - oppDewards, 1, 4), good: dewardsFact, bad: dewardsFact },
    { weight: 0.1, value: stacks === null || oppStacks === null ? null : signedRamp(stacks - oppStacks, 1, 4), good: stacksFact, bad: stacksFact },
    // Stuns depend mostly on the hero's spells: a small weight.
    { weight: 0.1, value: versus(stuns, oppStuns, 0.3, 0.8), good: stunsFact, bad: stunsFact },
    { weight: 0.2, value: shareScore(xpmShare, ROLE_SHARE.xpm[position]!, 0.1, 0.35), good: xpmFact, bad: xpmFact },
  ]);
}
