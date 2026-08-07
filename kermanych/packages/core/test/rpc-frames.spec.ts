import { expect, test } from "vitest";
import { LineSplitter, ChunkReassembler } from "../src/rpc-frames";

test("LineSplitter splits on newline and buffers partials", () => {
  const s = new LineSplitter();
  expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
  expect(s.push('2}\n')).toEqual(['{"b":2}']);
});

test("ChunkReassembler passes through non-chunk frames", () => {
  const r = new ChunkReassembler();
  expect(r.push({ type: "agent_start" })).toEqual({ type: "agent_start" });
});

test("ChunkReassembler reassembles independently-base64'd byte segments", () => {
  const r = new ChunkReassembler();
  const obj = { type: "response", command: "get_messages", data: { big: "x".repeat(20) } };
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  const seg = Math.ceil(bytes.length / 2);
  const c0 = bytes.subarray(0, seg).toString("base64");
  const c1 = bytes.subarray(seg).toString("base64");
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: bytes.length, data: c0 })).toBeNull();
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 1, count: 2, byteLength: bytes.length, data: c1 })).toEqual(obj);
});

test("ChunkReassembler handles multi-byte UTF-8 across a byte-split boundary", () => {
  const r = new ChunkReassembler();
  const obj = { type: "notice", message: "café ☕ 日本語 " + "y".repeat(8) };
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  const seg = Math.ceil(bytes.length / 2);
  expect(r.push({ type: "rpc_chunk", chunkId: "c9", index: 0, count: 2, byteLength: bytes.length, data: bytes.subarray(0, seg).toString("base64") })).toBeNull();
  expect(r.push({ type: "rpc_chunk", chunkId: "c9", index: 1, count: 2, byteLength: bytes.length, data: bytes.subarray(seg).toString("base64") })).toEqual(obj);
});

test("ChunkReassembler rejects interleaved sequences", () => {
  const r = new ChunkReassembler();
  r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: 10, data: "AA" });
  expect(() => r.push({ type: "rpc_chunk", chunkId: "c2", index: 0, count: 2, byteLength: 10, data: "BB" })).toThrow();
});
