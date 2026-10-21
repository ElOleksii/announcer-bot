/**
 * Runs the blame (loss) and MVP (win) scoring over many real matches and prints how it behaves,
 * to tune thresholds and spot unfairness: a position that is always blamed, a category that never
 * scores, a score that says nothing about who actually won.
 *
 *   npm run calibrate                → every match in data/matches/ (fill it with `npm run collect`)
 *   npm run calibrate -- <directory>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CATEGORY_MAX, computeBlame, type CategoryKey } from '../src/analysis/blame.js';
import { MVP_CATEGORY_MAX, computeMvp, type MvpCategoryKey } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { LANE_MINUTE, assignPositions, avg, laneMatchup, mapLane } from '../src/analysis/scoring.js';

interface Row {
  position: number;
  won: boolean;
  blame: number;
  mvp: number;
  blameCats: Record<string, number>;
  mvpCats: Record<string, number>;
  culprit: boolean;
  isMvp: boolean;
}

const dir = resolve(process.argv[2] ?? 'data/matches');
const heroes = new Map<number, HeroInfo>();
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const matches: OdMatch[] = [];
for (const file of files) {
  const result = matchSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  if (result.success && result.data.radiant_win != null) matches.push(result.data);
  else console.warn(`skipped ${file}`);
}
if (matches.length === 0) {
  console.error(`No matches in ${dir}. Run \`npm run collect\` first.`);
  process.exit(1);
}

const rows: Row[] = [];
const verdicts = { culprit: 0, 'behind-everywhere': 0, 'no-clear-culprit': 0 };
/** Our lane totals divided by theirs at the lane minute, by the kind of lane our core played. */
const laneRatios: Record<'safe' | 'mid', { gold: number[]; xp: number[] }> = { safe: { gold: [], xp: [] }, mid: { gold: [], xp: [] } };

for (const match of matches) {
  for (const radiant of [true, false]) {
    // Both scores for both teams: a fair score should separate winners from losers.
    const blame = computeBlame(match, heroes, radiant);
    const mvp = computeMvp(match, heroes, radiant);
    const won = match.radiant_win === radiant;
    if (!won) {
      const key = blame.verdict.kind === 'culprit' ? 'culprit' : blame.verdict.reason;
      verdicts[key]++;
    }
    for (const b of blame.players) {
      const m = mvp.players.find((x) => x.slot === b.slot)!;
      rows.push({
        position: b.position,
        won,
        blame: b.score,
        mvp: m.score,
        blameCats: Object.fromEntries(b.categories.map((c) => [c.key, c.points])),
        mvpCats: Object.fromEntries(m.categories.map((c) => [c.key, c.points])),
        culprit: blame.verdict.kind === 'culprit' && blame.verdict.slot === b.slot,
        isMvp: mvp.mvpSlots.includes(b.slot),
      });
    }

    const ours = match.players.filter((p) => p.isRadiant === radiant);
    const theirs = match.players.filter((p) => p.isRadiant !== radiant);
    const positions = assignPositions(ours);
    for (const lane of [1, 2, 3]) {
      const inLane = ours.filter((p) => mapLane(p) === lane);
      const core = inLane.sort((a, b) => (positions.get(a.player_slot) ?? 5) - (positions.get(b.player_slot) ?? 5))[0];
      const kind = core && core.lane_role === 1 ? 'safe' : core && core.lane_role === 2 ? 'mid' : null;
      const matchup = core && kind ? laneMatchup(core, ours, theirs, LANE_MINUTE) : null;
      if (!kind || !matchup) continue;
      if (matchup.gold) laneRatios[kind].gold.push(matchup.gold[0] / Math.max(matchup.gold[1], 1));
      if (matchup.xp) laneRatios[kind].xp.push(matchup.xp[0] / Math.max(matchup.xp[1], 1));
    }
  }
}

/** Probability that a random `pos` value beats a random `neg` value (0.5 = the score tells nothing). */
function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : Number.NaN;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : Number.NaN;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const share = (n: number, total: number) => `${Math.round((n / Math.max(total, 1)) * 100)}%`;
const POSITIONS = [1, 2, 3, 4, 5];

const losses = matches.length;
console.log(`\n${matches.length} matches from ${dir} (${matches.filter((m) => m.version != null).length} parsed)\n`);

console.log('Loss verdicts');
console.table({
  culprit: share(verdicts.culprit, losses),
  'team: behind everywhere': share(verdicts['behind-everywhere'], losses),
  'team: no clear culprit': share(verdicts['no-clear-culprit'], losses),
});

console.log('Blame on the losing team, by position (AUC: how well blame tells losers from winners)');
console.table(
  Object.fromEntries(
    POSITIONS.map((pos) => {
      const lost = rows.filter((r) => r.position === pos && !r.won);
      const won = rows.filter((r) => r.position === pos && r.won);
      return [
        `pos${pos}`,
        {
          'avg blame': r1(avg(lost.map((r) => r.blame))),
          'winners avg': r1(avg(won.map((r) => r.blame))),
          AUC: r2(auc(lost.map((r) => r.blame), won.map((r) => r.blame))),
          'culprit share': share(lost.filter((r) => r.culprit).length, verdicts.culprit),
          ...Object.fromEntries((Object.keys(CATEGORY_MAX) as CategoryKey[]).map((k) => [k, r1(avg(lost.map((r) => r.blameCats[k] ?? 0)))])),
        },
      ];
    }),
  ),
);

console.log('MVP score on the winning team, by position (AUC: how well it tells winners from losers)');
const mvpCount = rows.filter((r) => r.won && r.isMvp).length;
console.table(
  Object.fromEntries(
    POSITIONS.map((pos) => {
      const won = rows.filter((r) => r.position === pos && r.won);
      const lost = rows.filter((r) => r.position === pos && !r.won);
      return [
        `pos${pos}`,
        {
          'avg MVP': r1(avg(won.map((r) => r.mvp))),
          'losers avg': r1(avg(lost.map((r) => r.mvp))),
          AUC: r2(auc(won.map((r) => r.mvp), lost.map((r) => r.mvp))),
          'MVP share': share(won.filter((r) => r.isMvp).length, mvpCount),
          ...Object.fromEntries((Object.keys(MVP_CATEGORY_MAX) as MvpCategoryKey[]).map((k) => [k, r1(avg(won.map((r) => r.mvpCats[k] ?? 0)))])),
        },
      ];
    }),
  ),
);

console.log(`Lane totals at ${LANE_MINUTE}:00, ours ÷ theirs (median; 1.00 = even, safe lane meets their offlane)`);
console.table({
  'safe lane': { lanes: laneRatios.safe.gold.length, gold: r2(median(laneRatios.safe.gold)), xp: r2(median(laneRatios.safe.xp)) },
  mid: { lanes: laneRatios.mid.gold.length, gold: r2(median(laneRatios.mid.gold)), xp: r2(median(laneRatios.mid.xp)) },
});
