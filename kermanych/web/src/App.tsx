import { useEffect } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { SessionBoard } from "./components/SessionBoard";
import { SessionDetail } from "./components/SessionDetail";

export function App() {
  const connect = useStore((s) => s.connect);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  useEffect(() => {
    connect();
  }, [connect]);
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto p-4">
        {selectedSessionId ? <SessionDetail /> : <SessionBoard />}
      </main>
    </div>
  );
}
