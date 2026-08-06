import { useState } from "react";
import { api } from "../api";

export function NewSessionForm({ groupId }: { groupId: string }) {
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  return (
    <div className="mt-4 p-3 bg-neutral-900 rounded space-y-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="session name"
        className="w-full bg-neutral-800 px-2 py-1 rounded text-sm"
      />
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="task prompt"
        className="w-full bg-neutral-800 px-2 py-1 rounded text-sm h-20"
      />
      <input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="model (optional, e.g. opus)"
        className="w-full bg-neutral-800 px-2 py-1 rounded text-sm"
      />
      <button
        onClick={async () => {
          try {
            await api.createSession(groupId, name || "session", task, model || undefined);
            setName("");
            setTask("");
          } catch (e) {
            alert(e);
          }
        }}
        className="bg-green-700 rounded px-3 py-1 text-sm"
      >
        Launch session
      </button>
    </div>
  );
}
