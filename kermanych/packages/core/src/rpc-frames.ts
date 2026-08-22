export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) out.push(line);
    }
    return out;
  }
}

export class ChunkReassembler {
  private id: string | null = null;
  private parts: string[] = [];
  private count = 0;
  private byteLength = 0;
  // A throw leaves the sequence half-open, and every following frame then throws on it.
  // Callers that recover from a dropped frame MUST reset, or one loss poisons the stream.
  reset(): void {
    this.id = null;
    this.parts = [];
    this.count = 0;
    this.byteLength = 0;
  }
  push(frame: any): any | null {
    if (!frame || frame.type !== "rpc_chunk") {
      if (this.id !== null) throw new Error("non-chunk frame interleaved into chunk sequence");
      return frame;
    }
    if (this.id === null) { this.id = frame.chunkId; this.count = frame.count; this.byteLength = frame.byteLength; this.parts = new Array(frame.count).fill(""); }
    if (frame.chunkId !== this.id) throw new Error("interleaved chunk sequence");
    this.parts[frame.index] = frame.data;
    if (frame.index < this.count - 1) return null;
    const buf = Buffer.concat(this.parts.map((p) => Buffer.from(p, "base64")));
    if (buf.length !== this.byteLength) throw new Error("chunk byteLength mismatch");
    this.id = null; this.parts = []; this.count = 0;
    return JSON.parse(buf.toString("utf8"));
  }
}
