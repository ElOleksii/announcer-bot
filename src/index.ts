import { MatchAnalyzer, MatchEndWatcher, resolveMatchHint, type MatchHint } from './analysis/analyzer.js';
import { AnalysisJob, JOB_STATE_LABELS, type AnalysisSink } from './analysis/job.js';
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
import type { AnalyzeOutcome } from './discord/commands.js';
import { VoiceManager } from './discord/voice.js';
import { MATCH_RESULT_SOUNDS, describeEvent } from './game/events.js';
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
  // Only multikills and streaks fall back to "kill"; kill, death and the match result do not.
  const noFallback = new Set<string>(['kill', 'death', ...Object.values(MATCH_RESULT_SOUNDS)]);
  const fallingBack = sounds.withoutSound.filter((key) => !noFallback.has(key));
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
  // Hero stats, items and players' hero histories are cached for a day in data/cache/ (gitignored).
  const openDota = new OpenDotaClient({ apiKey: config.analysis.openDotaApiKey, cacheDir: 'data/cache' });
  const analyzer = new MatchAnalyzer({
    openDota,
    writer: config.analysis.gemini ? new GeminiWriter(config.analysis.gemini) : null,
    logger,
  });
  const matchWatcher = new MatchEndWatcher();
  let autoAnalyze = config.analysis.auto;
  const analysisLog = logger.child({ module: 'analysis' });
  logger.info({ auto: autoAnalyze, tone: config.analysis.tone, verdict: config.analysis.gemini ? 'gemini' : 'built-in' }, 'match analysis ready');

  /** One job per match; different matches are analysed independently. */
  const jobs = new Map<string, AnalysisJob>();
  const startJob = (hint: MatchHint, tone: AnalysisTone, sink: AnalysisSink): AnalyzeOutcome => {
    const running = jobs.get(hint.matchId);
    if (running) return { kind: 'already-running', url: running.url };
    const job = new AnalysisJob({ hint, tone, openDota, analyzer, sink, logger });
    jobs.set(hint.matchId, job);
    void job.run().finally(() => jobs.delete(hint.matchId));
    return { kind: 'started' };
  };
  /** Without Discord (local mode) analyses only go to the log. */
  const logSink = (): AnalysisSink => ({
    async update(text) {
      analysisLog.info({ text }, 'analysis update');
    },
  });

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
      if (finishedMatch) {
        const played = announcer.playMatchResult(finishedMatch.result);
        gameLog.info({ matchId: finishedMatch.matchId, result: finishedMatch.result, sound: played }, 'match ended');
      }
      if (finishedMatch && autoAnalyze) {
        analysisLog.info({ matchId: finishedMatch.matchId }, 'match finished, starting analysis');
        startJob(finishedMatch, config.analysis.tone, bot ? bot.createChannelSink(config.analysis.channelId) : logSink());
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
        async analyze({ matchId, tone, team }, sink) {
          const hint = resolveMatchHint({ matchId, team }, matchWatcher.lastMatch(), config.analysis.playerAccountId);
          if (!hint) return { kind: 'no-match' };
          return startJob(hint, tone ?? config.analysis.tone, sink);
        },
        async analysisStatus() {
          const target = await bot?.describeAnalysisTarget(config.analysis.channelId);
          const lines = [`**Розбори:** авто ${autoAnalyze ? 'увімкнено' : 'вимкнено'} · канал: ${target?.text ?? '—'}`];
          for (const job of jobs.values()) {
            lines.push(`• матч \`${job.matchId}\` — ${JOB_STATE_LABELS[job.state]}, ${Math.round((Date.now() - job.startedAt) / 60_000)} хв`);
          }
          return lines;
        },
        getAutoAnalyze: () => autoAnalyze,
        setAutoAnalyze(on) {
          autoAnalyze = on;
          analysisLog.info({ auto: on }, 'auto analysis toggled');
        },
      },
      async onReady() {
        // Say up front where analyses will go, so a missing permission shows before the first match ends.
        const target = await bot?.describeAnalysisTarget(config.analysis.channelId);
        if (!target) return;
        if (target.ok) analysisLog.info({ channel: target.text }, 'analyses will be posted here');
        else analysisLog.warn({ channel: target.text }, 'analyses cannot be posted yet');
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
