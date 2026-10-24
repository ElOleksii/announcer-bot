/**
 * Checks the role weights (rating.ts) against real matches. For every position and area:
 * - how often the winner's player on that position scored higher in that area than the loser's
 *   (AUC, 0.5 = no difference), with a 90% range from resampling the matches;
 * - a team-level model of the result from the differences between the two teams' players on the
 *   same position, also with a 90% range;
 * - a suggested weight: the model's view blended with today's weights, worth PRIOR matches.
 *
 *   npm run fit-weights                → every match in data/matches/ (fill it with `npm run collect`)
 *   npm run fit-weights -- <directory>
 *
 * Read the output with care. The share parts of an area (net worth, damage, deaths… as a share of
 * the team) hardly differ between winners and losers on purpose: they compare teammates fairly. So
 * an area that predicts the result weakly is not automatically a bad area, and an outcome model
 * alone must not set the weights.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AREA_KEYS, type AreaKey } from '../src/analysis/areas/common.js';
import { OpenDotaClient, matchSchema, type HeroInfo, type OdMatch } from '../src/analysis/opendota.js';
import { ROLE_WEIGHTS, rateTeam } from '../src/analysis/rating.js';
import { NO_REFERENCE, type ReferenceData } from '../src/analysis/reference.js';
import { auc, bootstrap, logisticFit, quantile, suggestWeights } from './fit-lib.js';

/** How many matches today's weights are worth when blending in the model's suggestion. */
const PRIOR = 300;
const RESAMPLES = 200;
/** Below this many matches the team model has too few matches per parameter to trust. */
const MIN_MATCHES_FOR_MODEL = 200;
const POSITIONS = [1, 2, 3, 4, 5];

/** One match: each position's area values for both sides, and who won. */
interface Sample {
  radiantWin: boolean;
  radiant: Map<number, Partial<Record<AreaKey, number>>>;
  dire: Map<number, Partial<Record<AreaKey, number>>>;
}

const dir = resolve(process.argv[2] ?? 'data/matches');
const matches: OdMatch[] = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const result = matchSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  if (result.success && result.data.radiant_win != null && result.data.version != null) matches.push(result.data);
}
if (matches.length < 10) {
  console.error(`Only ${matches.length} parsed matches in ${dir}: collect more with \`npm run collect\`.`);
  process.exit(1);
}

let ref: ReferenceData = NO_REFERENCE;
try {
  ref = { ...NO_REFERENCE, heroStats: await new OpenDotaClient({ cacheDir: 'data/cache' }).getHeroStats() };
} catch (err) {
  console.warn(`No hero stats (${(err as Error).message}): the pick area is left out.`);
}

const heroes = new Map<number, HeroInfo>();
const side = (match: OdMatch, radiant: boolean) =>
  new Map(rateTeam(match, heroes, radiant, ref).players.map((p) => [p.position, Object.fromEntries(p.areas.filter((a) => a.value !== null).map((a) => [a.key, a.value!]))]));
const samples: Sample[] = matches.map((m) => ({ radiantWin: m.radiant_win!, radiant: side(m, true), dire: side(m, false) }));

const features = POSITIONS.flatMap((pos) => AREA_KEYS.map((area) => ({ pos, area })));
const toRow = (s: Sample) => features.map(({ pos, area }) => (s.radiant.get(pos)?.[area] ?? 0) - (s.dire.get(pos)?.[area] ?? 0));
const fit = (set: Sample[]) => logisticFit(set.map(toRow), set.map((s) => (s.radiantWin ? 1 : 0)));
/**
 * Winner's and loser's values on a position in an area, only from matches where both have one:
 * some areas exist mostly for one side (objectives for a team that hit buildings), and comparing
 * many winners with a few losers would mislead.
 */
const split = (set: Sample[], pos: number, area: AreaKey) => {
  const won: number[] = [];
  const lost: number[] = [];
  for (const s of set) {
    const [w, l] = s.radiantWin ? [s.radiant, s.dire] : [s.dire, s.radiant];
    const a = w.get(pos)?.[area];
    const b = l.get(pos)?.[area];
    if (a === undefined || b === undefined) continue;
    won.push(a);
    lost.push(b);
  }
  return { won, lost };
};

const coefficients = fit(samples);
const coefRuns = bootstrap(samples, RESAMPLES, fit);
const aucRuns = bootstrap(samples, RESAMPLES, (set) => features.map(({ pos, area }) => auc(split(set, pos, area).won, split(set, pos, area).lost)));
const r2 = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : '—');
const range = (runs: number[][], i: number) => `${r2(quantile(runs.map((r) => r[i]!), 0.05))} … ${r2(quantile(runs.map((r) => r[i]!), 0.95))}`;

console.log(`\n${samples.length} parsed matches from ${dir}. Today's weights are worth ${PRIOR} matches in the suggestion.`);
if (samples.length < MIN_MATCHES_FOR_MODEL) {
  console.log(
    `⚠️ The team model has ${features.length} parameters: below ~${MIN_MATCHES_FOR_MODEL} matches it can fit any result, so its ranges look narrower than they are. Trust the AUC columns more.`,
  );
}
console.log();
for (const pos of POSITIONS) {
  const current = ROLE_WEIGHTS[pos]!;
  const coefs = Object.fromEntries(AREA_KEYS.map((area) => [area, coefficients[features.findIndex((f) => f.pos === pos && f.area === area)]!])) as Record<AreaKey, number>;
  const suggested = suggestWeights(current, coefs, samples.length, PRIOR);
  console.log(`Position ${pos}`);
  console.table(
    Object.fromEntries(
      AREA_KEYS.map((area) => {
        const i = features.findIndex((f) => f.pos === pos && f.area === area);
        const { won, lost } = split(samples, pos, area);
        const clear = quantile(coefRuns.map((r) => r[i]!), 0.05) > 0 ? 'helps win' : quantile(coefRuns.map((r) => r[i]!), 0.95) < 0 ? 'hurts?' : '';
        return [
          area,
          {
            'weight now': current[area],
            'matches with both': won.length,
            'winner higher (AUC)': r2(auc(won, lost)),
            'AUC 90%': range(aucRuns, i),
            'team model': r2(coefs[area]),
            'model 90%': range(coefRuns, i),
            'clear?': clear,
            suggested: Math.round(suggested[area] * 10) / 10,
          },
        ];
      }),
    ),
  );
}
console.log(
  'Share parts of an area compare teammates and barely differ between winners and losers by design, so a weak AUC is not a reason to drop an area.\n' +
    'Change a weight only with enough matches, where the AUC range clearly excludes 0.5, and with the reason it should matter for that position.',
);
