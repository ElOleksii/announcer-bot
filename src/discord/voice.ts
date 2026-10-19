import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
  type VoiceConnectionState,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { spawnOggOpus } from '../audio/ffmpeg.js';
import type { AudioSink } from '../audio/playback-queue.js';
import type { Logger } from '../logger.js';

const READY_TIMEOUT_MS = 20_000;
const MAX_REJOIN_ATTEMPTS = 5;

const MAX_CLIP_MS = 30_000;
/** Voice WebSocket close code when the bot was kicked or moved to another channel. */
const CLOSE_CODE_DISCONNECTED = 4014;

/**
 * Owns the single voice connection and audio player for the configured guild.
 * Reconnects on its own after network drops; gives up only after repeated failures or a kick.
 */
export class VoiceManager implements AudioSink {
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private readonly log: Logger;
  private readyLock = false;

  constructor(logger: Logger) {
    this.log = logger.child({ module: 'voice' });
    // Stop (not pause) without subscribers, so the queue never stalls.
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.player.on('error', (err) => this.log.error({ err: err.message }, 'audio player error'));
  }

  /** Channel id while connected. Follows the bot when someone drags it to another channel. */
  get connectedChannelId(): string | null {
    return this.connection?.state.status === VoiceConnectionStatus.Ready ? this.connection.joinConfig.channelId : null;
  }

  get isConnected(): boolean {
    return this.connectedChannelId !== null;
  }

  async join(channel: VoiceBasedChannel): Promise<void> {
    if (this.connection && this.connection.joinConfig.channelId === channel.id && this.isConnected) return;
    this.leave();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;
    connection.on('stateChange', (oldState, newState) => void this.onStateChange(connection, oldState, newState));
    connection.on('error', (err) => this.log.warn({ err: err.message }, 'voice connection error'));
    connection.subscribe(this.player);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      this.log.info({ channel: channel.name }, 'joined voice channel');
    } catch (err) {
      this.leave();
      throw new Error(`Could not connect to #${channel.name} within ${READY_TIMEOUT_MS / 1000}s`, { cause: err });
    }
  }

  leave(): void {
    const connection = this.connection;
    this.connection = null;
    this.player.stop(true);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      this.log.info('left voice channel');
    }
  }

  async play(file: string, volume: number): Promise<void> {
    if (!this.isConnected) {
      this.log.debug({ file }, 'not in a voice channel, skipping sound');
      return;
    }

    const ffmpeg = spawnOggOpus(file, volume);
    let stderr = '';
    ffmpeg.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    ffmpeg.once('error', (err) => this.log.error({ err: err.message }, 'failed to start ffmpeg'));

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });

    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.player.stop(true), MAX_CLIP_MS);
        const onState = (_old: unknown, state: { status: AudioPlayerStatus }) => {
          if (state.status !== AudioPlayerStatus.Idle) return;
          clearTimeout(timer);
          this.player.off('stateChange', onState);
          resolve();
        };
        this.player.on('stateChange', onState);
        this.player.play(resource);
      });
    } finally {
      if (ffmpeg.exitCode === null) ffmpeg.kill();
      if (stderr.trim()) this.log.warn({ file, ffmpeg: stderr.trim() }, 'ffmpeg reported a problem');
    }
  }

  /** Reconnection logic, following the @discordjs/voice examples. */
  private async onStateChange(connection: VoiceConnection, oldState: VoiceConnectionState, newState: VoiceConnectionState): Promise<void> {
    if (connection !== this.connection) return; // stale connection we already replaced
    if (oldState.status !== newState.status) this.log.debug({ from: oldState.status, to: newState.status }, 'voice state');

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === CLOSE_CODE_DISCONNECTED) {
        // Either moved to another channel (we will reconnect by ourselves) or kicked (we won't).
        try {
          await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
          this.log.info('moved to another voice channel');
        } catch {
          this.log.warn('disconnected from voice (kicked or channel deleted); use /join to bring me back');
          this.leave();
        }
      } else if (connection.rejoinAttempts < MAX_REJOIN_ATTEMPTS) {
        const delay = (connection.rejoinAttempts + 1) * 5_000;
        this.log.warn({ attempt: connection.rejoinAttempts + 1, delayMs: delay }, 'voice connection lost, rejoining');
        await new Promise((r) => setTimeout(r, delay));
        if (connection === this.connection && connection.state.status === VoiceConnectionStatus.Disconnected) {
          connection.rejoin();
        }
      } else {
        this.log.error('voice connection lost and rejoin attempts exhausted; use /join');
        this.leave();
      }
      return;
    }

    // Reconnecting (from Ready or Disconnected). The initial connect is awaited in join().
    const reconnecting =
      (newState.status === VoiceConnectionStatus.Signalling || newState.status === VoiceConnectionStatus.Connecting) &&
      (oldState.status === VoiceConnectionStatus.Ready || oldState.status === VoiceConnectionStatus.Disconnected);
    if (reconnecting && !this.readyLock) {
      this.readyLock = true;
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        this.log.info('voice connection restored');
      } catch {
        const status = connection.state.status;
        if (connection === this.connection && status !== VoiceConnectionStatus.Destroyed && status !== VoiceConnectionStatus.Disconnected) {
          this.log.warn('voice reconnect timed out, retrying');
          connection.disconnect(); // → Disconnected → rejoin path above
        }
      } finally {
        this.readyLock = false;
      }
    }
  }
}
