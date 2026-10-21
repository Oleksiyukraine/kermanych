// apps/ui/src/lib/outgoing.ts
import type { ImageInput, TranscriptEntry } from '@kermanych/core';

/**
 * A message the operator sent that the transcript does not show yet — the «надсилаю…» bubble.
 * The server appends the user entry only after it has woken a dormant agent (a respawn can take
 * seconds), so without this the composer clears and the message is nowhere in between.
 */
export interface OutgoingMessage {
  id: string;
  text: string;
  images: ImageInput[];
  /** `Date.now()` when the send began; the server stamps the entry on the same machine. */
  at: number;
}

/** Clock skew allowed between the send starting here and the server stamping its entry. */
const SKEW_MS = 1_000;

/**
 * The outgoing messages the transcript does NOT hold yet. Each `user_text` entry settles at most
 * one outgoing message — oldest first — with the same text, stamped no earlier than the send
 * began, so two identical messages sent in a row settle one at a time and an older identical
 * message in the history never settles a new one.
 */
export function unsettledOutgoing(
  outgoing: readonly OutgoingMessage[],
  entries: readonly TranscriptEntry[],
): OutgoingMessage[] {
  const used = new Set<string>();
  return outgoing.filter((msg) => {
    const hit = entries.find(
      (e) => e.kind === 'user_text' && !used.has(e.id) && e.text === msg.text && e.at >= msg.at - SKEW_MS,
    );
    if (!hit) return true;
    used.add(hit.id);
    return false;
  });
}
