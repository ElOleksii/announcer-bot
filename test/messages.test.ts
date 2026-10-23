import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { computeMvp } from '../src/analysis/mvp.js';
import { matchSchema, type HeroInfo } from '../src/analysis/opendota.js';
import { formatMvpChat } from '../src/analysis/report.js';
import { interactionSink } from '../src/discord/commands.js';
import { MAX_MESSAGE, splitMessage, syncMessages, type EditableMessage } from '../src/discord/messages.js';

const FENCE = '```';
const fences = (text: string) => text.split('\n').filter((l) => l.trimStart().startsWith(FENCE)).length;
/** The text lines of the parts in order, without code fences (the splitter adds fences at cuts). */
const textLines = (parts: string[]) =>
  parts
    .join('\n')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith(FENCE));

describe('splitMessage', () => {
  it('leaves a message that fits alone', () => {
    expect(splitMessage('short')).toEqual(['short']);
  });

  it('splits at lines, keeps every part within the limit and every code block closed', () => {
    const text = `header\n${FENCE}\n${Array.from({ length: 300 }, (_, i) => `рядок ${i} з фактами`).join('\n')}\n${FENCE}\nfooter`;
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE);
      expect(fences(part) % 2).toBe(0);
    }
    // Continuation parts reopen the table.
    for (const part of parts.slice(1, -1)) expect(part.startsWith(FENCE)).toBe(true);
    expect(textLines(parts)).toEqual(textLines([text]));
  });

  it('never starts a part with an empty code block when the cut falls right before the closing fence', () => {
    const body = 'x'.repeat(MAX_MESSAGE - 10);
    const parts = splitMessage(`${FENCE}\n${body}\n${FENCE}\nafter`);
    for (const part of parts) expect(part).not.toMatch(/^```\n```/);
    expect(parts[0]!.endsWith(FENCE)).toBe(true);
  });

  it('caps the number of parts and says the rest was cut', () => {
    const parts = splitMessage(Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'), MAX_MESSAGE, 2);
    expect(parts).toHaveLength(2);
    expect(parts[1]!.endsWith('…')).toBe(true);
  });
});

describe('syncMessages', () => {
  const fake = (name: string, fail = false) => ({
    name,
    edit: vi.fn(async (_: string) => {
      if (fail) throw new Error('gone');
    }),
    delete: vi.fn(async () => {}),
  });
  type Fake = ReturnType<typeof fake> & EditableMessage;

  it('edits what is there, sends what is missing, deletes what is left over', async () => {
    const [a, b, c] = [fake('a'), fake('b'), fake('c')];
    const send = vi.fn(async (_: string, i: number) => fake(`new${i}`) as Fake);
    expect((await syncMessages([a], ['1', '2'], send)).map((m) => m.name)).toEqual(['a', 'new1']);
    expect(a.edit).toHaveBeenCalledWith('1');
    expect(send).toHaveBeenCalledWith('2', 1);

    expect((await syncMessages([a, b, c], ['only'], send)).map((m) => m.name)).toEqual(['a']);
    expect(b.delete).toHaveBeenCalled();
    expect(c.delete).toHaveBeenCalled();
  });

  it('replaces a message that can no longer be edited', async () => {
    const gone = fake('gone', true);
    const send = vi.fn(async () => fake('fresh') as Fake);
    expect((await syncMessages([gone], ['text'], send)).map((m) => m.name)).toEqual(['fresh']);
  });
});

describe('a real long analysis', () => {
  it('goes out whole: every player in the table, no message over the limit', () => {
    const heroes = new Map((JSON.parse(readFileSync(new URL('./fixtures/opendota-heroes.json', import.meta.url), 'utf8')) as HeroInfo[]).map((h) => [h.id, h]));
    const match = matchSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/opendota-ranked-parsed.json', import.meta.url), 'utf8')));
    const report = computeMvp(match, heroes, true);
    // A Gemini verdict is up to 600 characters.
    const text = formatMvpChat(report, 'в'.repeat(600));
    expect(text.length).toBeGreaterThan(MAX_MESSAGE);
    const parts = splitMessage(text);
    expect(parts.length).toBe(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE);
    for (const p of report.players) expect(parts.join('\n')).toContain(`pos${p.position} ${p.hero}`);
    expect(textLines(parts)).toEqual(textLines([text]));
  });
});

describe('the /analyze reply', () => {
  /** A fake interaction: the reply plus messages sent to its channel, in posting order. */
  function fakeInteraction() {
    const posted: Array<{ id: number; content: string; deleted: boolean }> = [];
    let nextId = 1;
    const message = (content: string) => {
      const entry = { id: nextId++, content, deleted: false };
      posted.push(entry);
      return {
        url: `msg/${entry.id}`,
        edit: async (text: string) => void (entry.content = text),
        delete: async () => void (entry.deleted = true),
      };
    };
    const interaction = {
      reply: '',
      editReply: async (text: string) => {
        interaction.reply = text;
        return { url: 'reply' };
      },
      channel: { isSendable: () => true, send: async (text: string) => message(text) },
    };
    const live = () => posted.filter((p) => !p.deleted).map((p) => p.content);
    return { interaction, live };
  }
  const long = `head\n${FENCE}\n${Array.from({ length: 200 }, (_, i) => `рядок ${i}`).join('\n')}\n${FENCE}`;

  it('continues a long analysis right below the reply, and cleans up when it gets shorter', async () => {
    const { interaction, live } = fakeInteraction();
    const sink = interactionSink(interaction as never, () => 0);
    await sink.update(long);
    const parts = splitMessage(long);
    expect(interaction.reply).toBe(parts[0]);
    expect(live()).toEqual(parts.slice(1));
    await sink.update('short');
    expect(interaction.reply).toBe('short');
    expect(live()).toEqual([]);
    expect(sink.url).toBe('reply');
  });

  it('after the interaction expires, posts the whole analysis anew and drops the old continuation', async () => {
    const { interaction, live } = fakeInteraction();
    let now = 0;
    const sink = interactionSink(interaction as never, () => now);
    await sink.update(long);
    now = 15 * 60_000;
    await sink.update(`${long}\nfinal`);
    expect(live()).toEqual(splitMessage(`${long}\nfinal`));
    expect(sink.url).not.toBe('reply');
  });
});
