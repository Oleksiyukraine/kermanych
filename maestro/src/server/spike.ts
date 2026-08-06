// src/server/spike.ts
const proc = Bun.spawn(["omp", "--mode", "rpc", "--cwd", process.cwd()], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const enc = new TextEncoder();
const send = (o: unknown) => proc.stdin.write(enc.encode(JSON.stringify(o) + "\n"));

let buf = "";
const reader = proc.stdout.getReader();
const dec = new TextDecoder();
let sentPrompt = false;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    console.log("<<", frame.type, JSON.stringify(frame).slice(0, 200));
    if (frame.type === "ready" && !sentPrompt) {
      send({ id: "n1", type: "negotiate_protocol", protocolVersion: 2 });
      send({ id: "p1", type: "prompt", message: "List the top-level files, then stop." });
      sentPrompt = true;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      send({ id: "s1", type: "get_state" });
    }
    if (frame.command === "get_state") { proc.stdin.end(); }
  }
}
