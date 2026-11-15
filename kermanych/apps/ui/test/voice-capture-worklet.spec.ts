import { afterAll, beforeAll, expect, it } from 'vitest';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

// Dictation's microphone tap on the audio thread (lib/voice-capture.worklet.ts), in a stub
// AudioWorkletGlobalScope whose port really transfers: a transferred block's buffer is detached
// afterwards, as in Chromium, and the tap must keep cutting full blocks after that.

const RATE = 16_000;
const QUANTUM = 128;
type Processor = { port: MessagePort; process(inputs: Float32Array[][]): boolean };
let Ctor: new () => Processor;
const channel = new MessageChannel();
const g = globalThis as Record<string, unknown>;

beforeAll(async () => {
  g.sampleRate = RATE;
  g.AudioWorkletProcessor = class {
    readonly port = channel.port1;
  };
  g.registerProcessor = (_name: string, ctor: new () => Processor) => {
    Ctor = ctor;
  };
  // After the stubs: the worklet registers itself as it loads, and a static import is hoisted.
  await import('../src/lib/voice-capture.worklet');
});

afterAll(() => {
  channel.port1.close();
  delete g.sampleRate;
  delete g.AudioWorkletProcessor;
  delete g.registerProcessor;
});

it('posts every 100 ms block in order, after the first one was transferred too', async () => {
  const got: Float32Array[] = [];
  const { promise: drained, resolve } = Promise.withResolvers<void>();
  channel.port2.on('message', (m: Float32Array | 'end') => (m === 'end' ? resolve() : got.push(m)));
  const tap = new Ctor();
  let next = 0;
  // 40 quanta, 5120 samples: three blocks and a part, each boundary in the middle of a quantum.
  for (let q = 0; q < 40; q++) {
    const input = Float32Array.from({ length: QUANTUM }, () => next++);
    expect(tap.process([[input]])).toBe(true);
  }
  // Ports deliver in order: once this arrives, every block posted before it has too.
  channel.port1.postMessage('end');
  await drained;
  const block = RATE / 10;
  expect(got.map((b) => b.length)).toEqual([block, block, block]);
  const all = got.flatMap((b) => [...b]);
  expect(all).toEqual(Array.from({ length: 3 * block }, (_, i) => i));
});
