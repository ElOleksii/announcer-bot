import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, type Message } from 'discord.js';
import type { AnalysisSink } from '../analysis/job.js';
import type { DiscordConfig } from '../config/env.js';
import type { SoundKey } from '../game/events.js';
import type { Logger } from '../logger.js';
import { handleCommand, registerGuildCommands, type CommandContext } from './commands.js';
import { splitMessage, syncMessages } from './messages.js';
import type { VoiceManager } from './voice.js';

export interface DiscordBotOptions {
  config: DiscordConfig;
  logger: Logger;
  voice: VoiceManager;
  soundKeys: readonly SoundKey[];
  commands: Omit<CommandContext, 'joinChannel' | 'leave' | 'voiceChannelId'>;
  /** Called once the bot is logged in and the server is available. */
  onReady?: () => void | Promise<void>;
}

export interface DiscordBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * A message for a match analysis, created on the first update and edited afterwards. Posted to
   * `channelId` if given, else the chat of the bot's voice channel, else the server's system channel.
   */
  createChannelSink(channelId: string | null): AnalysisSink;
  /** Where analyses go and whether the bot may write there (for the startup log and /status). */
  describeAnalysisTarget(channelId: string | null): Promise<{ ok: boolean; text: string }>;
}

export function createDiscordBot({ config, logger, voice, soundKeys, commands, onReady }: DiscordBotOptions): DiscordBot {
  const log = logger.child({ module: 'discord' });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  const ctx: CommandContext = {
    ...commands,
    async joinChannel(member) {
      const channel = member.voice.channel;
      if (!channel) throw new Error('you are not in a voice channel');
      await voice.join(channel);
      return channel.name;
    },
    leave() {
      const wasConnected = voice.isConnected;
      voice.leave();
      return wasConnected;
    },
    voiceChannelId: () => voice.connectedChannelId,
  };

  const inviteUrl =
    `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot+applications.commands` +
    `&permissions=3148800&guild_id=${config.guildId}&disable_guild_select=true`;

  const registerCommands = async () => {
    try {
      const count = await registerGuildCommands(config.token, config.clientId, config.guildId, soundKeys);
      log.info({ count, guildId: config.guildId }, 'registered slash commands');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'failed to register slash commands (check DISCORD_CLIENT_ID and GUILD_ID)');
    }
  };

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag }, 'logged in to Discord');
    if (ready.guilds.cache.has(config.guildId)) {
      await registerCommands();
      await Promise.resolve(onReady?.()).catch((err: unknown) => log.warn({ err: (err as Error).message }, 'onReady failed'));
    } else {
      // Registration would fail with "Missing Access"; it runs on GuildCreate once the bot is invited.
      log.warn({ guildId: config.guildId, inviteUrl }, 'bot is not a member of GUILD_ID yet; open the invite URL, no restart needed');
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    if (guild.id !== config.guildId) return;
    log.info({ guild: guild.name }, 'bot was added to the server');
    await registerCommands();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inCachedGuild() || interaction.guildId !== config.guildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot only works in its configured server.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    log.info({ command: interaction.commandName, user: interaction.user.tag }, 'slash command');
    try {
      await handleCommand(interaction, ctx);
    } catch (err) {
      log.error({ err, command: interaction.commandName }, 'command failed');
      const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
      await (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  });

  client.on(Events.Warn, (message) => log.warn(message));
  client.on(Events.Error, (err) => log.error({ err: err.message }, 'discord client error'));
  client.on(Events.ShardDisconnect, () => log.warn('gateway disconnected'));
  client.on(Events.ShardResume, () => log.info('gateway connection resumed'));

  return {
    async start() {
      await client.login(config.token);
    },
    async stop() {
      voice.leave();
      await client.destroy();
    },
    createChannelSink(channelId) {
      /** The analysis, split into as many messages as it needs (see splitMessage). */
      let messages: Message[] = [];
      /** Where the first message went; the rest of the analysis follows it there. */
      let target: { send(content: string): Promise<Message> } | null = null;
      const send = async (content: string) => {
        if (target) return target.send(content);
        for (const id of analysisCandidates(channelId)) {
          try {
            const channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id));
            if (!channel?.isSendable()) continue;
            const message = await channel.send(content);
            target = channel;
            return message;
          } catch (err) {
            log.warn({ err: (err as Error).message, channelId: id }, 'cannot post the analysis there (missing Send Messages permission?)');
          }
        }
        throw new Error('no channel to post the analysis (set ANALYSIS_CHANNEL_ID and give the bot Send Messages)');
      };
      return {
        get url() {
          return messages[0]?.url ?? null;
        },
        async update(text) {
          messages = await syncMessages(messages, splitMessage(text), send);
        },
      };
    },
    async describeAnalysisTarget(channelId) {
      const guild = client.guilds.cache.get(config.guildId);
      const me = guild?.members.me;
      const id = channelId ?? guild?.systemChannelId ?? null;
      const source = channelId ? 'ANALYSIS_CHANNEL_ID' : 'системний канал сервера';
      const voiceNote = channelId ? '' : ' (а якщо бот у войсі — спершу чат войсу)';
      if (!id || !guild || !me) return { ok: false, text: `канал не задано і системного каналу немає — задай ANALYSIS_CHANNEL_ID${voiceNote}` };
      try {
        const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id));
        if (!channel) return { ok: false, text: `канал ${id} з ${source} не знайдено` };
        const canSend = channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false;
        return canSend
          ? { ok: true, text: `<#${id}> (${source})${voiceNote} ✅` }
          : { ok: false, text: `<#${id}> (${source}) ❌ немає права View Channel / Send Messages${voiceNote}` };
      } catch (err) {
        return { ok: false, text: `канал ${id} недоступний: ${(err as Error).message}` };
      }
    },
  };

  /** Explicit channel, else the chat of the bot's voice channel, else the server's system channel. */
  function analysisCandidates(channelId: string | null): string[] {
    const ids = [channelId, voice.connectedChannelId, client.guilds.cache.get(config.guildId)?.systemChannelId ?? null];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }
}
