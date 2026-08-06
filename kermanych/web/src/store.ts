import { create } from "zustand";
import type { Group, Session, TranscriptEntry, ServerEvent } from "../../src/server/types";

type State = {
  groups: Group[];
  sessions: Session[];
  transcripts: Record<string, TranscriptEntry[]>;
  selectedGroupId?: string;
  selectedSessionId?: string;
  connect(): void;
  selectGroup(id: string): void;
  selectSession(id?: string): void;
};

export const useStore = create<State>((set, get) => ({
  groups: [],
  sessions: [],
  transcripts: {},
  connect() {
    const ws = new WebSocket("ws://localhost:4317/ws");
    ws.onmessage = (ev) => {
      const e: ServerEvent = JSON.parse(ev.data);
      if (e.type === "snapshot") set({ groups: e.groups, sessions: e.sessions });
      if (e.type === "group_update")
        set((s) => ({ groups: [...s.groups.filter((g) => g.id !== e.group.id), e.group] }));
      if (e.type === "group_removed")
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== e.groupId),
          sessions: s.sessions.filter((x) => x.groupId !== e.groupId),
        }));
      if (e.type === "session_update")
        set((s) => ({ sessions: [...s.sessions.filter((x) => x.id !== e.session.id), e.session] }));
      if (e.type === "session_removed")
        set((s) => ({ sessions: s.sessions.filter((x) => x.id !== e.sessionId) }));
      if (e.type === "transcript_append")
        set((s) => ({
          transcripts: {
            ...s.transcripts,
            [e.sessionId]: [...(s.transcripts[e.sessionId] ?? []), e.entry],
          },
        }));
    };
  },
  selectGroup(id) {
    set({ selectedGroupId: id, selectedSessionId: undefined });
  },
  selectSession(id) {
    set({ selectedSessionId: id });
  },
}));
