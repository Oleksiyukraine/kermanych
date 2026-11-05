import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Put } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { TesterAccount, TesterSettings } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

// «Тестувальник» settings of one project on THIS machine (docs/specs/2026-11-04-qa-tester-agent.md,
// decisions 4 and 14). The GET returns passwords: it serves the local UI only, the same trust as
// the other local tokens. The agent never reads this route; its prompt lists names and logins,
// and browser_type_credential types a password without echoing it (decision 5).
@Controller("tester")
export class TesterController {
  constructor(private registry: RegistryService) {}

  @Get("projects/:projectId")
  get(@Param("projectId") projectId: string): TesterSettings {
    this.requireProject(projectId);
    return this.registry.getTesterSettings(projectId);
  }

  @Put("projects/:projectId")
  put(@Param("projectId") projectId: string, @Body() b: unknown): TesterSettings {
    this.requireProject(projectId);
    const settings = normalizeTesterSettings(b);
    this.registry.setTesterSettings(projectId, settings);
    return this.registry.getTesterSettings(projectId);
  }

  private requireProject(projectId: string): void {
    if (!this.registry.listProjects().some((p) => p.id === projectId)) throw new NotFoundException("project not found");
  }
}

// The body as stored: trimmed strings, accounts without a name or a login dropped, a fresh id for
// an account that has none, the order kept. A password is kept as typed (spaces may be part of it).
export function normalizeTesterSettings(raw: unknown): TesterSettings {
  if (!raw || typeof raw !== "object") throw new BadRequestException("body must be an object");
  const b = raw as Record<string, unknown>;
  const s = (v: unknown, field: string): string => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw new BadRequestException(`${field} must be a string`);
    return v;
  };
  if (b.accounts !== undefined && !Array.isArray(b.accounts)) throw new BadRequestException("accounts must be an array");
  const seen = new Set<string>();
  const accounts: TesterAccount[] = [];
  for (const item of (b.accounts as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== "object") throw new BadRequestException("every account must be an object");
    const a = item as Record<string, unknown>;
    const name = s(a.name, "account name").trim();
    const login = s(a.login, "account login").trim();
    if (!name || !login) continue;
    let id = s(a.id, "account id").trim();
    if (!id || seen.has(id)) id = randomUUID();
    seen.add(id);
    accounts.push({ id, name, login, password: s(a.password, "account password"), note: s(a.note, "account note").trim() });
  }
  return { loginPath: s(b.loginPath, "loginPath").trim(), notes: s(b.notes, "notes").trim(), accounts };
}
