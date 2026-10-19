import { z } from 'zod';

/**
 * Dota 2 GSI payload. Only the fields we use are typed; everything else passes through.
 * All sections are optional: in the main menu Dota sends only `provider`, and while
 * spectating `player` contains `team2`/`team3` maps instead of the player's own stats.
 */

export const GAME_IN_PROGRESS = 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';

const idString = z.union([z.string(), z.number()]).transform(String);

export const providerSchema = z.looseObject({
  name: z.string().optional(),
  appid: z.number().optional(),
  version: z.number().optional(),
  timestamp: z.number().optional(),
});

export const mapSchema = z.looseObject({
  matchid: idString.optional(),
  game_time: z.number().optional(),
  clock_time: z.number().optional(),
  game_state: z.string().optional(),
  paused: z.boolean().optional(),
});

export const playerSchema = z.looseObject({
  steamid: idString.optional(),
  name: z.string().optional(),
  activity: z.string().optional(),
  kills: z.number().int().nonnegative().optional(),
  deaths: z.number().int().nonnegative().optional(),
  assists: z.number().int().nonnegative().optional(),
  kill_streak: z.number().int().nonnegative().optional(),
});

export const heroSchema = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  alive: z.boolean().optional(),
});

export const gsiPayloadSchema = z.looseObject({
  provider: providerSchema.optional(),
  map: mapSchema.optional(),
  player: playerSchema.optional(),
  hero: heroSchema.optional(),
  auth: z.looseObject({ token: z.string().optional() }).optional(),
});

export type GsiPayload = z.infer<typeof gsiPayloadSchema>;

export type ParseResult =
  | { ok: true; payload: GsiPayload }
  | { ok: false; error: string };

export function parseGsiPayload(raw: unknown): ParseResult {
  const result = gsiPayloadSchema.safeParse(raw);
  if (result.success) return { ok: true, payload: result.data };
  return { ok: false, error: z.prettifyError(result.error) };
}
