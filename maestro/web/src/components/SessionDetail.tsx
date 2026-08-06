import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { UiRequestWidget } from "./UiRequestWidget";

export function SessionDetail() {
  const { sessions, selectedSessionId, transcripts, selectSession } = useStore();
  const session = sessions.find((s) => s.id === selectedSessionId)!;
  const entries = transcripts[selectedSessionId!] ?? [];
  const [text, setText] = useState("");

  useEffect(() => {
    if (selectedSessionId && !transcripts[selectedSessionId]) {
      api.loadTranscript(selectedSessionId).then((t) =>
        useStore.setState((s) => ({
          transcripts: { ...s.transcripts, [selectedSessionId]: t },
        })),
      );
    }
  }, [selectedSessionId]);

  if (!session) return null;

  const mode = session.status === "done" ? "follow_up" : "steer";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-2">
        <button onClick={() => selectSession(undefined)} className="text-neutral-400">
          ← back
        </button>
        <h2 className="text-lg">{session.name}</h2>
        <span className="text-xs text-neutral-400">
          {session.status}
          {session.currentTool ? ` · ${session.currentTool}` : ""}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => api.stopSession(session.id)}
            className="text-xs bg-neutral-800 px-2 py-1 rounded"
          >
            Stop
          </button>
          <button
            onClick={() => {
              if (confirm("Delete session + worktree?")) {
                api.deleteSession(session.id);
                selectSession(undefined);
              }
            }}
            className="text-xs bg-red-800 px-2 py-1 rounded"
          >
            Delete
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto space-y-2 bg-neutral-900 rounded p-3">
        {entries.map((e, i) => (
          <div key={i} className="text-sm">
            {e.kind === "assistant_text" && <div className="whitespace-pre-wrap">{e.text}</div>}
            {e.kind === "assistant_thinking" && (
              <div className="text-neutral-500 italic whitespace-pre-wrap">{e.text}</div>
            )}
            {e.kind === "tool_call" && (
              <div className="text-amber-400">
                ⚙ {e.tool}
                {e.summary ? `: ${e.summary}` : ""}
              </div>
            )}
            {e.kind === "tool_result" && (
              <div className={e.ok ? "text-green-500" : "text-red-500"}>
                {e.ok ? "✓" : "✗"} {e.tool}
              </div>
            )}
            {e.kind === "notice" && <div className="text-neutral-400">{e.text}</div>}
          </div>
        ))}
      </div>
      {session.pendingUiRequest && (
        <UiRequestWidget sessionId={session.id} req={session.pendingUiRequest} />
      )}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text) {
              api.sendMessage(session.id, text, mode);
              setText("");
            }
          }}
          placeholder={mode === "follow_up" ? "follow-up…" : "steer…"}
          className="flex-1 bg-neutral-800 px-3 py-2 rounded"
        />
      </div>
    </div>
  );
}
