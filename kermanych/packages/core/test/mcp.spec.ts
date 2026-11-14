import { describe, expect, it } from "vitest";
import {
  codexTablesEqual,
  expandMcpDef,
  mcpDefFromCodex,
  mcpDefFromJson,
  mcpSecretVarName,
  mcpSeenBy,
  mcpToCodex,
  mcpVarRefs,
  type McpServerDef,
} from "../src/mcp";

const stdio = (over: Partial<Extract<McpServerDef, { kind: "stdio" }>> = {}): McpServerDef => ({ kind: "stdio", command: "npx", args: [], env: {}, ...over });
const http = (over: Partial<Extract<McpServerDef, { kind: "http" }>> = {}): McpServerDef => ({ kind: "http", url: "https://mcp.example.com/mcp", headers: {}, ...over });

describe("mcpToCodex", () => {
  it("maps a stdio server: literal env stays env, a same-name placeholder becomes env_vars", () => {
    expect(mcpToCodex(stdio({ args: ["-y", "pkg"], env: { MODE: "ro", API_KEY: "${API_KEY}" } }))).toEqual({
      table: { command: "npx", args: ["-y", "pkg"], env: { MODE: "ro" }, env_vars: ["API_KEY"] },
    });
  });

  it("maps HTTP headers: Bearer var, whole-value var, literal", () => {
    expect(
      mcpToCodex(http({ headers: { Authorization: "Bearer ${LINEAR_TOKEN}", "X-Team": "${TEAM_ID}", "X-Region": "eu" } })),
    ).toEqual({
      table: {
        url: "https://mcp.example.com/mcp",
        bearer_token_env_var: "LINEAR_TOKEN",
        env_http_headers: { "X-Team": "TEAM_ID" },
        http_headers: { "X-Region": "eu" },
      },
    });
  });

  it.each([
    ["a placeholder in args (dev-db)", stdio({ args: ["-y", "@modelcontextprotocol/server-postgres", "${DEV_DB_RO_URL}"] }), "args"],
    ["a placeholder in command", stdio({ command: "${BIN}" }), "command"],
    ["an env value naming another variable", stdio({ env: { TOKEN: "${GITHUB_TOKEN}" } }), "env"],
    ["an env value with a default", stdio({ env: { TOKEN: "${TOKEN:-x}" } }), "env"],
    ["a placeholder in the URL", http({ url: "${BASE}/mcp" }), "url"],
    ["text around a header placeholder", http({ headers: { "X-Key": "key=${K}" } }), "header"],
    ["an SSE server", http({ sse: true }), "sse"],
  ])("has no codex form for %s", (_label, def, gap) => {
    expect(mcpToCodex(def)).toEqual({ gap });
  });

  it("round-trips through the codex table", () => {
    const def = http({ headers: { Authorization: "Bearer ${T}", "X-A": "${A}", "X-B": "b" } });
    const out = mcpToCodex(def);
    if (!("table" in out)) throw new Error("expected a table");
    expect(mcpDefFromCodex(out.table)).toEqual(def);
  });
});

describe("mcpDefFromCodex", () => {
  it("reads env_vars in both forms", () => {
    expect(mcpDefFromCodex({ command: "x", env_vars: ["A", { name: "B", source: "remote" }] })).toEqual(stdio({ command: "x", env: { A: "${A}", B: "${B}" } }));
  });
});

describe("codexTablesEqual", () => {
  it("ignores key order and empty maps", () => {
    expect(codexTablesEqual({ command: "x", args: ["a"], env: {} }, { args: ["a"], command: "x" })).toBe(true);
    expect(codexTablesEqual({ command: "x", args: ["a"] }, { command: "x", args: ["b"] })).toBe(false);
  });
});

describe("mcpDefFromJson", () => {
  it("reads stdio, HTTP and SSE entries and rejects anything else", () => {
    expect(mcpDefFromJson({ command: "node", args: ["s.js", 1], env: { A: "a", B: 2 } })).toEqual(stdio({ command: "node", args: ["s.js"], env: { A: "a" } }));
    expect(mcpDefFromJson({ type: "http", url: "https://x/mcp", headers: { A: "a" } })).toEqual(http({ url: "https://x/mcp", headers: { A: "a" } }));
    expect(mcpDefFromJson({ type: "sse", url: "https://x/sse" })).toEqual(http({ url: "https://x/sse", sse: true }));
    expect(mcpDefFromJson({ type: "stdio" })).toBeNull();
    expect(mcpDefFromJson("npx")).toBeNull();
  });
});

describe("mcpVarRefs / expandMcpDef", () => {
  it("lists each variable once; optional only when every use has a default", () => {
    const def = stdio({ args: ["${A}", "${B:-x}", "${A:-y}"], env: { C: "${C:-1}" } });
    expect(mcpVarRefs(def)).toEqual([
      { name: "A", optional: false },
      { name: "B", optional: true },
      { name: "C", optional: true },
    ]);
  });

  it("expands from the environment, falling back to the default or ''", () => {
    expect(expandMcpDef(stdio({ args: ["${A}", "${B:-dflt}", "${C}"] }), { A: "a" })).toEqual(stdio({ args: ["a", "dflt", ""] }));
  });
});

describe("mcpSeenBy", () => {
  it("names the harnesses that read the files", () => {
    expect(mcpSeenBy([".mcp.json"])).toEqual(["omp", "claude"]);
    expect(mcpSeenBy([".cursor/mcp.json"])).toEqual(["omp"]);
    expect(mcpSeenBy([".mcp.json", ".codex/config.toml"])).toEqual(["omp", "claude", "codex"]);
  });
});

describe("mcpSecretVarName", () => {
  it("is upper snake case and never starts with a digit", () => {
    expect(mcpSecretVarName("linear", "Authorization")).toBe("LINEAR_AUTHORIZATION");
    expect(mcpSecretVarName("my-api", "X-Api-Key")).toBe("MY_API_X_API_KEY");
    expect(mcpSecretVarName("1password", "token")).toBe("MCP_1PASSWORD_TOKEN");
  });
});
