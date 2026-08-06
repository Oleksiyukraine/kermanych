import { api } from "../api";
import type { RpcExtensionUIRequest } from "../../../src/server/types";

export function UiRequestWidget({ sessionId, req }: { sessionId: string; req: RpcExtensionUIRequest }) {
  const answer = (res: unknown) =>
    api.answerUi(sessionId, { type: "extension_ui_response", id: req.id, ...(res as object) });

  return (
    <div className="mt-2 p-3 bg-purple-950 border border-purple-700 rounded">
      <div className="text-sm mb-2">
        {req.title ?? req.method}
        {req.message ? `: ${req.message}` : ""}
      </div>
      {req.method === "confirm" && (
        <div className="flex gap-2">
          <button
            onClick={() => answer({ confirmed: true })}
            className="bg-green-700 px-3 py-1 rounded text-sm"
          >
            Yes
          </button>
          <button
            onClick={() => answer({ confirmed: false })}
            className="bg-neutral-700 px-3 py-1 rounded text-sm"
          >
            No
          </button>
        </div>
      )}
      {req.method === "select" && (
        <div className="flex flex-wrap gap-2">
          {(req.options ?? []).map((o) => (
            <button
              key={o}
              onClick={() => answer({ value: o })}
              className="bg-blue-700 px-3 py-1 rounded text-sm"
            >
              {o}
            </button>
          ))}
        </div>
      )}
      {req.method === "input" && (
        <InputAnswer onSubmit={(v) => answer({ value: v })} placeholder={req.placeholder} />
      )}
      {req.method === "editor" && (
        <EditorAnswer onSubmit={(v) => answer({ value: v })} placeholder={req.placeholder} />
      )}
    </div>
  );
}

function InputAnswer({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder?: string }) {
  return (
    <input
      autoFocus
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit((e.target as HTMLInputElement).value);
      }}
      className="w-full bg-neutral-800 px-2 py-1 rounded text-sm"
    />
  );
}

function EditorAnswer({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder?: string }) {
  let value = "";
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        placeholder={placeholder}
        onChange={(e) => (value = e.target.value)}
        className="w-full h-32 bg-neutral-800 px-2 py-1 rounded text-sm font-mono"
      />
      <button
        onClick={() => onSubmit(value)}
        className="self-end bg-blue-700 px-3 py-1 rounded text-sm"
      >
        Submit
      </button>
    </div>
  );
}
