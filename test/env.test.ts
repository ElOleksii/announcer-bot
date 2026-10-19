import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadGsiConfig } from '../src/config/env.js';

const GSI_TOKEN = 'a'.repeat(32);
const discordEnv = { DISCORD_TOKEN: 'secret', DISCORD_CLIENT_ID: '123', GUILD_ID: '456' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ GSI_TOKEN, ...discordEnv });
    expect(config).toMatchObject({
      mode: 'discord',
      logLevel: 'info',
      gsi: { port: 3000, token: GSI_TOKEN },
      discord: { token: 'secret', clientId: '123', guildId: '456' },
      multikillWindowMs: 18_000,
      announceDeaths: false,
      soundsConfigPath: 'sounds.config.json',
    });
  });

  it('requires Discord settings only in discord mode', () => {
    expect(() => loadConfig({ GSI_TOKEN })).toThrow(/DISCORD_TOKEN is required/);
    expect(loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local' }).discord).toBeNull();
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', GSI_PORT: '', LOG_LEVEL: '' })).toMatchObject({
      gsi: { port: 3000 },
      logLevel: 'info',
    });
  });

  it('parses numbers and booleans', () => {
    const config = loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', GSI_PORT: '4000', MULTIKILL_WINDOW_MS: '15000', ANNOUNCE_DEATHS: 'true' });
    expect(config).toMatchObject({ gsi: { port: 4000 }, multikillWindowMs: 15_000, announceDeaths: true });
  });

  it.each([
    [{ GSI_TOKEN: 'short' }, /at least 16/],
    [{ GSI_TOKEN: 'has "quotes" in it!!' }, /may only contain/],
    [{ GSI_TOKEN, GSI_PORT: '70000' }, /GSI_PORT/],
    [{ GSI_TOKEN, PLAYBACK_MODE: 'speaker' }, /PLAYBACK_MODE/],
    [{}, /GSI_TOKEN is required/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig({ PLAYBACK_MODE: 'local', ...env })).toThrow(ConfigError);
    expect(() => loadConfig({ PLAYBACK_MODE: 'local', ...env })).toThrow(message);
  });

  it('never echoes the Discord token in error messages', () => {
    try {
      loadConfig({ ...discordEnv, DISCORD_TOKEN: 'super-secret-value', GSI_TOKEN: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-value');
    }
  });
});

describe('loadGsiConfig', () => {
  it('needs only the GSI variables', () => {
    expect(loadGsiConfig({ GSI_TOKEN, GSI_PORT: '3001' })).toEqual({ port: 3001, token: GSI_TOKEN });
  });
});

describe('commentary config', () => {
  const base = { GSI_TOKEN, PLAYBACK_MODE: 'local' };

  it('defaults to sounds mode with template lines and no TTS', () => {
    expect(loadConfig(base).commentary).toEqual({ mode: 'sounds', timeoutMs: 6000, text: { provider: 'templates' }, tts: null });
  });

  it('builds Gemini + ElevenLabs settings with defaults', () => {
    const config = loadConfig({ ...base, ANNOUNCER_MODE: 'both', COMMENTARY_TEXT: 'gemini', GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'e' });
    expect(config.commentary).toMatchObject({
      mode: 'both',
      text: { provider: 'gemini', apiKey: 'g', model: 'gemini-3.1-flash-lite' },
      tts: { apiKey: 'e', model: 'eleven_flash_v2_5', language: 'uk' },
    });
  });

  it('requires the keys the chosen setup needs', () => {
    expect(() => loadConfig({ ...base, COMMENTARY_TEXT: 'gemini' })).toThrow(/GEMINI_API_KEY is required/);
    expect(() => loadConfig({ ...base, ANNOUNCER_MODE: 'commentator' })).toThrow(/ELEVENLABS_API_KEY is required/);
  });
});

describe('analysis config', () => {
  const base = { GSI_TOKEN, PLAYBACK_MODE: 'local' };

  it('defaults to auto analysis with the harsh tone and the built-in verdict', () => {
    expect(loadConfig(base).analysis).toEqual({ auto: true, tone: 'harsh', gemini: null, playerAccountId: null, channelId: null });
  });

  it('uses Gemini for the verdict whenever a key is set', () => {
    expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', AUTO_ANALYZE: 'false', ANALYSIS_TONE: 'light' }).analysis).toEqual({
      auto: false,
      tone: 'light',
      gemini: { apiKey: 'g', model: 'gemini-3.1-flash-lite', fallbackModels: ['gemini-3.5-flash-lite'] },
      playerAccountId: null,
      channelId: null,
    });
  });
});

describe('PLAYER_STEAM_ID', () => {
  it('becomes an OpenDota account id', () => {
    expect(loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', PLAYER_STEAM_ID: '76561198000000000' }).analysis.playerAccountId).toBe(39734272);
  });

  it('rejects anything but a SteamID64', () => {
    expect(() => loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', PLAYER_STEAM_ID: '39734272' })).toThrow(/SteamID64/);
  });
});

describe('ANALYSIS_CHANNEL_ID', () => {
  it('is optional and must be numeric', () => {
    expect(loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', ANALYSIS_CHANNEL_ID: '123456' }).analysis.channelId).toBe('123456');
    expect(() => loadConfig({ GSI_TOKEN, PLAYBACK_MODE: 'local', ANALYSIS_CHANNEL_ID: 'general' })).toThrow(/numeric channel id/);
  });
});

describe('GEMINI_FALLBACK_MODELS', () => {
  const base = { GSI_TOKEN, PLAYBACK_MODE: 'local', GEMINI_API_KEY: 'g' };
  it('parses a comma list, or none', () => {
    expect(loadConfig({ ...base, GEMINI_FALLBACK_MODELS: 'a, b,,c' }).analysis.gemini?.fallbackModels).toEqual(['a', 'b', 'c']);
    expect(loadConfig({ ...base, GEMINI_FALLBACK_MODELS: 'none' }).analysis.gemini?.fallbackModels).toEqual([]);
  });
});
