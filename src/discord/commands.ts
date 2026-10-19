import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { ANALYSIS_TONES, type AnalysisTone } from '../analysis/report.js';
import { ANNOUNCER_MODES, type AnnouncerMode } from '../announcer.js';
import { describeEvent, type SoundKey } from '../game/events.js';
import type { StatusSnapshot } from '../status.js';

const MODE_LABELS: Record<AnnouncerMode, string> = {
  sounds: 'звуки',
  commentator: 'коментатор',
  both: 'звуки + коментатор',
};

/** /say text limit: keeps TTS credits and playback time sane. */
export const MAX_SAY_LENGTH = 300;

const TONE_LABELS: Record<AnalysisTone, string> = { harsh: 'жорстко', light: 'лайтово' };

/** Discord message limit. */
const MAX_MESSAGE = 2000;

export type AnalyzeOutcome =
  | { kind: 'ok'; chatText: string }
  | { kind: 'not-found' }
  | { kind: 'unknown-team' }
  | { kind: 'no-match' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string };

export function clampMessage(text: string): string {
  if (text.length <= MAX_MESSAGE) return text;
  const cut = text.slice(0, MAX_MESSAGE - 6);
  // Keep a code block closed if we cut inside it.
  return (cut.split('```').length % 2 === 0 ? `${cut}\n\`\`\`` : cut).slice(0, MAX_MESSAGE - 2) + ' …';
}

/** Discord allows at most 25 choices per option. */
const MAX_CHOICES = 25;

export function buildCommands(soundKeys: readonly SoundKey[]) {
  return [
    new SlashCommandBuilder().setName('join').setDescription('Join the voice channel you are in'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
    new SlashCommandBuilder()
      .setName('test')
      .setDescription('Play the sound of an announcer event')
      .addStringOption((option) =>
        option
          .setName('event')
          .setDescription('Event to play')
          .setRequired(true)
          .addChoices(...soundKeys.slice(0, MAX_CHOICES).map((key) => ({ name: key, value: key }))),
      ),
    new SlashCommandBuilder().setName('status').setDescription('GSI connection, current match and kills'),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('What to play on kills: sounds, AI commentator, or both')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Announcer mode')
          .setRequired(true)
          .addChoices(...ANNOUNCER_MODES.map((mode) => ({ name: `${mode} (${MODE_LABELS[mode]})`, value: mode }))),
      ),
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Say a phrase with the commentator voice')
      .addStringOption((option) =>
        option.setName('text').setDescription('What to say').setRequired(true).setMaxLength(MAX_SAY_LENGTH),
      ),
    new SlashCommandBuilder()
      .setName('analyze')
      .setDescription('Match analysis: who lost it (on a loss) or the MVP (on a win)')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Match ID (default: your last match)').setMaxLength(20),
      )
      .addStringOption((option) =>
        option
          .setName('tone')
          .setDescription('How harsh')
          .addChoices(...ANALYSIS_TONES.map((tone) => ({ name: TONE_LABELS[tone], value: tone }))),
      )
      .addStringOption((option) =>
        option
          .setName('team')
          .setDescription('Your team, if the bot cannot tell (private profile)')
          .addChoices({ name: 'Radiant', value: 'radiant' }, { name: 'Dire', value: 'dire' }),
      ),
    new SlashCommandBuilder()
      .setName('autoanalyze')
      .setDescription('Automatic analysis after every match: blame on a loss, MVP on a win')
      .addStringOption((option) =>
        option
          .setName('state')
          .setDescription('on or off (empty: show current)')
          .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
      ),
  ].map((command) => command.toJSON());
}

/** Guild commands update instantly, unlike global ones. */
export async function registerGuildCommands(token: string, clientId: string, guildId: string, soundKeys: readonly SoundKey[]): Promise<number> {
  const rest = new REST().setToken(token);
  const body = buildCommands(soundKeys);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  return body.length;
}

export interface CommandContext {
  joinChannel(member: GuildMember): Promise<string>;
  leave(): boolean;
  test(sound: SoundKey): 'queued' | 'no-file' | 'not-connected';
  getMode(): AnnouncerMode;
  /** false when the mode needs a commentator that is not configured. */
  setMode(mode: AnnouncerMode): boolean;
  say(text: string): Promise<'queued' | 'failed' | 'unavailable' | 'not-connected'>;
  analyze(options: {
    matchId: string | null;
    tone: AnalysisTone | null;
    team: 'radiant' | 'dire' | null;
  }): Promise<AnalyzeOutcome>;
  getAutoAnalyze(): boolean;
  setAutoAnalyze(on: boolean): void;
  status(): Readonly<StatusSnapshot>;
  voiceChannelId(): string | null;
  now(): number;
}

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

export async function handleCommand(interaction: ChatInputCommandInteraction<'cached'>, ctx: CommandContext): Promise<void> {
  switch (interaction.commandName) {
    case 'join': {
      const channel = interaction.member.voice.channel;
      if (!channel) {
        await interaction.reply({ content: 'Join a voice channel first, then run /join.', ...ephemeral });
        return;
      }
      if (channel.type === ChannelType.GuildStageVoice) {
        await interaction.reply({ content: 'Stage channels are not supported.', ...ephemeral });
        return;
      }
      const perms = channel.permissionsFor(interaction.guild.members.me ?? interaction.client.user);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        await interaction.reply({ content: `I need View Channel, Connect and Speak permissions in ${channel}.`, ...ephemeral });
        return;
      }
      await interaction.deferReply(ephemeral);
      try {
        const name = await ctx.joinChannel(interaction.member);
        await interaction.editReply(`Joined **${name}**. I will announce your kills here.`);
      } catch (err) {
        await interaction.editReply(`Could not join: ${(err as Error).message}`);
      }
      return;
    }

    case 'leave': {
      const left = ctx.leave();
      await interaction.reply({ content: left ? 'Left the voice channel.' : 'I am not in a voice channel.', ...ephemeral });
      return;
    }

    case 'test': {
      const sound = interaction.options.getString('event', true);
      const result = ctx.test(sound);
      const content = {
        queued: `Playing **${sound}**.`,
        'no-file': `No sound file configured for **${sound}**. Check sounds.config.json.`,
        'not-connected': 'I am not in a voice channel. Use /join first.',
      }[result];
      await interaction.reply({ content, ...ephemeral });
      return;
    }

    case 'status': {
      const content = formatStatus(ctx.status(), ctx.voiceChannelId(), ctx.now(), ctx.getMode());
      await interaction.reply({ content, ...ephemeral });
      return;
    }

    case 'mode': {
      const mode = interaction.options.getString('mode', true) as AnnouncerMode;
      const content = ctx.setMode(mode)
        ? `Режим: **${MODE_LABELS[mode]}**.`
        : 'Коментатор не налаштований: додай `ELEVENLABS_API_KEY` у `.env` і перезапусти бота.';
      await interaction.reply({ content, ...ephemeral });
      return;
    }

    case 'say': {
      const text = interaction.options.getString('text', true).slice(0, MAX_SAY_LENGTH);
      await interaction.deferReply(ephemeral);
      const result = await ctx.say(text);
      const content = {
        queued: 'Говорю.',
        failed: 'Не вийшло озвучити: подивись лог бота (ElevenLabs недоступний або скінчився ліміт).',
        unavailable: 'Голос не налаштований: додай `ELEVENLABS_API_KEY` у `.env` і перезапусти бота.',
        'not-connected': 'Я не в голосовому каналі. Спершу /join.',
      }[result];
      await interaction.editReply(content);
      return;
    }

    case 'analyze': {
      // Public reply: the analysis is for everyone in the channel. Parsing can take a few minutes.
      await interaction.deferReply();
      const outcome = await ctx.analyze({
        matchId: interaction.options.getString('match_id')?.trim() || null,
        tone: (interaction.options.getString('tone') as AnalysisTone | null) ?? null,
        team: (interaction.options.getString('team') as 'radiant' | 'dire' | null) ?? null,
      });
      await interaction.editReply(clampMessage(formatAnalyzeOutcome(outcome)));
      return;
    }

    case 'autoanalyze': {
      const state = interaction.options.getString('state');
      if (state) ctx.setAutoAnalyze(state === 'on');
      const on = ctx.getAutoAnalyze();
      await interaction.reply({
        content: `Автоматичний розбір після матчу: **${on ? 'увімкнено' : 'вимкнено'}**.`,
        ...ephemeral,
      });
      return;
    }

    default:
      await interaction.reply({ content: 'Unknown command.', ...ephemeral });
  }
}

export function formatAnalyzeOutcome(outcome: AnalyzeOutcome): string {
  switch (outcome.kind) {
    case 'ok':
      return outcome.chatText;
    case 'not-found':
      return 'OpenDota не має цього матчу. Ігри з ботами й лобі туди не потрапляють; для свіжого матчу спробуй за кілька хвилин.';
    case 'unknown-team':
      return 'Не можу визначити, за яку команду ти грав (приватний профіль?). Вкажи `team:` у команді.';
    case 'no-match':
      return 'Не знаю, який матч розбирати: вкажи `match_id` або зіграй матч із запущеним ботом.';
    case 'busy':
      return 'Вже розбираю інший матч, зачекай хвилинку.';
    case 'error':
      return `Не вийшло: ${outcome.message}`;
  }
}

/** GSI is considered alive if anything arrived within two heartbeats (heartbeat = 30s). */
const GSI_STALE_MS = 65_000;

export function formatStatus(s: Readonly<StatusSnapshot>, voiceChannelId: string | null, now: number, mode?: AnnouncerMode): string {
  const lines: string[] = [];

  if (s.lastGsiAt === null) {
    lines.push('**GSI:** 🔴 no data received yet. Is Dota running with `-gamestateintegration` and the .cfg installed?');
  } else {
    const ago = Math.round((now - s.lastGsiAt) / 1000);
    const icon = now - s.lastGsiAt <= GSI_STALE_MS ? '🟢' : '🟠';
    lines.push(`**GSI:** ${icon} last update ${ago}s ago (${s.payloadCount} total)`);
  }

  if (s.matchId) {
    const playing = s.activity === 'playing';
    lines.push(`**Match:** \`${s.matchId}\` · ${shortState(s.gameState)}${playing ? '' : ' · spectating / not playing'}`);
    if (playing) {
      const hero = s.hero ? s.hero.replace('npc_dota_hero_', '') : 'unknown hero';
      lines.push(`**You:** ${hero} · K/D ${s.kills ?? '?'} / ${s.deaths ?? '?'} · streak ${s.killStreak ?? 0}`);
    }
  } else if (s.lastGsiAt !== null) {
    lines.push('**Match:** not in a match');
  }

  if (s.lastEvent) {
    lines.push(`**Last announcement:** ${describeEvent(s.lastEvent.event)}, ${Math.round((now - s.lastEvent.at) / 1000)}s ago`);
  }

  lines.push(`**Voice:** ${voiceChannelId ? `<#${voiceChannelId}>` : 'not connected (use /join)'}`);
  if (mode) lines.push(`**Mode:** ${MODE_LABELS[mode]}`);
  return lines.join('\n');
}

function shortState(state: string | null): string {
  return state ? state.replace('DOTA_GAMERULES_STATE_', '').toLowerCase().replaceAll('_', ' ') : 'unknown state';
}
