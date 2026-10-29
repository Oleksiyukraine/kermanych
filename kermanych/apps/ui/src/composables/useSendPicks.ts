// Браузер → «Надіслати агенту»: the picks tray as ONE message, through the same send the Лог
// composer uses. A managed session gets the crops as images; a native one their file paths in
// the text (it takes text only — lib/browser-picks.ts). A refusal (`native_busy`, a dead child)
// keeps the tray so nothing the operator wrote is lost. Shared by every page that hosts a
// KBrowserPane (Агенти, Дизайн), so the tray sends the same way wherever it is.
import { ref, type Ref } from 'vue';
import type { Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useSessionBrowser } from 'stores/browser';
import type { MessageMode } from '../lib/api';
import { composePicksMessage, picksImages } from '../lib/browser-picks';
import { errorText } from './useAsyncAction';

export type SendPicksOptions = {
  // Which omp message mode the message takes — the page's own rule for its composer.
  mode: (s: Session) => MessageMode;
  // After the tray went out: the page may move the operator to where the message landed.
  onSent?: (s: Session) => void;
};

export function useSendPicks(opts: SendPicksOptions): { send: (s: Session) => Promise<void>; sending: Ref<boolean> } {
  const store = useOrchestrator();
  const browser = useSessionBrowser();
  // One tray goes out at a time; KBrowserPane spins «Надіслати агенту» on it.
  const sending = ref(false);

  async function send(s: Session): Promise<void> {
    const picks = browser.picks[s.id];
    if (!picks?.length || sending.value) return;
    const native = !!s.native;
    sending.value = true;
    try {
      await store.sendMessage(
        s.id,
        composePicksMessage(picks, { native, comment: browser.notes[s.id] }),
        opts.mode(s),
        picksImages(picks, { native }),
      );
      browser.clearPicks(s.id);
      opts.onSent?.(s);
    } catch (e) {
      store.notify(errorText(e), 'error');
    } finally {
      sending.value = false;
    }
  }

  return { send, sending };
}
