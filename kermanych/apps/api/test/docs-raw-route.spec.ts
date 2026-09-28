import "reflect-metadata";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectsController } from "../src/http/projects.controller";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { EnvFileService } from "../src/env/env-file.service";
import { DocIndexService } from "../src/docs/doc-index.service";
import { WorktreeService } from "../src/worktree/worktree.service";

// esbuild (vitest's transformer) emits no design:paramtypes, so declare the controller's
// constructor deps by hand for Nest to inject the stubs below.
Reflect.defineMetadata(
  "design:paramtypes",
  [SupervisorService, RegistryService, EnvFileService, DocIndexService],
  ProjectsController,
);

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');

describe("GET /projects/:id/docs/raw over HTTP", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-raw-"));
    mkdirSync(join(dir, "schemas"));
    writeFileSync(join(dir, "schemas", "diagram.svg"), SVG);
    const wt = new WorktreeService();
    const sup = { docsRaw: (_id: string, _folder: string, path: string) => wt.readFileBytes(dir, path) };

    @Module({
      controllers: [ProjectsController],
      providers: [
        { provide: SupervisorService, useValue: sup },
        { provide: RegistryService, useValue: {} },
        { provide: EnvFileService, useValue: {} },
        { provide: DocIndexService, useValue: {} },
      ],
    })
    class RawRouteModule {}

    app = await NestFactory.create(RawRouteModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(() => app?.close());

  // A Buffer returned straight from the handler is JSON-serialized by Nest's Express
  // adapter ({"type":"Buffer","data":[…]}), which an <img> cannot decode.
  it("serves the file's exact bytes under its image Content-Type", async () => {
    const r = await fetch(`${base}/projects/p/docs/raw?folder=docs&path=schemas/diagram.svg`);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(SVG)).toBe(true);
    expect(r.headers.get("content-type")).toMatch(/^image\/svg\+xml\b/);
  });
});
