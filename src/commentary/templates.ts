import type { Random } from '../audio/sound-picker.js';
import type { KillContext } from './context.js';
import type { CommentaryWriter } from './writer.js';

/** `{hero}` is replaced by the player's hero, or "наш герой" when unknown. */
const LINES = {
  kill: [
    '{hero} знову когось обнулив, ну шо, мінус один.',
    'Ще один ворог пішов думати над своєю поведінкою.',
    'Акуратненько, {hero}, чисто як у підручнику.',
    'Бідолаха навіть не зрозумів, шо сталось.',
    'О, фраг! {hero} сьогодні в ударі.',
  ],
  multikill: [
    'Шо там відбувається? {hero} косить їх пачками!',
    'Вороги падають, як креки на лайні. Мультикіл!',
    '{hero}, ну це вже просто знущання, хлопці.',
    'Хтось там, здається, рахує респавни. Мультикіл від {hero}!',
  ],
  streak: [
    '{hero} не вмирає вже стільки, шо вороги пишуть скаргу.',
    'Серія росте, а тімейти тільки фармлять асисти.',
    'Хто-небудь, зупиніть {hero}, бо це вже не смішно.',
  ],
  postmortem: [
    '{hero} вбив його вже з таверни. Оце характер!',
    'Помер, але встиг забрати з собою. Респект.',
  ],
  lowHp: [
    '{hero} на ниточці HP, але кіл забрав. Нерви сталеві.',
    'З таким HP взагалі не грають, а {hero} ще й фрагає.',
  ],
  techies: [
    'Бум! Хтось знову не подивився під ноги.',
    'Техіс нічого не нажимав, а ворог помер. Міна сама все зробила.',
  ],
  death: [
    'Ну шо, {hero}, таверна чекає. Подумай над життям.',
    '{hero} пішов на перерву. Не дуже добровільно.',
    'Хтось тут переоцінив свої сили.',
  ],
} as const satisfies Record<string, readonly string[]>;

/** Offline lines: no API key needed, used as default and as a fallback when the model fails. */
export class TemplateWriter implements CommentaryWriter {
  readonly name = 'templates';

  constructor(private readonly random: Random = Math.random) {}

  async write(ctx: KillContext): Promise<string> {
    const pool = this.poolFor(ctx);
    const line = pool[Math.floor(this.random() * pool.length)] ?? pool[0]!;
    return line.replaceAll('{hero}', ctx.hero ?? 'наш герой');
  }

  private poolFor(ctx: KillContext): readonly string[] {
    const { event } = ctx;
    if (event.kind === 'death') return LINES.death;
    if (ctx.alive === false) return LINES.postmortem;
    if (ctx.hero === 'Techies' && ctx.recentCasts.length === 0) return LINES.techies;
    if (ctx.healthPercent !== null && ctx.healthPercent <= 15) return LINES.lowHp;
    if (event.kind === 'multikill') return LINES.multikill;
    if (event.kind === 'streak') return LINES.streak;
    return LINES.kill;
  }
}
