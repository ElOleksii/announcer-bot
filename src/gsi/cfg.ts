import { GSI_HOST } from './server.js';

export const GSI_CFG_FILENAME = 'gamestate_integration_killannouncer.cfg';

/**
 * Data sections requested from Dota. Beyond what the kill tracker needs, `abilities` and
 * `items` feed the commentator, and the rest are requested so a payload dump shows
 * what a player (not spectator) actually receives. Sections Dota does not send are ignored.
 */
export const GSI_DATA_SECTIONS = [
  'provider',
  'map',
  'player',
  'hero',
  'abilities',
  'items',
  'events',
  'buildings',
  'draft',
  'wearables',
  'minimap',
  'roshan',
  'couriers',
  'neutralitems',
] as const;

export interface GsiCfgOptions {
  port: number;
  token: string;
}

/** Dota 2 Game State Integration config in Valve KeyValues format. */
export function renderGsiCfg({ port, token }: GsiCfgOptions): string {
  const data = GSI_DATA_SECTIONS.map((section) => `        ${`"${section}"`.padEnd(16)}"1"`).join('\n');
  return `"Dota 2 Kill Announcer"
{
    "uri"           "http://${GSI_HOST}:${port}/"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.1"
    "heartbeat"     "30.0"
    "data"
    {
${data}
    }
    "auth"
    {
        "token"     "${token}"
    }
}
`;
}
