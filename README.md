# Dota 2 Kill Announcer

Discord-бот, який озвучує твої кіли в Dota 2 у голосовому каналі, де ти сидиш з друзями.

Стан гри застосунок бере **лише** з офіційного [Game State Integration](https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive_Game_State_Integration) (GSI). Dota сама надсилає JSON на `http://127.0.0.1:<порт>/`. Жодного читання пам'яті, парсингу демо чи втручання в клієнт гри.

```
Dota 2 ──GSI POST──▶ 127.0.0.1:3000 ──▶ KillTracker ──▶ черга звуків ──▶ Discord voice
                                                                      └─▶ або динаміки ПК (local)
```

## Вимоги

- Node.js 22 LTS або новіший.
- Windows або Linux. macOS теж працює в режимі `local`.
- ffmpeg окремо ставити не треба: його приносить пакет `ffmpeg-static`.

## 1. Встановлення

```bash
npm install
```

```bash
cp .env.example .env
```

На Windows у PowerShell замість `cp` виконай `Copy-Item .env.example .env`.

Згенеруй `GSI_TOKEN` і впиши його в `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

## 2. Створення бота в Discord Developer Portal

1. Відкрий <https://discord.com/developers/applications> → **New Application** і дай йому назву.
2. На вкладці **General Information** скопіюй **Application ID** у `DISCORD_CLIENT_ID`.
3. На вкладці **Bot** натисни **Reset Token** і скопіюй токен у `DISCORD_TOKEN`.
   - Токен — це пароль бота. Не коміть його і нікому не показуй. Застосунок ніколи не пише його в логи.
   - **Privileged Gateway Intents** вмикати не треба: боту вистачає `Guilds` і `GuildVoiceStates`.
4. Запроси бота на свій сервер. Підстав свій Application ID у посилання:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=3146752
   ```

   Це скоупи `bot` і `applications.commands` з правами **View Channels**, **Connect** і **Speak**. Більше нічого не потрібно.
   Те саме посилання можна зібрати в розділі **OAuth2 → URL Generator**.
5. Візьми ID сервера для `GUILD_ID`. У Discord: **User Settings → Advanced → Developer Mode**, потім ПКМ по серверу → **Copy Server ID**.

Slash-команди реєструються саме на цьому сервері під час кожного запуску, тож зміни з'являються одразу.

## 3. Підключення GSI до Dota 2

### 3.1. Згенеруй cfg

```bash
npm run gen:cfg
```

Команда створює `gamestate_integration_killannouncer.cfg` з твоїми `GSI_PORT` і `GSI_TOKEN`. Файл містить токен, тому він у `.gitignore`.

### 3.2. Поклади cfg у теку Dota

Теку `gamestate_integration` створи, якщо її ще немає.

| ОС | Шлях |
|---|---|
| Windows | `C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration\` |
| Linux | `~/.local/share/Steam/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/` (те саме, що `~/.steam/steam/...`) |
| Linux (Flatpak Steam) | `~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/` |

Якщо Dota стоїть в іншій бібліотеці Steam: у Steam ПКМ по Dota 2 → **Manage → Browse local files**, далі `game\dota\cfg\gamestate_integration`.

Можна одразу записати файл у потрібну теку:

```bash
npm run gen:cfg -- "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration"
```

### 3.3. Додай параметр запуску

У Steam: ПКМ по Dota 2 → **Properties → General → Launch Options**, допиши:

```
-gamestateintegration
```

Без цього параметра Dota не читає GSI-конфіги. Після змін cfg Dota треба перезапустити.

## 4. Запуск

Для розробки, з автоперезапуском:

```bash
npm run dev
```

Або продакшн-збірка:

```bash
npm run build
```

```bash
npm start
```

Запускай з кореня проєкту: `.env` і `sounds.config.json` шукаються в поточній теці.

Далі в Discord:

1. Зайди в голосовий канал.
2. Виконай `/join`. Бот зайде до тебе.
3. `/test event:double_kill` перевіряє, що звук іде.
4. Запусти Dota і виконай `/status`. Там видно, чи приходять GSI-дані, поточний матч і K/D.

| Команда | Що робить |
|---|---|
| `/join` | бот заходить у твій поточний войс-канал |
| `/leave` | бот виходить |
| `/test <event>` | програє звук події |
| `/status` | чи приходить GSI, матч, герой, K/D, серія, останнє оголошення, войс |
| `/mode` | що грати на кіл: звуки, коментатор чи обидва |
| `/say <текст>` | сказати фразу голосом коментатора |
| `/analyze [match_id] [tone] [team]` | розбір матчу: хто винен у поразці або хто MVP перемоги (за замовчуванням — твій останній матч) |
| `/autoanalyze [on\|off]` | увімкнути чи вимкнути автоматичний розбір після кожного матчу |

Якщо зв'язок з голосом обривається, бот перепідключається сам: до 5 спроб із наростаючою паузою. Якщо бота кікнули з каналу, він не повертається, поки не виконаєш `/join`.

## 5. Тест без гри

Поки застосунок запущений, в іншому терміналі виконай:

```bash
npm run simulate
```

Без аргументів команда показує список сценаріїв. Запустити один:

```bash
npm run simulate -- double
```

Прогнати всі:

```bash
npm run simulate -- all --delay 2500
```

Сценарії: `kill`, `double`, `rampage`, `jump2`, `jump3`, `streak`, `death`, `new-match`, `reconnect`, `postgame`, `spectate`, `bad-token`, `invalid`. Кожен сценарій починає новий матч, тому перший запит у ньому завжди тихий.

## Режим local

Щоб звук грав на твоєму ПК без Discord, впиши в `.env`:

```
PLAYBACK_MODE=local
```

Тоді `DISCORD_*` не потрібні, і Discord-модуль не ініціалізується. Звук грає перший знайдений програвач:

1. `ffplay`, якщо є в PATH (є в повних збірках FFmpeg).
2. Windows: PowerShell `System.Media.SoundPlayer`. Файл попередньо конвертується у WAV.
3. Linux: `paplay` (PulseAudio/PipeWire), інакше `aplay` (ALSA).
4. macOS: `afplay`.

## Звуки

У `sounds/` лежать тестові тони-плейсхолдери. Їх створює `npm run gen:sounds`. Свої звуки додавай за інструкцією в [sounds/README.md](sounds/README.md).

`sounds.config.json` містить:

- `volume` — загальна гучність. Кожному файлу можна задати свою: `{ "file": "kill.mp3", "volume": 1.5 }`, і підсумкова гучність буде добутком обох;
- `events` — для кожної події масив файлів, з якого береться випадковий;
- `streaks` — пороги `kill_streak`.

## Коментатор (AI-фрази голосом)

Замість звуку або разом із ним бот може промовляти коротку смішну фразу про кіл. Наприклад: «Техіс нічого не кастував, а ворог помер. Міна сама все зробила».

- **Хто пише фрази.** За замовчуванням це вбудовані шаблони (`COMMENTARY_TEXT=templates`). Із `COMMENTARY_TEXT=gemini` і ключем `GEMINI_API_KEY` фрази пише Gemini з урахуванням ситуації: герой, щойно використані спели й предмети, мультикіл, кіл після смерті, мало HP, той самий ворог уже вкотре.
- **Хто озвучує.** ElevenLabs (`ELEVENLABS_API_KEY`). Безкоштовний тариф підходить для некомерційного використання. Однакові фрази кешуються, тож кредити за них не витрачаються вдруге.
- **Як перемикати.** `ANNOUNCER_MODE` у `.env` або `/mode` у Discord:
  - `sounds` — лише звуки;
  - `commentator` — лише фраза, а якщо API не встиг за `COMMENTARY_TIMEOUT_MS`, грає звук;
  - `both` — спершу звук, потім фраза.
- **Перевірка голосу:** `/say текст`.

Щоб коментатор бачив твої спели й предмети, у cfg мають бути секції `abilities` та `items`. Їх додає `npm run gen:cfg`. Після оновлення cfg перезапусти Dota.

GSI не повідомляє гравцю, яким героєм грала жертва. Тому фрази можуть згадати номер її слоту чи скільки разів ти її вбив, але не її героя.

## Розбір матчу: «хто винен» і MVP

Після матчу бот бере статистику з [OpenDota](https://www.opendota.com) і пише розбір у чат (голосом він не озвучується):
- **поразка** — штрафні бали кожному гравцю твоєї команди й вердикт, хто винен;
- **перемога** — бали внеску кожного гравця й MVP.

**Як рахуються бали — коротко.** Код оцінює кожного гравця за фіксованими правилами у восьми сферах (лайн, фарм, бійки, виживання, об'єкти, підтримка, предмети, пік) з вагами залежно від позиції, а ШІ лише формулює вердикт. Головного винного називають тільки з помітним відривом за балами; інакше «винні всі». Детально — у [docs/match-analysis.md](docs/match-analysis.md): звідки дані, кожна сфера, ваги, правила вердикту, ключовий файт, впевненість, драфт і як це перевірено на реальних матчах.

**Як запускати:**
- **Автоматично.** Щойно матч закінчився, бот пише повідомлення «⏳ чекаю на дані OpenDota» і далі **редагує саме його**:
  1. коли з'являється базова статистика (кілька хвилин) — попередній розбір;
  2. коли OpenDota розбере запис гри (зазвичай 5–15 хв) — повний розбір із вердиктом Gemini.

  Поки запис не розібрано, бот повторює запит на розбір кожні 3 хв. Якщо за 20 хв запис так і не розібрано, лишається розбір за базовою статистикою. Якщо матчу в OpenDota немає 10 хв (гра з ботами, лобі), бот так і пише й припиняє чекати. Вмикається `AUTO_ANALYZE` у `.env` або `/autoanalyze on|off`.
- **Куди пише.** У канал з `ANALYSIS_CHANNEL_ID`. Якщо його не задано, то в чат голосового каналу, де сидить бот, а якщо бот не у войсі — у системний канал сервера. При старті бот пише в лог, куди поститиме розбори і чи має там право Send Messages. Те саме показує `/status`, разом зі списком матчів, які зараз розбираються.
- **Вручну.** `/analyze` розбирає твій останній матч, `/analyze match_id:123…` — будь-який. Відповідь на команду оновлюється так само, як і автоматичне повідомлення. Різні матчі розбираються незалежно, а повторний `/analyze` того самого матчу дає посилання на повідомлення, яке вже оновлюється. `tone:` задає тон: `жорстко` (за замовчуванням, `ANALYSIS_TONE`) або `лайтово`.

**Що потрібно:**
- **Текст вердикту:** `GEMINI_API_KEY`. Без нього бот використовує вбудований шаблон, і так само, якщо Gemini перевантажений.
- **Право Send Messages:** потрібне для автоматичного розбору в каналі (відповідь на `/analyze` працює й без нього). Якщо ти запрошував бота старим посиланням, перезапроси з цим (адмін сервера може зробити це поверх уже доданого бота):
  ```
  https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=3148800
  ```
- **Публічні дані матчів:** у Dota має бути увімкнено **Expose Public Match Data**, інакше OpenDota не знайде твій профіль. Тоді вкажи `team:` вручну.

**Обмеження:**
- **Ігри з ботами й приватні лобі** в OpenDota не потрапляють, їх не розібрати.
- **Нерозібраний матч.** Поки OpenDota не розібрав запис, частина оцінки недоступна, і бот про це попереджає та не називає головного винного.
- **Ліміти OpenDota.** Безкоштовно — близько 60 запитів на хвилину і 3000 на день (запит на розбір запису рахується як 10). Бот стежить за залишком і, якщо його не вистачає, чекає хвилину. Довідкові дані для розбору (близько 11 запитів уперше) він зберігає на добу в `data/cache/`. Платний ключ можна вказати в `OPENDOTA_API_KEY`, але для бота він не потрібен.

## Як визначаються події

- **Новий `matchid`**: стан повністю скидається, звуку немає.
- **Перший пейлоад матчу** лише запам'ятовує поточні кіли. Тому після реконекту посеред гри старі кіли не озвучуються.
- Застосунок реагує лише при `DOTA_GAMERULES_STATE_GAME_IN_PROGRESS` і коли `player.activity = playing`.
  - Режим глядача ігнорується.
  - До та після гри лічильники оновлюються тихо.
- **Мультикіл**: кожен наступний кіл має бути не пізніше ніж через `MULTIKILL_WINDOW_MS` (типово 18 с) після попереднього.
  - Час береться з `map.game_time`, тому пауза в грі не розриває ланцюг.
  - 2 кіли дають `double_kill`, 3 — `triple_kill`, 4 — `ultra_kill`, 5 і більше — `rampage`.
- **Стрибок на N кілів за один пейлоад** рахується як N кілів, але звучить **один** звук відповідного рівня. Наприклад, +2 дає `double_kill`, +3 дає `triple_kill`.
- **Серія**: звук грає, коли `kill_streak` досягає порогу з `streaks`. Якщо за раз перетнуто кілька порогів, береться найвищий.
- **Пріоритет**: multikill, потім streak, потім kill. За одне оновлення звучить одна подія.
- **Смерть** озвучується лише з `ANNOUNCE_DEATHS=true` і лише якщо в тому ж оновленні не було кіла.
- **Кінець матчу**: коли Dota показує результат, грає `victory` (перемога) або `defeat` (поразка). Це відбувається один раз за матч, у будь-якому режимі `/mode`. Якщо файлу для події немає, бот мовчить, а не грає `kill`. Перевірити без гри можна так: `npm run simulate -- win` або `npm run simulate -- loss`.
- **Черга** не накладає звуки один на одного. Якщо чекають більше 2 звуків, старі відкидаються.

## Налаштування `.env`

| Змінна | Типово | Опис |
|---|---|---|
| `PLAYBACK_MODE` | `discord` | `discord` або `local` |
| `DISCORD_TOKEN` | — | токен бота (лише для `discord`) |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `GUILD_ID` | — | ID сервера |
| `GSI_PORT` | `3000` | порт GSI-сервера (слухає тільки `127.0.0.1`) |
| `GSI_TOKEN` | — | спільний секрет із cfg, щонайменше 16 символів `[A-Za-z0-9_-]` |
| `MULTIKILL_WINDOW_MS` | `18000` | вікно мультикілу в мс ігрового часу |
| `ANNOUNCE_DEATHS` | `false` | озвучувати смерті |
| `SOUNDS_CONFIG` | `sounds.config.json` | шлях до конфігу звуків |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` або `silent` |
| `OPENDOTA_API_KEY` | — | платний ключ OpenDota; без нього — безкоштовний ліміт |

## Якщо щось не працює

- **`/status` показує «no data received».**
  - Перевір, що cfg лежить у `game/dota/cfg/gamestate_integration/`, а не просто в `cfg/`.
  - Перевір, що в параметрах запуску є `-gamestateintegration` і що Dota перезапущено.
  - Перевір, що порт у cfg збігається з `GSI_PORT`.
- **У логах `rejected GSI request ... auth token`.** Токен у cfg не збігається з `.env`. Виконай `npm run gen:cfg` і скопіюй cfg ще раз.
- **Бот у каналі, але звуку немає.**
  - Перевір права **Connect** і **Speak** у цьому каналі.
  - Увімкни `LOG_LEVEL=debug`: там видно `playing` і помилки ffmpeg.
  - Якщо `@discordjs/voice` скаржиться на Opus, встанови `npm install opusscript`. Для нашої схеми (ffmpeg одразу дає Ogg/Opus) він не мав би знадобитися.
- **Порт зайнятий.** Зміни `GSI_PORT` і перегенеруй cfg.

## npm-скрипти

| Скрипт | Опис |
|---|---|
| `dev` | запуск через tsx з автоперезапуском |
| `build` / `start` | компіляція в `dist/` / запуск зібраного |
| `test` | vitest |
| `typecheck` | `tsc --noEmit` |
| `simulate` | фейкові GSI-запити (`scripts/simulate-gsi.ts`) |
| `gen:cfg` | згенерувати `gamestate_integration_killannouncer.cfg` |
| `gen:sounds` | згенерувати тони-плейсхолдери (наявні файли не перезаписує) |
| `collect` / `calibrate` / `fit-weights` | зібрати рейтингові матчі з OpenDota й перевірити на них бали та ваги розбору; див. [docs/match-analysis.md](docs/match-analysis.md#перевірка-на-даних) |

## Структура

```
src/
  config/   env.ts (zod-схема .env), sounds.ts (sounds.config.json)
  gsi/      schema.ts (zod-схема пейлоаду), server.ts (Fastify), cfg.ts
  game/     kill-tracker.ts (чиста логіка без I/O), events.ts
  audio/    playback-queue.ts, sound-picker.ts, ffmpeg.ts, local-player.ts
  discord/  client.ts, commands.ts, voice.ts
  index.ts  збирає все разом
scripts/    simulate-gsi.ts, gen-cfg.ts, gen-placeholders.ts
test/       unit-тести та GSI-фікстури
docs/       match-analysis.md (як працює розбір матчу)
```
