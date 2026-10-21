import type { MatchContext } from './context.js';
import { heroWinRate, shrunkMatchup, type ReferenceData } from './reference.js';
import { sum } from './scoring.js';

/**
 * A rough read of the draft: how strong both teams' heroes are right now in this bracket, plus how
 * our heroes fare against theirs. Shown as context only, never as blame: drafts decide little in
 * pub games and the matchup data is a small, mostly high-level sample.
 */
export interface DraftOutlook {
  /** Rough chance to win from the draft alone, 0.25–0.75. */
  expected: number;
  /** Sum over our heroes of (win rate − 50%), and the same for theirs. */
  ourMeta: number;
  theirMeta: number;
  /** Average over our heroes of their (shrunk) matchup edge against the enemy heroes; null without matchups. */
  matchupEdge: number | null;
}

export function draftOutlook(ctx: MatchContext, ref: ReferenceData): DraftOutlook | null {
  const meta = (heroes: number[]) => {
    const rates = heroes.map((h) => heroWinRate(ref.heroStats?.get(h), ctx.mode, ctx.bracket));
    return rates.every((r) => r !== null) ? sum(rates.map((r) => r! - 0.5)) : null;
  };
  const ourMeta = meta(ctx.ours.map((p) => p.hero_id));
  const theirMeta = meta(ctx.theirs.map((p) => p.hero_id));
  if (ourMeta === null || theirMeta === null) return null;

  // Each of our heroes: its average edge over the enemy heroes it has matchup data for.
  const edges = ctx.ours.flatMap((p) => {
    const list = ref.matchups.get(p.hero_id);
    if (!list) return [];
    const vs = ctx.theirs.map((e) => shrunkMatchup(list.find((m) => m.hero_id === e.hero_id))).filter((x): x is number => x !== null);
    return vs.length ? [sum(vs.map((x) => x - 0.5)) / vs.length] : [];
  });
  const matchupEdge = edges.length ? sum(edges) / edges.length : null;
  // Each hero adds its own edge: five heroes' worth of the average matchup edge.
  const expected = Math.min(0.75, Math.max(0.25, 0.5 + ourMeta - theirMeta + (matchupEdge ?? 0) * ctx.ours.length));
  return { expected, ourMeta, theirMeta, matchupEdge };
}
