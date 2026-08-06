// tests/rpc-frames.test.ts
import { expect, test } from "bun:test";
import { LineSplitter, ChunkReassembler } from "../src/server/rpc-frames";

test("LineSplitter splits on newline and buffers partials", () => {
  const s = new LineSplitter();
  expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
  expect(s.push('2}\n')).toEqual(['{"b":2}']);
});

test("ChunkReassembler passes through non-chunk frames", () => {
  const r = new ChunkReassembler();
  expect(r.push({ type: "agent_start" })).toEqual({ type: "agent_start" });
});

test("ChunkReassembler reassembles a chunk sequence", () => {
  const r = new ChunkReassembler();
  const obj = { type: "response", command: "get_messages", data: { big: "x" } };
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const half = Math.ceil(b64.length / 2);
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: json.length, data: b64.slice(0, half) })).toBeNull();
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 1, count: 2, byteLength: json.length, data: b64.slice(half) })).toEqual(obj);
});

test("ChunkReassembler rejects interleaved sequences", () => {
  const r = new ChunkReassembler();
  r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: 10, data: "AA" });
  expect(() => r.push({ type: "rpc_chunk", chunkId: "c2", index: 0, count: 2, byteLength: 10, data: "BB" })).toThrow();
});
