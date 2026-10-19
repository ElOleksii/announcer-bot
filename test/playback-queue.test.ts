import { describe, expect, it } from 'vitest';
import { PlaybackQueue, type AudioSink } from '../src/audio/playback-queue.js';

/** Sink whose playbacks finish only when the test says so. */
class ManualSink implements AudioSink {
  readonly started: string[] = [];
  private finishers: Array<() => void> = [];
  active = 0;
  maxActive = 0;

  play(file: string): Promise<void> {
    this.started.push(file);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise((resolve) => {
      this.finishers.push(() => {
        this.active -= 1;
        resolve();
      });
    });
  }

  async finishCurrent(): Promise<void> {
    this.finishers.shift()?.();
    // Let the queue's await continue and start the next item.
    await new Promise((r) => setImmediate(r));
  }
}

const item = (file: string) => ({ file, volume: 1, label: file });

describe('PlaybackQueue', () => {
  it('plays items one after another, never overlapping', async () => {
    const sink = new ManualSink();
    const queue = new PlaybackQueue(sink);
    queue.enqueue(item('a'));
    queue.enqueue(item('b'));
    expect(sink.started).toEqual(['a']);

    await sink.finishCurrent();
    expect(sink.started).toEqual(['a', 'b']);
    await sink.finishCurrent();
    await queue.whenIdle();
    expect(sink.maxActive).toBe(1);
  });

  it('keeps at most 2 waiting items, dropping the oldest', async () => {
    const sink = new ManualSink();
    const queue = new PlaybackQueue(sink);
    for (const f of ['playing', 'old1', 'old2', 'new1', 'new2']) queue.enqueue(item(f));
    expect(queue.size).toBe(3); // 1 playing + 2 waiting

    for (let i = 0; i < 3; i++) await sink.finishCurrent();
    await queue.whenIdle();
    expect(sink.started).toEqual(['playing', 'new1', 'new2']);
  });

  it('continues after a playback error', async () => {
    const played: string[] = [];
    const queue = new PlaybackQueue({
      async play(file) {
        played.push(file);
        if (file === 'bad') throw new Error('decode failed');
      },
    });
    queue.enqueue(item('bad'));
    queue.enqueue(item('good'));
    await queue.whenIdle();
    expect(played).toEqual(['bad', 'good']);
  });

  it('clear() drops waiting items but lets the current one finish', async () => {
    const sink = new ManualSink();
    const queue = new PlaybackQueue(sink);
    queue.enqueue(item('a'));
    queue.enqueue(item('b'));
    queue.clear();
    await sink.finishCurrent();
    await queue.whenIdle();
    expect(sink.started).toEqual(['a']);
  });

  it('whenIdle resolves immediately when empty', async () => {
    await expect(new PlaybackQueue(new ManualSink()).whenIdle()).resolves.toBeUndefined();
  });
});
