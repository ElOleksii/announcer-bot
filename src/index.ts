import { MatchAnalyzer, MatchEndWatcher, resolveMatchHint, type MatchHint } from './analysis/analyzer.js';
import { OpenDotaClient } from './analysis/opendota.js';
import type { AnalysisTone } from './analysis/report.js';
import { Announcer } from './announcer.js';
import { LocalAudioSink } from './audio/local-player.js';
import { PlaybackQueue, type AudioSink } from './audio/playback-queue.js';
import { SoundPicker } from './audio/sound-picker.js';
import { Commentator } from './commentary/commentator.js';
import { KillContextTracker } from './commentary/context.js';
import { ElevenLabsSynthesizer } from './commentary/elevenlabs.js';
import { GeminiWriter } from './commentary/gemini.js';
import { TemplateWriter } from './commentary/templates.js';
import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from './config/env.js';
import { knownSoundKeys, loadSoundsConfig } from './config/sounds.js';
import { createDiscordBot, type DiscordBot } from './discord/client.js';
import { clampMessage, type AnalyzeOutcome } from './discord/commands.js';
import { VoiceManager } from './discord/voice.js';
import { describeEvent } from './game/events.js';
import { KillTracker } from './game/kill-tracker.js';
import { PayloadDump } from './gsi/dump.js';
import { createGsiServer, startGsiServer, GSI_HOST } from './gsi/server.js';
import { createLogger } from './logger.js';
import { AppStatus } from './status.js';

async function main(): Promise<void> {
  loadDotEnv();
  let config: AppConfig;
  let sounds: ReturnType<typeof loadSoundsConfig>;
  try {
    config = loadConfig();
    sounds = loadSoundsConfig(config.soundsConfigPath);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  logger.info({ mode: config.mode }, 'starting Dota 2 kill announcer');
  for (const warning of sounds.warnings) logger.warn(warning);
  const fallingBack = sounds.withoutSound.filter((key) => key !== 'kill' && key !== 'death');
  if (sounds.withoutSound.includes('kill')) {
    logger.warn('no playable file for "kill": plain kills will be silent');
  } else if (fallingBack.length > 0) {
    logger.info({ events: fallingBack }, 'events without their own sound will play the "kill" sound');
  }
  if (config.announceDeaths && sounds.withoutSound.includes('death')) {
    logger.warn('ANNOUNCE_DEATHS=true but there is no file for "death"');
  }

  const status = new AppStatus();
  const picker = new SoundPicker(sounds.events);
  const tracker = new KillTracker({
    multikillWindowMs: config.multikillWindowMs,
    streakThresholds: sounds.streakThresholds,
    announceDeaths: config.announceDeaths,
  });

  let sink: AudioSink;
  let voice: VoiceManager | null = null;
  if (config.mode === 'discord') {
    voice = new VoiceManager(logger);
    sink = voice;
  } else {
    sink = LocalAudioSink.detect(logger);
  }
  const queue = new PlaybackQueue(sink, { logger });

  const { commentary } = config;
  const templates = new TemplateWriter();
  const commentator = commentary.tts
    ? new Commentator({
        writer: commentary.text.provider === 'gemini' ? new GeminiWriter(commentary.text) : templates,
        fallbackWriter: templates,
        synthesizer: new ElevenLabsSynthesizer(commentary.tts),
        timeoutMs: commentary.timeoutMs,
        logger,
      })
    : null;
  const announcer = new Announcer({ picker, queue, commentator, mode: commentary.mode, logger });
  logger.info({ mode: announcer.mode, commentator: announcer.commentatorDescription ?? 'not configured' }, 'announcer ready');
  const contextTracker = new KillContextTracker();

  // Match analysis (chat only): OpenDota stats → blame (loss) or MVP (win) scores → Gemini verdict (or built-in text).
  const analyzer = new MatchAnalyzer({
    openDota: new OpenDotaClient(),
    writer: config.analysis.gemini ? new GeminiWriter(config.analysis.gemini) : null,
    logger,
  });
  const matchWatcher = new MatchEndWatcher();
  let autoAnalyze = config.analysis.auto;
  let analysing = false;
  const analysisLog = logger.child({ module: 'analysis' });
  logger.info({ auto: autoAnalyze, tone: config.analysis.tone, verdict: config.analysis.gemini ? 'gemini' : 'built-in' }, 'loss analysis ready');

  /** Runs one analysis. Returns null when another one is already running. */
  const runAnalysis = async (
    hint: MatchHint,
    tone: AnalysisTone,
    wait: { timeoutMs: number; pollMs: number },
  ): Promise<AnalyzeOutcome | null> => {
    if (analysing) return null;
    analysing = true;
    try {
      const result = await analyzer.analyze(hint, tone, wait);
      if (result.kind !== 'ok') return result;
      return { kind: 'ok', chatText: result.chatText };
    } catch (err) {
      analysisLog.error({ err: (err as Error).message, matchId: hint.matchId }, 'analysis failed');
      return { kind: 'error', message: (err as Error).message };
    } finally {
      analysing = false;
    }
  };

  const dump = config.gsiDumpFile ? new PayloadDump({ file: config.gsiDumpFile, logger }) : null;
  const gameLog = logger.child({ module: 'game' });
  const gsi = createGsiServer({
    token: config.gsi.token,
    logger,
    onPayload(payload) {
      const now = Date.now();
      const previousMatch = tracker.getState().matchId;
      status.recordPayload(payload, now);
      dump?.record(payload, now);
      const finishedMatch = matchWatcher.observe(payload);
      if (finishedMatch && autoAnalyze) {
        analysisLog.info({ matchId: finishedMatch.matchId }, 'match finished, analysing once OpenDota has it');
        // OpenDota needs a few minutes after the match; poll up to 20 minutes.
        void runAnalysis(finishedMatch, config.analysis.tone, { timeoutMs: 20 * 60_000, pollMs: 60_000 }).then(async (outcome) => {
          if (outcome?.kind === 'ok') {
            const posted = await bot?.postAnalysis(clampMessage(outcome.chatText), config.analysis.channelId);
            if (!posted) analysisLog.warn({ matchId: finishedMatch.matchId }, 'analysis ready but no channel to post it (set ANALYSIS_CHANNEL_ID)');
          } else if (outcome) analysisLog.info({ outcome: outcome.kind, matchId: finishedMatch.matchId }, 'auto analysis skipped');
        });
      }
      contextTracker.observe(payload, now);
      const event = tracker.process(payload, now);

      const { matchId, stats } = tracker.getState();
      if (matchId !== previousMatch) gameLog.info({ matchId, kills: stats?.kills ?? null }, 'tracking new match');
      if (!event) return;

      const label = describeEvent(event);
      gameLog.info({ event: label, kills: payload.player?.kills, streak: payload.player?.kill_streak }, 'announce');
      status.recordEvent(event, now);
      void announcer.onEvent(event, contextTracker.build(event, payload, now));
    },
  });

  let bot: DiscordBot | null = null;
  if (config.discord && voice) {
    const voiceManager = voice;
    bot = createDiscordBot({
      config: config.discord,
      logger,
      voice: voiceManager,
      soundKeys: knownSoundKeys(sounds.streakThresholds).filter((key) => picker.keys().includes(key)),
      commands: {
        test(sound) {
          if (!voiceManager.isConnected) return 'not-connected';
          return announcer.playSound([sound], `test: ${sound}`) ? 'queued' : 'no-file';
        },
        getMode: () => announcer.mode,
        setMode: (mode) => announcer.setMode(mode),
        async say(text) {
          if (!voiceManager.isConnected) return 'not-connected';
          return announcer.say(text);
        },
        status: () => status.get(),
        now: () => Date.now(),
        async analyze({ matchId, tone, team }) {
          const hint = resolveMatchHint({ matchId, team }, matchWatcher.lastMatch(), config.analysis.playerAccountId);
          if (!hint) return { kind: 'no-match' };
          // Interaction tokens live 15 minutes; don't wait for a parse longer than ~4.
          const outcome = await runAnalysis(hint, tone ?? config.analysis.tone, { timeoutMs: 4 * 60_000, pollMs: 30_000 });
          return outcome ?? { kind: 'busy' };
        },
        getAutoAnalyze: () => autoAnalyze,
        setAutoAnalyze(on) {
          autoAnalyze = on;
          analysisLog.info({ auto: on }, 'auto analysis toggled');
        },
      },
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    queue.clear();
    await Promise.allSettled([gsi.close(), bot?.stop(), dump?.close()]);
    logger.flush();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await startGsiServer(gsi, config.gsi.port);
  } catch (err) {
    logger.fatal({ err }, `cannot listen on ${GSI_HOST}:${config.gsi.port} (is another instance running?)`);
    process.exit(1);
  }
  logger.info({ url: `http://${GSI_HOST}:${config.gsi.port}/` }, 'GSI server listening');

  if (bot) {
    try {
      await bot.start();
    } catch (err) {
      logger.fatal({ err: (err as Error).message }, 'cannot log in to Discord (check DISCORD_TOKEN)');
      await gsi.close();
      process.exit(1);
    }
  } else {
    logger.info('local playback mode: Discord is disabled');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
