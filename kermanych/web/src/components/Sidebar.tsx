import { useState } from "react";
import { useStore } from "../store";
import { api } from "../api";

const STATUS_DOT: Record<string, string> = {
  queued: "bg-neutral-500",
  thinking: "bg-blue-500",
  tool: "bg-amber-500",
  waiting_input: "bg-purple-500",
  done: "bg-green-600",
  error: "bg-red-600",
  stopped: "bg-neutral-600",
};

export function Sidebar() {
  const { groups, sessions, selectedGroupId, selectGroup } = useStore();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  return (
    <aside className="w-64 bg-neutral-900 border-r border-neutral-800 p-3 space-y-2 overflow-auto">
      <h1 className="text-lg font-semibold">Kermanych</h1>
      {groups.map((g) => {
        const gs = sessions.filter((s) => s.groupId === g.id);
        return (
          <button
            key={g.id}
            onClick={() => selectGroup(g.id)}
            className={`w-full text-left px-2 py-1 rounded ${selectedGroupId === g.id ? "bg-neutral-800" : ""}`}
          >
            <div className="flex justify-between">
              <span>{g.name}</span>
              <span className="text-xs text-neutral-400">{gs.length}</span>
            </div>
            <div className="flex gap-1 mt-1">
              {gs.map((s) => (
                <span
                  key={s.id}
                  className={`h-2 w-2 rounded-full ${STATUS_DOT[s.status] ?? "bg-neutral-500"}`}
                />
              ))}
            </div>
          </button>
        );
      })}
      <div className="pt-2 border-t border-neutral-800 space-y-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="group name"
          className="w-full bg-neutral-800 px-2 py-1 rounded text-sm"
        />
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder="/path/to/git/repo"
          className="w-full bg-neutral-800 px-2 py-1 rounded text-sm"
        />
        <button
          onClick={async () => {
            try {
              await api.createGroup(name, dir);
              setName("");
              setDir("");
            } catch (e) {
              alert(e);
            }
          }}
          className="w-full bg-blue-700 rounded py-1 text-sm"
        >
          Add group
        </button>
      </div>
    </aside>
  );
}

export { STATUS_DOT };
