import { useStore } from "../store";
import { SessionCard } from "./SessionCard";
import { NewSessionForm } from "./NewSessionForm";

export function SessionBoard() {
  const { sessions, selectedGroupId, groups } = useStore();
  if (!selectedGroupId) return <p className="text-neutral-400">Select or add a group.</p>;
  const group = groups.find((g) => g.id === selectedGroupId);
  const gs = sessions.filter((s) => s.groupId === selectedGroupId);
  return (
    <div>
      <h2 className="text-xl mb-3">{group?.name}</h2>
      <div className="grid grid-cols-2 gap-3">
        {gs.map((s) => (
          <SessionCard key={s.id} session={s} />
        ))}
      </div>
      <NewSessionForm groupId={selectedGroupId} />
    </div>
  );
}
