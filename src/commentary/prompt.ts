import type { KillContext } from './context.js';

export const SYSTEM_PROMPT = `Ти — дотепний і трохи токсичний коментатор Dota 2, який сидить у Discord-каналі з друзями гравця.
Говориш суржиком: українська з домішкою російських слівець і геймерського сленгу, як у звичайному войсі.

Правила:
- Одне коротке речення, максимум 20 слів. Його прочитає синтезатор голосу, тому без емодзі, хештегів і дужок.
- Жартуй саме про цю ситуацію з даних: герой гравця, спели і предмети, мультикіл, серія, кіл після смерті, мало HP, той самий бідолаха вже вкотре.
- Використовуй знання Dota: що роблять герої та їхні спели. Наприклад, Techies без касту перед кілом найімовірніше підірвав когось на міні.
- Згадуй лише ті спели й предмети, що є в рядку «Щойно використав». Якщо там нічого немає, не вигадуй ульту чи скіл, жартуй про інше.
- Не приписуй героєві чужих здібностей: якщо не впевнений, що спел належить цьому героєві, не згадуй його.
- Героя жертви в даних немає. Не вигадуй, кого саме вбито; кажи «бідолаха», «ворог», «той тип».
- Підколюй по-дружньому, як друг у войсі, а не ображай: без матів, без образ за зовнішністю, віком, національністю, статтю чи іншими ознаками.
- Відповідай лише самою фразою, без лапок і пояснень.`;

const EVENT_LABELS = {
  kill: 'вбивство',
  multikill: { 2: 'подвійне вбивство (double kill)', 3: 'потрійне вбивство (triple kill)', 4: 'ultra kill', 5: 'RAMPAGE' },
  death: 'гравець помер',
} as const;

export function describeForPrompt(ctx: KillContext): string {
  const { event } = ctx;
  const lines: string[] = [];

  switch (event.kind) {
    case 'kill':
      lines.push(`Подія: ${EVENT_LABELS.kill}`);
      break;
    case 'multikill':
      lines.push(`Подія: ${EVENT_LABELS.multikill[event.count]}`);
      break;
    case 'streak':
      lines.push(`Подія: серія з ${event.streak} кілів без смерті (${event.sound.replaceAll('_', ' ')})`);
      break;
    case 'death':
      lines.push(`Подія: ${EVENT_LABELS.death}`);
      break;
  }

  if (ctx.hero) lines.push(`Герой гравця: ${ctx.hero}${ctx.heroLevel !== null ? `, рівень ${ctx.heroLevel}` : ''}`);
  if (ctx.kills !== null) lines.push(`Рахунок K/D/A: ${ctx.kills}/${ctx.deaths ?? '?'}/${ctx.assists ?? '?'}`);
  if (ctx.killStreak) lines.push(`Поточна серія кілів: ${ctx.killStreak}`);
  if (ctx.gameTimeSec !== null) lines.push(`Час гри: ${formatClock(ctx.gameTimeSec)}`);

  if (event.kind !== 'death') {
    if (ctx.alive === false) lines.push('Гравець у момент кіла вже МЕРТВИЙ (вбив посмертно).');
    else if (ctx.healthPercent !== null && ctx.healthPercent <= 15) lines.push(`У гравця лишилось лише ${ctx.healthPercent}% HP.`);

    lines.push(
      ctx.recentCasts.length > 0
        ? `Щойно використав: ${ctx.recentCasts.join(', ')}`
        : 'Перед кілом нічого не кастував (атака руками, пасивка, міна чи щось подібне).',
    );

    for (const victim of ctx.victims) {
      if (victim.timesKilled >= 2) lines.push(`Цього ж ворога гравець убиває вже ${victim.timesKilled}-й раз за матч.`);
    }
  }

  return lines.join('\n');
}

function formatClock(totalSec: number): string {
  const sign = totalSec < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(totalSec));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

/** Normalises model output into one speakable line. */
export function cleanLine(text: string, maxLength = 220): string {
  let line = text.replace(/\s+/g, ' ').trim();
  line = line.replace(/^["'«„“]+|["'»”“]+$/g, '').trim();
  if (line.length > maxLength) {
    const cut = line.slice(0, maxLength);
    const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    line = lastStop > maxLength / 2 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  }
  return line;
}
