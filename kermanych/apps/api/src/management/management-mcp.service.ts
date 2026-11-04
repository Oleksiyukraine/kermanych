// apps/api/src/management/management-mcp.service.ts
// The Менеджмент assistant's tools, spoken as MCP (Streamable HTTP, JSON responses, no
// server-sent stream) so both agent runtimes consume ONE server: the claude runtime natively
// through the SDK's `mcpServers`, omp through the small bridge extension in
// runtime/omp-mcp-bridge.ts. Only the four methods a tool client needs are implemented —
// initialize, ping, tools/list, tools/call — and notifications are acknowledged and ignored.
//
// One server, every tracker: the jira_* and plane_* tools are listed together and a call is
// routed by its name's prefix, so a workspace with both trackers connected hands its child
// one endpoint and one secret.
//
// Authentication is a per-child bearer secret, not the operator's Supabase JWT: the child
// must never hold the operator's cloud session, and a secret minted for ONE conversation's
// child and revoked with it bounds what a leaked value can reach to that conversation's
// scope. The route is @Public for the same reason and checks the secret itself.
import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { JiraToolsService } from "../jira/jira-tools.service";
import { PlaneToolsService } from "../plane/plane-tools.service";
import type { ManagementToolScope } from "./tracker-tools";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };

// The protocol revision this server speaks when a client names none; a client that names one
// gets it echoed back — the four methods here are identical across the revisions in use.
const PROTOCOL_VERSION = "2025-06-18";

@Injectable()
export class ManagementMcpService {
  private scopes = new Map<string, ManagementToolScope>();

  constructor(
    private jira: JiraToolsService,
    private plane: PlaneToolsService,
  ) {}

  // A fresh secret for one child. The scope object is the caller's and stays live: its
  // user/workspace/sink are updated turn by turn without re-minting the secret.
  open(scope: ManagementToolScope): string {
    const token = randomBytes(32).toString("base64url");
    this.scopes.set(token, scope);
    return token;
  }

  close(token: string): void {
    this.scopes.delete(token);
  }

  scopeFor(token: string | undefined): ManagementToolScope | undefined {
    return token ? this.scopes.get(token) : undefined;
  }

  // One POST body → the response body, or `undefined` when it held only notifications (the
  // transport answers those with 202 and no body).
  async handle(scope: ManagementToolScope, body: unknown): Promise<unknown> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(scope, m)))).filter((r) => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.one(scope, body);
  }

  private async one(scope: ManagementToolScope, raw: unknown): Promise<unknown> {
    const msg = (raw && typeof raw === "object" ? raw : {}) as JsonRpcRequest;
    // No id = a notification (initialized, cancelled): nothing to answer.
    if (msg.id === undefined || msg.id === null) return undefined;
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    switch (msg.method) {
      case "initialize":
        return result({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kermanych-trackers", version: "1.0.0" },
        });
      case "ping":
        return result({});
      case "tools/list":
        return result({ tools: [...this.jira.list(), ...this.plane.list()] });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        // Unprefixed names fall to the Jira set, whose «unknown tool» answer names them.
        const out = await (name.startsWith("plane_") ? this.plane : this.jira).call(scope, name, params.arguments);
        return result({ content: [{ type: "text", text: out.text }], isError: out.isError });
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
    }
  }
}
