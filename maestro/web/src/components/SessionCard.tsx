import { useStore } from "../store";
import { STATUS_DOT } from "./Sidebar";
import type { Session } from "../../../src/server/types";

export function SessionCard({ session }: { session: Session }) {
  const selectSession = useStore((s) => s.selectSession);
  const activeTodo = session.todoPhases
    ?.flatMap((p) => p.tasks)
    .find((t) => t.status === "in_progress");
  return (
    <button
      onClick={() => selectSession(session.id)}
      className="text-left p-3 bg-neutral-900 rounded border border-neutral-800 hover:border-neutral-600"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[session.status] ?? "bg-neutral-500"}`} />
        <span className="font-medium">{session.name}</span>
      </div>
      <div className="text-xs text-neutral-400 mt-1">
        {session.status}
        {session.currentTool ? ` · ${session.currentTool}` : ""}
      </div>
      {activeTodo && (
        <div className="text-xs text-neutral-300 mt-1 truncate">▸ {activeTodo.content}</div>
      )}
      {session.contextPercent != null && (
        <div className="text-xs text-neutral-500 mt-1">
          ctx {session.contextPercent.toFixed(0)}%
        </div>
      )}
    </button>
  );
}
