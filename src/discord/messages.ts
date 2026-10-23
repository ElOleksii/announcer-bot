/** Discord message limit. */
export const MAX_MESSAGE = 2000;
/** A full analysis takes two messages at most; more than this and the rest is cut. */
export const MAX_PARTS = 3;

const FENCE = '```';

/**
 * Splits a long text into Discord-sized messages at line breaks. A part that ends inside a code
 * block closes it, and the next part reopens it, so every message renders on its own.
 */
export function splitMessage(text: string, max = MAX_MESSAGE, maxParts = MAX_PARTS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  let inCode = false;
  // Room to close a code block at the end of a part.
  const room = FENCE.length + 1;

  const flush = () => {
    parts.push(inCode ? `${current}\n${FENCE}` : current);
    current = inCode ? FENCE : '';
  };
  for (const line of text.split('\n')) {
    const isFence = line.trimStart().startsWith(FENCE);
    const next = current ? `${current}\n${line}` : line;
    // The closing fence uses the room kept for it; anything else must leave that room.
    const limit = inCode && isFence ? max : max - room;
    if (next.length > limit && current && current !== FENCE) flush();
    // A single line longer than a message (never in practice): cut it.
    const piece = line.length > max - room ? `${line.slice(0, max - room - 2)} …` : line;
    current = current ? `${current}\n${piece}` : piece;
    if (isFence) inCode = !inCode;
  }
  if (current && current !== FENCE) parts.push(current);

  if (parts.length <= maxParts) return parts;
  const kept = parts.slice(0, maxParts);
  const last = kept[maxParts - 1]!;
  kept[maxParts - 1] = last.endsWith(FENCE) ? `${last.slice(0, -FENCE.length)}…\n${FENCE}` : `${last} …`;
  return kept;
}

/** What syncMessages needs from a posted message. */
export interface EditableMessage {
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

/**
 * Shows `parts` in a run of messages: edits the ones already posted, sends the missing ones (via
 * `send`, which gets the part's index), deletes leftovers when the text got shorter. A message
 * that can no longer be edited is replaced by a new one. Returns the messages now showing the text.
 */
export async function syncMessages<M extends EditableMessage>(
  existing: readonly M[],
  parts: readonly string[],
  send: (content: string, index: number) => Promise<M>,
): Promise<M[]> {
  const shown: M[] = [];
  for (const [i, part] of parts.entries()) {
    const message = existing[i];
    if (message) {
      try {
        await message.edit(part);
        shown.push(message);
        continue;
      } catch {
        // Deleted or too old: post a new one below.
      }
    }
    shown.push(await send(part, i));
  }
  for (const leftover of existing.slice(parts.length)) await leftover.delete().catch(() => {});
  return shown;
}
