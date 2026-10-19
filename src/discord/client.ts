import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { DiscordConfig } from '../config/env.js';
import type { SoundKey } from '../game/events.js';
import type { Logger } from '../logger.js';
import { handleCommand, registerGuildCommands, type CommandContext } from './commands.js';
import type { VoiceManager } from './voice.js';

export interface DiscordBotOptions {
  config: DiscordConfig;
  logger: Logger;
  voice: VoiceManager;
  soundKeys: readonly SoundKey[];
  commands: Omit<CommandContext, 'joinChannel' | 'leave' | 'voiceChannelId'>;
}

export interface DiscordBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Posts a loss analysis: to `channelId` if given, else the chat of the bot's voice channel,
   * else the server's system channel. Needs the Send Messages permission there.
   */
  postAnalysis(text: string, channelId: string | null): Promise<boolean>;
}

export function createDiscordBot({ config, logger, voice, soundKeys, commands }: DiscordBotOptions): DiscordBot {
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
    `&permissions=3146752&guild_id=${config.guildId}&disable_guild_select=true`;

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
    async postAnalysis(text, channelId) {
      const candidates = [channelId, voice.connectedChannelId, client.guilds.cache.get(config.guildId)?.systemChannelId ?? null];
      for (const id of candidates) {
        if (!id) continue;
        try {
          const channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id));
          if (!channel?.isSendable()) continue;
          await channel.send(text);
          return true;
        } catch (err) {
          log.warn({ err: (err as Error).message, channelId: id }, 'cannot post the analysis there (missing Send Messages permission?)');
        }
      }
      return false;
    },
  };
}
