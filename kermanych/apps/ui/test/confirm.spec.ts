import { describe, expect, it } from 'vitest';
import { confirmAction, confirmOpen } from '../src/lib/confirm';

const req = { title: 'Delete', message: 'Gone for good', confirmLabel: 'Delete' };

describe('confirmAction', () => {
  it('opens one request and answers with the choice', async () => {
    const yes = confirmAction(req);
    expect(confirmOpen.value?.title).toBe('Delete');
    confirmOpen.value!.resolve(true);
    await expect(yes).resolves.toBe(true);
    expect(confirmOpen.value).toBeNull();

    const no = confirmAction(req);
    confirmOpen.value!.resolve(false);
    await expect(no).resolves.toBe(false);
  });

  it('answers «no» to an open request when a second one arrives', async () => {
    const first = confirmAction(req);
    const second = confirmAction({ ...req, title: 'Second' });
    await expect(first).resolves.toBe(false);
    expect(confirmOpen.value?.title).toBe('Second');
    confirmOpen.value!.resolve(true);
    await expect(second).resolves.toBe(true);
  });
});
