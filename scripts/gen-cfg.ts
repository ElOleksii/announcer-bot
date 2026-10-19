/**
 * Writes gamestate_integration_killannouncer.cfg using GSI_PORT and GSI_TOKEN from .env.
 *
 *   npm run gen:cfg                 → ./gamestate_integration_killannouncer.cfg
 *   npm run gen:cfg -- <directory>  → <directory>/gamestate_integration_killannouncer.cfg
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, loadDotEnv, loadGsiConfig } from '../src/config/env.js';
import { GSI_CFG_FILENAME, renderGsiCfg } from '../src/gsi/cfg.js';

try {
  loadDotEnv();
  const gsi = loadGsiConfig();
  const dir = resolve(process.argv[2] ?? '.');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, GSI_CFG_FILENAME);
  writeFileSync(target, renderGsiCfg(gsi), 'utf8');
  console.log(`Wrote ${target}`);
  console.log(`GSI endpoint: http://127.0.0.1:${gsi.port}/`);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
}
