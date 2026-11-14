// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { FeedbackRateLimitedError, type FeedbackInput } from '@kermanych/cloud';
import { useFeedback } from '../src/stores/feedback';

// «Надіслати відгук» (docs/specs/2026-11-13-feedback-form.md). What a user would notice: a failed
// send that loses the draft, a sent one that leaves it behind, a rate-limit refusal in raw database
// words, and a «Надіслати» that lets through what the table or the bucket would refuse.
const sendFeedback = vi.fn<(client: unknown, userId: string, input: FeedbackInput, files: File[]) => Promise<void>>();
const notify = vi.fn();

vi.mock('@kermanych/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendFeedback: (client: unknown, userId: string, input: FeedbackInput, files: File[]) =>
    sendFeedback(client, userId, input, files),
}));
vi.mock('../src/stores/auth', () => ({ useAuth: () => ({ user: { id: 'u1' }, client: {} }) }));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ notify }) }));
vi.mock('../src/stores/app-update', () => ({ APP_VERSION: '1.2.0' }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

const image = (name: string, bytes = 3) => ({
  data: 'A'.repeat(Math.ceil((bytes * 4) / 3)),
  mimeType: 'image/png',
  url: 'data:image/png;base64,AAAA',
  name,
});

describe('feedback store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendFeedback.mockReset();
    notify.mockReset();
  });

  it('sends the draft with its context, then clears it, closes and thanks', async () => {
    const fb = useFeedback();
    fb.show();
    fb.kind = 'idea';
    fb.message = 'Темна тема для терміналу';
    fb.images = [image('a.png')];
    sendFeedback.mockResolvedValue();

    await fb.send({ screen: 'agents', locale: 'uk' });

    const [, userId, input, files] = sendFeedback.mock.calls[0] ?? [];
    expect(userId).toBe('u1');
    expect(input).toMatchObject({
      kind: 'idea',
      message: 'Темна тема для терміналу',
      appVersion: '1.2.0',
      client: 'web',
      screen: 'agents',
      locale: 'uk',
    });
    expect(files?.map((f) => f.name)).toEqual(['a.png']);
    expect([fb.open, fb.kind, fb.message, fb.images.length]).toEqual([false, 'bug', '', 0]);
    expect(notify).toHaveBeenCalledWith('feedback.sent');
  });

  it('keeps the draft and the modal when the send fails, and words the rate limit', async () => {
    const fb = useFeedback();
    fb.show();
    fb.message = 'Падає при запуску';
    fb.images = [image('a.png')];
    sendFeedback.mockRejectedValue(new FeedbackRateLimitedError());

    await expect(fb.send()).rejects.toThrow('feedback.rateLimited');
    expect([fb.open, fb.message, fb.images.length]).toEqual([true, 'Падає при запуску', 1]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses what the table or the bucket would refuse, and sends nothing then', async () => {
    const fb = useFeedback();
    fb.message = '   ';
    expect([fb.canSend, fb.refusal]).toEqual([false, null]);

    fb.message = 'x'.repeat(5001);
    expect([fb.canSend, fb.refusal]).toEqual([false, 'feedback.tooLong']);

    fb.message = 'ok';
    fb.images = [image('1.png'), image('2.png'), image('3.png'), image('4.png')];
    expect([fb.canSend, fb.refusal]).toEqual([false, 'feedback.tooManyImages']);

    fb.images = [image('big.png', 10 * 1024 * 1024 + 3)];
    expect([fb.canSend, fb.refusal]).toEqual([false, 'feedback.imageTooLarge']);

    await fb.send();
    expect(sendFeedback).not.toHaveBeenCalled();
  });
});
