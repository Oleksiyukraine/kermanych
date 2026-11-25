// apps/api/src/remote/presence.ts
// Whether the operator is at the computer, for «Пульт»'s push notifications
// (docs/specs/2026-11-24-mobile-remote-control.md, decision 4 and → Notifications and presence): no
// push while they are — the desktop already shows the question. The api imports nothing from
// electron, so the desktop app hands its probe in through `bootstrap({ presence })` (Electron's
// powerMonitor: system idle time under REMOTE_PRESENCE_IDLE_S and the screen not locked), the way
// it hands in keep-awake (minion/keep-awake.ts).
//
// `unknown` — the desktop cannot tell (some Linux sessions, Wayland), or a standalone api has no
// probe at all — counts as away: a spare notification is cheaper than a missed question.

export type Presence = "present" | "away" | "unknown";

export type PresenceProbe = () => Presence;

let probe: PresenceProbe | undefined;

// The desktop app sets it once, a spec once per test.
export function setPresence(fn: PresenceProbe | undefined): void {
  probe = fn;
}

// A probe that throws knows nothing: unknown.
export function presence(): Presence {
  try {
    return probe?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The push rule's question: only an operator who is surely at the computer silences the push.
export function operatorAway(p: Presence = presence()): boolean {
  return p !== "present";
}
