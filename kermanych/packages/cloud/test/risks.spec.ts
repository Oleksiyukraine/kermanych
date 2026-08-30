import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createProjectRisk,
  listProjectRisks,
  listRiskEvents,
  patchProjectRisk,
  toProjectRisk,
  toRiskRow,
} from "../src/risks";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// Same PostgrestBuilder stand-in as tasks.spec.ts: a thenable that records every chained
// call, so both the wire shape and the mapping can be asserted without a database.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const result = results[queries.length - 1] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const op of ["select", "insert", "update", "eq", "order", "single"]) {
        builder[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const riskRow = {
  id: "r1",
  project_id: "p1",
  code: "R-001",
  kind: "threat" as const,
  category: "vendor" as const,
  cause: "пісочниця провайдера платежів спільна з іншими клієнтами",
  event: "інтеграційне тестування буде заблоковане на кілька днів",
  consequence: "UAT зсунеться за реліз-гейт",
  probability: 4,
  impact: 4,
  exposure: 16,
  // postgrest returns numeric() as a string — the whole reason `num()` exists.
  cost_impact: "40000.00",
  probability_pct: 45,
  emv: "18000.00",
  proximity: "2026-09-20",
  response: "reduce" as const,
  response_actions: "Замовити виділений sandbox-тенант до 05.09",
  action_owner: "u2",
  action_due: "2026-09-05",
  risk_owner: "u1",
  residual_probability: 2,
  residual_impact: 3,
  residual_exposure: 6,
  early_warning: "черга у спільному sandbox довша за 30 хв",
  status: "treated" as const,
  closure_note: "",
  closed_at: null,
  raised_at: "2026-08-30T09:00:00.000Z",
  raised_by: "u1",
  last_reviewed_at: "2026-08-30T09:00:00.000Z",
  updated_at: "2026-08-30T09:30:00.000Z",
  updated_by: "u1",
};

describe("toProjectRisk", () => {
  it("parses numeric money columns instead of passing the postgrest strings through", () => {
    const r = toProjectRisk(riskRow);
    expect(r.costImpact).toBe(40000);
    expect(r.emv).toBe(18000);
    expect(r.probabilityPct).toBe(45);
  });

  // exactOptionalPropertyTypes: a null column must produce an ABSENT key, not `undefined`,
  // or every `{ ...risk }` spread starts asserting emptiness it was never told.
  it("omits the keys whose columns are null rather than setting them undefined", () => {
    const r = toProjectRisk({
      ...riskRow,
      cost_impact: null,
      probability_pct: null,
      emv: null,
      proximity: null,
      action_owner: null,
      action_due: null,
      risk_owner: null,
      residual_probability: null,
      residual_impact: null,
      residual_exposure: null,
      closed_at: null,
      raised_by: null,
      updated_by: null,
    });
    for (const key of [
      "costImpact",
      "probabilityPct",
      "emv",
      "proximity",
      "actionOwner",
      "actionDue",
      "riskOwner",
      "residualProbability",
      "residualImpact",
      "residualExposure",
      "closedAt",
      "raisedBy",
      "updatedBy",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(r, key)).toBe(false);
    }
  });

  it("keeps the statement in three parts and carries the derived scores", () => {
    const r = toProjectRisk(riskRow);
    expect(r.cause).toBe(riskRow.cause);
    expect(r.event).toBe(riskRow.event);
    expect(r.consequence).toBe(riskRow.consequence);
    expect(r.exposure).toBe(16);
    expect(r.residualExposure).toBe(6);
  });
});

describe("toRiskRow", () => {
  it("sends only the keys the patch actually carries", () => {
    expect(toRiskRow({ status: "closed", closureNote: "  провайдер замінений  " })).toEqual({
      status: "closed",
      closure_note: "провайдер замінений",
    });
  });

  // A cleared owner and a cleared date are `null`, not an omitted key: the caller means
  // «unassign», and an omitted key would silently keep the old person accountable.
  it("maps an explicit null to a cleared column", () => {
    expect(toRiskRow({ riskOwner: null, actionDue: null, residualImpact: null })).toEqual({
      risk_owner: null,
      action_due: null,
      residual_impact: null,
    });
  });

  it("keeps a zero score and a zero probability percentage instead of dropping them", () => {
    expect(toRiskRow({ probabilityPct: 0, costImpact: 0 })).toEqual({
      probability_pct: 0,
      cost_impact: 0,
    });
  });
});

describe("listProjectRisks", () => {
  it("scopes to one project and orders by exposure, then code", async () => {
    const { client, queries } = fakeClient({ data: [riskRow], error: null });

    const [r] = await listProjectRisks(client, "p1");

    expect(queries[0]!.table).toBe("project_risks");
    expect(queries[0]!.ops).toContainEqual(["eq", "project_id", "p1"]);
    expect(queries[0]!.ops).toContainEqual(["order", "exposure", { ascending: false }]);
    expect(queries[0]!.ops).toContainEqual(["order", "code", { ascending: true }]);
    expect(r!.code).toBe("R-001");
  });

  it("throws the postgrest message so an RLS refusal reaches the caller", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied" } });
    await expect(listProjectRisks(client, "p1")).rejects.toThrow("permission denied");
  });
});

describe("createProjectRisk", () => {
  // `code` is minted by project_risks_touch() under an advisory lock. A client-sent code
  // would race two people filing at once and would be overwritten anyway.
  it("never sends a code and passes the project id as its own column", async () => {
    const { client, queries } = fakeClient({ data: riskRow, error: null });

    await createProjectRisk(client, {
      projectId: "p1",
      kind: "threat",
      category: "vendor",
      cause: "  спільна пісочниця  ",
      event: "тестування заблоковане",
      consequence: "UAT зсувається",
      probability: 4,
      impact: 4,
      response: "reduce",
      responseActions: "виділений тенант",
    });

    const insert = queries[0]!.ops.find(([op]) => op === "insert")!;
    const payload = insert[1] as Record<string, unknown>;
    expect(payload.project_id).toBe("p1");
    expect("code" in payload).toBe(false);
    expect(payload.cause).toBe("спільна пісочниця");
  });
});

describe("patchProjectRisk", () => {
  it("updates by id and reads the row back through the same column list", async () => {
    const { client, queries } = fakeClient({ data: riskRow, error: null });

    await patchProjectRisk(client, "r1", { lastReviewedAt: "2026-09-06T09:00:00.000Z" });

    expect(queries[0]!.ops).toContainEqual(["eq", "id", "r1"]);
    expect(queries[0]!.ops).toContainEqual([
      "update",
      { last_reviewed_at: "2026-09-06T09:00:00.000Z" },
    ]);
    expect(queries[0]!.ops.some(([op]) => op === "single")).toBe(true);
  });
});

describe("listRiskEvents", () => {
  it("reads one risk's history newest first and maps the machine tokens", async () => {
    const { client, queries } = fakeClient({
      data: [
        {
          id: 7,
          risk_id: "r1",
          at: "2026-08-30T09:30:00.000Z",
          actor: null,
          kind: "status" as const,
          from_value: "open",
          to_value: "treated",
        },
      ],
      error: null,
    });

    const [e] = await listRiskEvents(client, "r1");

    expect(queries[0]!.table).toBe("project_risk_events");
    expect(queries[0]!.ops).toContainEqual(["order", "at", { ascending: false }]);
    expect(e).toEqual({
      id: 7,
      riskId: "r1",
      at: "2026-08-30T09:30:00.000Z",
      kind: "status",
      fromValue: "open",
      toValue: "treated",
    });
  });
});
