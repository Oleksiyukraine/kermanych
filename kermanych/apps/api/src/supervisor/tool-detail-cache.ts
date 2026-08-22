import type { ToolLine } from "@kermanych/core";

export const MAX_CALL_BYTES = 256 * 1024;
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

type Slot = { lines: ToolLine[]; bytes: number };

// Full tool output never rides the WebSocket (the gateway broadcasts to every socket
// with no rooms), so it lives here until the operator expands the row. Insertion order
// is FIFO: a long session drops its oldest outputs rather than growing without bound.
export class ToolDetailCache {
  private readonly perCall: number;
  private readonly perSession: number;
  private sessions = new Map<string, Map<string, Slot>>();
  private used = new Map<string, number>();

  constructor(opts?: { maxCallBytes?: number; maxSessionBytes?: number }) {
    this.perCall = opts?.maxCallBytes ?? MAX_CALL_BYTES;
    this.perSession = opts?.maxSessionBytes ?? MAX_SESSION_BYTES;
  }

  put(sessionId: string, callId: string, lines: ToolLine[]): void {
    const bytes = lines.reduce((sum, l) => sum + ("text" in l ? Buffer.byteLength(l.text) : 0) + 8, 0);
    if (bytes > this.perCall) return;
    const calls = this.sessions.get(sessionId) ?? new Map<string, Slot>();
    this.sessions.set(sessionId, calls);
    const previous = calls.get(callId);
    let used = (this.used.get(sessionId) ?? 0) - (previous?.bytes ?? 0);
    calls.delete(callId);
    calls.set(callId, { lines, bytes });
    used += bytes;
    for (const [oldest, slot] of calls) {
      if (used <= this.perSession) break;
      if (oldest === callId) break;
      calls.delete(oldest);
      used -= slot.bytes;
    }
    this.used.set(sessionId, used);
  }

  get(sessionId: string, callId: string): ToolLine[] | undefined {
    return this.sessions.get(sessionId)?.get(callId)?.lines;
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.used.delete(sessionId);
  }
}
