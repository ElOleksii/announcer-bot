import type { OdPlayer } from '../opendota.js';
import { KILLS, benchmarkPct, mmss, num, plural, ramp } from '../scoring.js';
import { ROLE_SHARE, benchmarkScore, heroPercentileFacts, scoreArea, shareFact, shareScore, type AreaScore, type RatingInput } from './common.js';

/** The last minutes of a game, where kills close it out. */
const CLOSING_SEC = 180;

/**
 * Fights: the share of the team's hero damage and kills against what the position usually has,
 * hero damage against the same hero in other games, and kills when they mattered most (while the
 * team's lead surged, and in the last three minutes).
 */
export function fights(p: OdPlayer, input: RatingInput): AreaScore {
  const position = input.position(p);
  const teamDamage = input.teamTotal((x) => x.hero_damage);
  const teamKills = input.teamTotal((x) => x.kills);
  const damage = num(p.hero_damage);
  const damageShare = damage === null || teamDamage === 0 ? null : damage / teamDamage;
  const kp = teamKills === 0 ? null : (p.kills + p.assists) / teamKills;
  const damagePct = benchmarkPct(p, 'hero_damage_per_min');
  const killsLog = p.kills_log ?? null;
  const end = input.ctx.duration;
  const surgeKills = killsLog?.filter((k) => input.surges.some((t) => k.time >= (t - 2) * 60 && k.time <= t * 60)) ?? null;
  const lateKills = killsLog?.filter((k) => k.time >= end - CLOSING_SEC).length ?? null;
  const dmg = shareFact(damageShare, ROLE_SHARE.heroDamage[position]!, 'урону команди по героях', position);
  const kpFact = kp === null ? undefined : `участь у ${shareFact(kp, ROLE_SHARE.killParticipation[position]!, 'кілів команди', position)} (${p.kills}/${p.deaths}/${p.assists})`;
  return scoreArea('fights', [
    { weight: 0.3, value: shareScore(damageShare, ROLE_SHARE.heroDamage[position]!), good: dmg, bad: dmg },
    { weight: 0.25, value: shareScore(kp, ROLE_SHARE.killParticipation[position]!, 0.1, 0.35), good: kpFact, bad: kpFact },
    { weight: 0.2, value: benchmarkScore(damagePct, 'hero_damage_per_min'), ...heroPercentileFacts('урон по героях', damagePct) },
    {
      weight: 0.15,
      value: surgeKills === null || input.ctx.parsed === false ? null : ramp(surgeKills.length, 0, 3),
      good: surgeKills?.[0] ? `${plural(surgeKills.length, KILLS)} під час ривку команди (перший на ${mmss(surgeKills[0].time)})` : undefined,
    },
    {
      weight: 0.1,
      value: lateKills === null ? null : ramp(lateKills, 0, 3),
      good: `${plural(lateKills ?? 0, KILLS)} за останні 3 хвилини`,
    },
  ]);
}
