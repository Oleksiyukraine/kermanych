const BASE = "http://localhost:4317";
const post = (p: string, body: unknown) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export const api = {
  createGroup: (name: string, projectDir: string) => post("/api/groups", { name, projectDir }),
  createSession: (groupId: string, name: string, task: string, model?: string) =>
    post("/api/sessions", { groupId, name, task, model }),
  sendMessage: (id: string, text: string, mode: string) =>
    post(`/api/sessions/${id}/message`, { text, mode }),
  answerUi: (id: string, res: unknown) => post(`/api/sessions/${id}/answer`, { res }),
  stopSession: (id: string) => post(`/api/sessions/${id}/stop`, {}),
  deleteSession: (id: string) => fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }),
  loadTranscript: (id: string) => fetch(`${BASE}/api/sessions/${id}/transcript`).then((r) => r.json()),
};
