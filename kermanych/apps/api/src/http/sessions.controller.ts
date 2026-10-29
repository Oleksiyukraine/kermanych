// apps/api/src/http/sessions.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, StreamableFile } from "@nestjs/common";
import { isNativeHarness, isThinkingLevel, parseFindingTarget } from "@kermanych/core";
import type { BranchPrefix, DocsWriteKind, ImageInput, Platform, RpcExtensionUIResponse, TaskDraft, ThinkingLevel } from "@kermanych/core";
import { SupervisorService } from "../supervisor/supervisor.service";
import { sessionFailure } from "./session-failure";
import { RegistryService } from "../registry/registry.service";
import { PreviewService } from "../preview/preview.service";

// A findings failure: an unknown session or finding is a 404, an already-decided one a 400.
function findingFailure(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return message === "session not found" || message === "finding not found" ? new NotFoundException(message) : new BadRequestException(message);
}

@Controller("sessions")
export class SessionsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private preview: PreviewService,
  ) {}

  @Get()
  list(@Query("projectId") projectId?: string) {
    return this.reg.listSessions(projectId);
  }

  // `native` opens the chat as that harness's own TUI (docs/specs/2026-10-06-native-chats.md).
  @Post("chat")
  async createChat(@Body() b: { projectId: string; native?: string }) {
    if (b.native !== undefined && !isNativeHarness(b.native)) throw new BadRequestException(`unknown native harness ${JSON.stringify(b.native)}`);
    try {
      return await this.sup.createChat(b.projectId, b.native);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // A literal segment, so it MUST be declared above the `:id` block — Nest matches in
  // declaration order and `:id/...` would otherwise swallow `from-task` (same reason
  // `@Post("chat")` sits above `@Post(":id/promote")`).
  // The task id is the ONLY identity input: who may run it comes from the guard's cached
  // token, never from the request body. `images` are the first prompt's attachments; they
  // stay on this machine and never reach the cloud. `native` launches the task as a native
  // session of that harness (docs/specs/2026-10-05-native-sessions.md).
  @Post("from-task")
  async createFromTask(@Body() b: { taskId: string; images?: ImageInput[]; native?: string }, @Req() req: { user: { id: string } }) {
    if (b.native !== undefined && !isNativeHarness(b.native)) throw new BadRequestException(`unknown native harness ${JSON.stringify(b.native)}`);
    try {
      return await this.sup.createSessionFromTask(b.taskId, req.user.id, b.images, b.native);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // A chat carries everything else the promotion needs (its conversation, its opening ask);
  // the task id is the card the UI has just minted for it.
  @Post(":id/promote")
  async promote(@Param("id") id: string, @Body() b: { taskId: string }) {
    try {
      return await this.sup.promoteChatToAgent(id, b.taskId);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/message")
  async message(@Param("id") id: string, @Body() b: { text: string; mode: "prompt" | "follow_up" | "steer"; images?: ImageInput[] }) {
    try {
      return await this.sup.sendMessage(id, b.text, b.mode, b.images);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // The composer's effort chip. The level is validated here rather than trusted: it goes on to
  // become an omp argv value / RPC frame field, and omp's own refusal would never reach the UI.
  @Post(":id/effort")
  async effort(@Param("id") id: string, @Body() b: { level: string }) {
    if (!isThinkingLevel(b.level)) throw new BadRequestException(`unknown effort level ${JSON.stringify(b.level)}`);
    try {
      return await this.sup.setEffort(id, b.level);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // Model and/or reasoning effort of an existing session. `provider` is required alongside a
  // model because omp's set_model is addressed by provider + id, and the picker always has it
  // from GET /models — a body without it is a caller that guessed.
  @Post(":id/model")
  async setModel(@Param("id") id: string, @Body() b: { model?: string; provider?: string; effort?: ThinkingLevel }) {
    if (b.model && !b.provider) throw new BadRequestException("провайдер моделі не вказано");
    try {
      return await this.sup.setSessionModel(id, b);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/branch")
  async branch(@Param("id") id: string) {
    try {
      return await this.sup.branchSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/review")
  async review(@Param("id") id: string) {
    try {
      return await this.sup.reviewSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/merge")
  async merge(@Param("id") id: string, @Body() b: { summary?: string }) {
    try {
      return await this.sup.mergeDiscussion(id, b.summary);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/answer")
  answer(@Param("id") id: string, @Body() b: { res: RpcExtensionUIResponse }) {
    try {
      return this.sup.answerUi(id, b.res);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/stop")
  async stop(@Param("id") id: string) {
    try {
      await this.sup.stopSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
    return { ok: true };
  }

  @Get(":id/transcript")
  transcript(@Param("id") id: string) {
    return this.sup.sessionTranscript(id);
  }

  // Deliberately unwrapped: the `try/catch → BadRequestException` the @Post siblings use would
  // swallow the service's GoneException and turn the 410 into a 400, collapsing the UI's
  // "output expired" branch into a generic error.
  @Get(":id/tools/:callId")
  toolDetail(@Param("id") id: string, @Param("callId") callId: string) {
    return this.sup.getToolDetail(id, callId);
  }

  // Unwrapped like toolDetail: getSubagentTranscript throws GoneException for a dormant
  // session, and the UI's "session inactive" branch relies on that 410 reaching it.
  @Get(":id/subagents/:subagentId/transcript")
  subagentTranscript(@Param("id") id: string, @Param("subagentId") subagentId: string) {
    return this.sup.getSubagentTranscript(id, subagentId);
  }

  @Post(":id/preview")
  async startPreview(@Param("id") id: string) {
    try {
      return await this.preview.start(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Delete(":id/preview")
  stopPreview(@Param("id") id: string) {
    this.preview.stop(id);
    return { ok: true };
  }

  @Get(":id/finish")
  async finishInfo(@Param("id") id: string) {
    try {
      return await this.sup.finishInfo(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // A read, so GET; the path rides in the query, where its slashes need no route gymnastics.
  @Get(":id/diff")
  async fileDiff(@Param("id") id: string, @Query("path") path?: string) {
    try {
      return await this.sup.fileDiff(id, path ?? "");
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // The Файли tab: one level of the worktree tree, and one file read-only. GETs with the
  // path in the query, the same shape as :id/diff above.
  @Get(":id/tree")
  async tree(@Param("id") id: string, @Query("path") path?: string) {
    try {
      return await this.sup.sessionTree(id, path ?? "");
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Get(":id/file")
  async file(@Param("id") id: string, @Query("path") path?: string) {
    try {
      return await this.sup.sessionFile(id, path ?? "");
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // Raw bytes for the viewer's preview mode (a PDF has no text body). StreamableFile for the
  // same reason as /projects/:id/docs/raw: a bare Buffer would be JSON-serialized.
  @Get(":id/raw")
  async raw(@Param("id") id: string, @Query("path") path?: string) {
    let file: { bytes: Buffer; contentType: string } | null;
    try {
      file = await this.sup.sessionRaw(id, path ?? "");
    } catch (err) {
      throw sessionFailure(err);
    }
    if (!file) throw new NotFoundException("file not found");
    return new StreamableFile(file.bytes, { type: file.contentType, length: file.bytes.length });
  }

  // A failing documentation gate is a plain 400 starting `documentation required:`.
  @Post(":id/finish")
  async finish(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      return await this.sup.finishSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // The merged-PR check (docs/specs/2026-10-26-pr-merged-close-prompt.md): GitHub failures come
  // back as a PrCheck state, so only an unknown session is a 400.
  @Get(":id/pr")
  async prCheck(@Param("id") id: string) {
    try {
      return await this.sup.prCheck(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Закрити задачу»: finish without the documentation gate, only once GitHub confirms the
  // merge; otherwise a 400 `pr is not merged`.
  @Post(":id/close-merged")
  async closeMerged(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      return await this.sup.closeMerged(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/pr")
  async pr(@Param("id") id: string) {
    try {
      return await this.sup.createPullRequest(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/commit")
  async commit(@Param("id") id: string) {
    try {
      return await this.sup.commitChanges(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Зберегти дизайн» (docs/specs/2026-10-29-design-tab.md): `{ sent: true }`; a 400 for a
  // session that is not a design.
  @Post(":id/design/save")
  async saveDesign(@Param("id") id: string) {
    try {
      return await this.sup.saveDesign(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Доповнити документацію»: one Kermanych prompt for exactly the missing documents.
  // `{ sent: false }` when nothing was missing.
  @Post(":id/docs")
  async completeDocs(@Param("id") id: string) {
    try {
      return await this.sup.completeDocs(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Написати запит на API» / «Написати хендоф»: the agent writes that one document now,
  // mid-task, whatever the project's documentation rules.
  @Post(":id/docs/write")
  async writeDoc(@Param("id") id: string, @Body() b?: { kind?: string }) {
    const kind = b?.kind;
    if (kind !== "apiRequest" && kind !== "handoff") throw new BadRequestException(`unknown document kind ${JSON.stringify(kind)}`);
    try {
      return await this.sup.writeDoc(id, kind satisfies DocsWriteKind);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Знахідки» (docs/specs/2026-10-13-agent-findings.md): what the session's agent reported,
  // and the operator's decision on one. Filing itself (board card / Jira issue) happens before
  // `filed` is called, under the operator's own credentials.
  @Get(":id/findings")
  listFindings(@Param("id") id: string) {
    try {
      return this.sup.listFindings(id);
    } catch (err) {
      throw findingFailure(err);
    }
  }

  @Post(":id/findings/:findingId/filed")
  findingFiled(@Param("id") id: string, @Param("findingId") findingId: string, @Body() b: unknown) {
    const target = parseFindingTarget(b);
    if (!target) throw new BadRequestException("body must be { kind: \"board\", taskId } or { kind: \"jira\", key, url }");
    try {
      return this.sup.resolveFinding(id, findingId, { status: "filed", target });
    } catch (err) {
      throw findingFailure(err);
    }
  }

  @Post(":id/findings/:findingId/dismiss")
  dismissFinding(@Param("id") id: string, @Param("findingId") findingId: string) {
    try {
      return this.sup.resolveFinding(id, findingId, { status: "dismissed" });
    } catch (err) {
      throw findingFailure(err);
    }
  }

  @Post(":id/archive")
  async archive(@Param("id") id: string) {
    try {
      await this.sup.setArchived(id, true);
    } catch (err) {
      throw sessionFailure(err);
    }
    return { ok: true };
  }

  @Post(":id/unarchive")
  async unarchive(@Param("id") id: string) {
    try {
      await this.sup.setArchived(id, false);
    } catch (err) {
      throw sessionFailure(err);
    }
    return { ok: true };
  }

  @Post(":id/rename")
  rename(@Param("id") id: string, @Body() b: { name?: string }) {
    try {
      return this.sup.renameSession(id, b.name ?? "");
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/editor")
  openEditor(@Param("id") id: string) {
    try {
      return this.sup.openInEditor(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/resolve")
  async resolve(@Param("id") id: string) {
    try {
      return await this.sup.resolveConflict(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // Non-destructive counterpart to :id/restart — wakes a dormant session so its transcript
  // rehydrates, and leaves a live one (and its running turn) alone.
  @Post(":id/resume")
  async resume(@Param("id") id: string) {
    try {
      return await this.sup.resume(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/restart")
  async restart(@Param("id") id: string) {
    try {
      return await this.sup.restartSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  // «Запустити зараз» on a card waiting for an agent slot: starts it past the limit, this once.
  @Post(":id/run-now")
  async runNow(@Param("id") id: string) {
    try {
      return await this.sup.runNow(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Post(":id/reopen")
  async reopen(@Param("id") id: string) {
    try {
      return await this.sup.reopenSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      await this.sup.deleteSession(id);
    } catch (err) {
      throw sessionFailure(err);
    }
    return { ok: true };
  }
}
