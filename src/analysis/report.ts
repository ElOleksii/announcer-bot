import { CATEGORY_LABELS, type BlameReport, type PlayerBlame } from './blame.js';
import type { Confidence } from './confidence.js';
import type { DraftOutlook } from './draft.js';
import type { KeyFight } from './keyfight.js';
import type { CategoryScore } from './scoring.js';
import { MVP_CATEGORY_LABELS, MVP_SHARE_GAP, type MvpReport, type PlayerContribution } from './mvp.js';

export const ANALYSIS_TONES = ['harsh', 'light'] as const;
export type AnalysisTone = (typeof ANALYSIS_TONES)[number];

/** Verdict length in the chat message (a short paragraph). */
export const VERDICT_MAX_LENGTH = 600;

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * "бійки 3.7/10, фарм 2.1/10": every area on the same 0–10 scale, highest first. (Points out of
 * the role weight would give each area a different maximum; the weights live in the total.)
 */
function areaList(categories: CategoryScore[], labels: Record<string, string>): string {
  return categories
    .filter((c) => c.available && c.points > 0)
    .sort((a, b) => b.outOfTen - a.outOfTen || b.points - a.points)
    .map((c) => `${labels[c.key]} ${c.outOfTen}/10`)
    .join(', ');
}

/** "орієнтовно 46% на перемогу (сила героїв у цьому ранзі та матчапи)" — context only, never blame. */
function draftText(draft: DraftOutlook | null): string | null {
  if (!draft) return null;
  const basis = draft.matchupEdge === null ? 'сила героїв у цьому ранзі' : 'сила героїв у цьому ранзі та матчапи';
  return `орієнтовно ${Math.round(draft.expected * 100)}% на перемогу (${basis})`;
}

/** "⚔️ Ключовий файт на 23:10: −4190 золота, наших загинуло 3, їхніх 0; першим упав наш Pangolier". */
function keyFightText(fight: KeyFight | null): string | null {
  if (!fight) return null;
  const at = `на ${mmss(fight.start)}`;
  if (fight.goldSwing < 0) {
    const first = fight.standout ? `; першим упав наш ${fight.standout.hero}` : '';
    return `${at}: −${-fight.goldSwing} золота, наших загинуло ${fight.ourDeaths}, їхніх ${fight.theirDeaths}${first}`;
  }
  const top = fight.standout ? `; найбільше урону — наш ${fight.standout.hero} (${fight.standout.damage})` : '';
  return `${at}: +${fight.goldSwing} золота, їхніх загинуло ${fight.theirDeaths}, наших ${fight.ourDeaths}${top}`;
}

/** Lines under the verdict that tell how much to trust it and what decided the game. */
function contextLines(report: { parsed: boolean; draft: DraftOutlook | null; confidence: Confidence; keyFight: KeyFight | null }): string[] {
  const lines: string[] = [];
  if (!report.parsed) lines.push('_⚠️ OpenDota ще не розібрав запис: лайн і частину виживання не враховано._');
  else if (report.confidence.level !== 'high') {
    const level = report.confidence.level === 'medium' ? 'середня' : 'низька';
    lines.push(`📊 Впевненість ${level}: дані є лише для ${Math.round(report.confidence.coverage * 100)}% оцінки.`);
  }
  const fight = keyFightText(report.keyFight);
  if (fight) lines.push(`⚔️ Ключовий файт ${fight}`);
  const draft = draftText(report.draft);
  if (draft) lines.push(`🧩 Драфт: ${draft}`);
  return lines;
}

/** The same context for the model, in plain sentences. */
function contextFacts(report: { parsed: boolean; draft: DraftOutlook | null; keyFight: KeyFight | null }): string[] {
  const lines: string[] = [];
  if (!report.parsed) lines.push('Детальних даних немає, лише базова статистика.');
  const fight = keyFightText(report.keyFight);
  if (fight) lines.push(`Ключовий файт ${fight}.`);
  const draft = draftText(report.draft);
  if (draft) lines.push(`Драфт (лише контекст, не вина): ${draft}.`);
  return lines;
}

function culprit(report: BlameReport): PlayerBlame | null {
  const { verdict } = report;
  return verdict.kind === 'culprit' ? (report.players.find((p) => p.slot === verdict.slot) ?? null) : null;
}

/** Markdown for the Discord chat: verdict + every player's points and facts. */
export function formatChatReport(report: BlameReport, verdictText?: string): string {
  const lines: string[] = [];
  lines.push(`**Розбір поразки** · матч \`${report.matchId}\` · ${mmss(report.durationSec)} · ${report.ourTeam === 'radiant' ? 'Radiant' : 'Dire'}`);

  const main = culprit(report);
  if (main) lines.push(`🎯 **Головний винний: ${main.hero}** (${main.score} балів)`);
  else if (report.verdict.kind === 'team' && report.verdict.reason === 'behind-everywhere') {
    lines.push('🤝 **Винні всі:** на 10-й хвилині програли кожну лінію.');
  } else if (report.verdict.kind === 'team' && report.verdict.reason === 'not-enough-data') {
    lines.push('🤝 **Поки без головного винного:** даних замало, щоб когось виділити.');
  } else lines.push('🤝 **Винні всі:** явного лідера за балами немає.');

  lines.push(...contextLines(report));
  if (verdictText) lines.push(`> ${verdictText}`);

  lines.push('```');
  for (const p of report.players) {
    const cats = areaList(p.categories, CATEGORY_LABELS);
    lines.push(`${String(p.score).padStart(3)}  pos${p.position} ${p.hero}${cats ? ` — ${cats}` : ''}`);
    for (const fact of p.evidence) lines.push(`       • ${fact}`);
    if (p.mitigations.length) lines.push(`       + ${p.mitigations.join(', ')}`);
  }
  lines.push('```');
  return lines.join('\n');
}


export function verdictSystemPrompt(tone: AnalysisTone): string {
  const style =
    tone === 'harsh'
      ? 'Тон жорсткий і саркастичний, без пом’якшень і компліментів, але критикуй гру, а не людину.'
      : 'Тон легкий і дружній, з гумором, без зайвої жорсткості.';
  return `Ти — аналітик Dota 2, який після поразки пише в Discord-чат команді, хто винен.
Говориш суржиком: українська з домішкою російських слівець і геймерського сленгу.
${style}

Правила:
- Вина вже порахована: не змінюй вердикт і не переставляй місця. Твоя задача — лише гарно це сказати.
- Використовуй ТІЛЬКИ факти й цифри з даних. Нічого не вигадуй: ні подій, ні предметів, ні спелів.
- Гравців називай лише героями («наш Pudge»), позиції можна згадувати.
- Спершу вердикт, потім 2 конкретні причини з цифрами, наприкінці коротко про 2-го і 3-го.
- Без матів і без образ за зовнішністю, віком, національністю, статтю чи іншими ознаками.
- Один абзац до 90 слів, без списків і заголовків: під ним у чаті вже буде таблиця з балами.`;
}

/** Facts for the model; the same numbers as in the chat report. */
export function verdictUserPrompt(report: BlameReport): string {
  const lines: string[] = [];
  const main = culprit(report);
  lines.push(`Поразка, гра тривала ${mmss(report.durationSec)}.`);
  if (main) lines.push(`Вердикт: головний винний — ${main.hero} (позиція ${main.position}), ${main.score} штрафних балів зі 100.`);
  else if (report.verdict.kind === 'team' && report.verdict.reason === 'behind-everywhere') {
    lines.push('Вердикт: винна вся команда — на 10-й хвилині програли кожну лінію.');
  } else if (report.verdict.kind === 'team' && report.verdict.reason === 'not-enough-data') {
    lines.push('Вердикт: головного винного не названо — даних замало, щоб когось виділити.');
  } else lines.push('Вердикт: винна вся команда — немає гравця, який явно гірший за інших.');
  lines.push(...contextFacts(report));

  report.players.slice(0, 3).forEach((p, i) => {
    lines.push(`${i + 1}. ${p.hero}, позиція ${p.position}, ${p.score} балів.`);
    if (p.evidence.length) lines.push(`   Факти: ${p.evidence.join('; ')}.`);
    if (p.mitigations.length) lines.push(`   Пом’якшення: ${p.mitigations.join(', ')}.`);
  });
  return lines.join('\n');
}

/** Verdict without AI, used when Gemini is not configured or fails. */
export function fallbackVerdict(report: BlameReport, tone: AnalysisTone): string {
  const main = culprit(report);
  const parts: string[] = [];
  if (main) {
    parts.push(
      tone === 'harsh'
        ? `Ну шо, розбір поразки. Головний винний — наш ${main.hero}, ${main.score} балів зі ста.`
        : `Розбір поразки. Найбільше балів набрав наш ${main.hero}: ${main.score} зі ста.`,
    );
    if (main.evidence.length) parts.push(`${capitalize(main.evidence.slice(0, 2).join(', а ще '))}.`);
  } else if (report.verdict.kind === 'team' && report.verdict.reason === 'behind-everywhere') {
    parts.push('Розбір поразки. Тут винні всі: на десятій хвилині програли кожну лінію.');
  } else if (report.verdict.kind === 'team' && report.verdict.reason === 'not-enough-data') {
    parts.push('Розбір поразки. Даних поки замало, тож головного винного не називаю.');
  } else {
    parts.push(tone === 'harsh' ? 'Розбір поразки. Явного винного нема, злили всі разом, красавчики.' : 'Розбір поразки. Явного винного нема, програли командою.');
  }
  const others = report.players.filter((p) => p.slot !== main?.slot).slice(0, 2);
  if (others.length) parts.push(`Далі за балами: ${others.map((p) => `${p.hero} — ${p.score}`).join(', ')}.`);
  return parts.join(' ');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Win: MVP -------------------------------------------------------------------

function mvps(report: MvpReport): PlayerContribution[] {
  return report.mvpSlots.map((slot) => report.players.find((p) => p.slot === slot)).filter((p): p is PlayerContribution => !!p);
}

/** Markdown for the Discord chat: MVP + every player's contribution points and facts. */
export function formatMvpChat(report: MvpReport, verdictText?: string): string {
  const lines: string[] = [];
  lines.push(`**Розбір перемоги** · матч \`${report.matchId}\` · ${mmss(report.durationSec)} · ${report.ourTeam === 'radiant' ? 'Radiant' : 'Dire'}`);
  const top = mvps(report);
  if (top.length === 2) lines.push(`🏆 **MVP: ${top[0]!.hero} і ${top[1]!.hero}** (${top[0]!.score} і ${top[1]!.score} балів, різниця менше ${MVP_SHARE_GAP})`);
  else if (top[0]) lines.push(`🏆 **MVP: ${top[0].hero}** (${top[0].score} балів)`);
  lines.push(...contextLines(report));
  if (verdictText) lines.push(`> ${verdictText}`);

  lines.push('```');
  for (const p of report.players) {
    const cats = areaList(p.categories, MVP_CATEGORY_LABELS);
    lines.push(`${String(p.score).padStart(3)}  pos${p.position} ${p.hero}${cats ? ` — ${cats}` : ''}`);
    for (const fact of p.evidence) lines.push(`       • ${fact}`);
    if (p.modifiers.length) lines.push(`       − ${p.modifiers.join(', ')}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export function mvpSystemPrompt(tone: AnalysisTone): string {
  const style =
    tone === 'harsh'
      ? 'Тон зухвалий: щедро хвали MVP, а решту можеш по-дружньому підколоти за скромний внесок. Критикуй гру, а не людину.'
      : 'Тон легкий і святковий: хвали MVP і коротко віддай належне іншим.';
  return `Ти — аналітик Dota 2, який після перемоги пише в Discord-чат команді, хто найбільше її витягнув.
Говориш суржиком: українська з домішкою російських слівець і геймерського сленгу.
${style}

Правила:
- MVP і бали вже пораховані: не змінюй їх і не переставляй місця. Твоя задача — лише гарно це сказати.
- Використовуй ТІЛЬКИ факти й цифри з даних. Нічого не вигадуй: ні подій, ні предметів, ні спелів.
- Гравців називай лише героями («наш Pudge»), позиції можна згадувати.
- Спершу MVP і 2 конкретні причини з цифрами, наприкінці коротко про 2-го і 3-го.
- Без матів, прізвиськ і образ за зовнішністю, віком, національністю, статтю чи іншими ознаками.
- Один абзац до 90 слів, без списків і заголовків: під ним у чаті вже буде таблиця з балами.`;
}

export function mvpUserPrompt(report: MvpReport): string {
  const lines: string[] = [`Перемога, гра тривала ${mmss(report.durationSec)}.`];
  const top = mvps(report);
  if (top.length === 2) lines.push(`MVP ділять двоє: ${top[0]!.hero} (${top[0]!.score}) і ${top[1]!.hero} (${top[1]!.score}) — різниця менше ${MVP_SHARE_GAP} балів.`);
  else if (top[0]) lines.push(`MVP — ${top[0].hero} (позиція ${top[0].position}), ${top[0].score} балів внеску зі 100.`);
  lines.push(...contextFacts(report));
  report.players.slice(0, 3).forEach((p, i) => {
    lines.push(`${i + 1}. ${p.hero}, позиція ${p.position}, ${p.score} балів.`);
    if (p.evidence.length) lines.push(`   Факти: ${p.evidence.join('; ')}.`);
    if (p.modifiers.length) lines.push(`   Мінуси: ${p.modifiers.join(', ')}.`);
  });
  return lines.join('\n');
}

/** Verdict without AI, used when Gemini is not configured or fails. */
export function fallbackMvpVerdict(report: MvpReport, tone: AnalysisTone): string {
  const top = mvps(report);
  const parts: string[] = [];
  if (top.length === 2) {
    parts.push(`Розбір перемоги. MVP ділять наш ${top[0]!.hero} і наш ${top[1]!.hero}: ${top[0]!.score} і ${top[1]!.score} балів.`);
  } else if (top[0]) {
    parts.push(
      tone === 'harsh'
        ? `Розбір перемоги. Гру витягнув наш ${top[0].hero}: ${top[0].score} балів зі ста, решта просто не заважали.`
        : `Розбір перемоги. MVP — наш ${top[0].hero}, ${top[0].score} балів зі ста.`,
    );
    if (top[0].evidence.length) parts.push(`${capitalize(top[0].evidence.slice(0, 2).join(', а ще '))}.`);
  }
  const others = report.players.filter((p) => !report.mvpSlots.includes(p.slot)).slice(0, 2);
  if (others.length) parts.push(`Далі за внеском: ${others.map((p) => `${p.hero} — ${p.score}`).join(', ')}.`);
  return parts.join(' ');
}
