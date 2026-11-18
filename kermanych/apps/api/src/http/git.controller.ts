// apps/api/src/http/git.controller.ts
// The project wizard's routes (docs/specs/2026-11-18-first-run-and-project-wizard.md): a folder
// on this machine, a remote's default branch, the clone job, and the GitHub token check and
// repository list. Tokens arrive only in request bodies — never in a URL, where an access log
// would keep them — and go only to git's credential helper or GitHub's Authorization header.
// Refusals the wizard reacts to carry a stable message (`target_not_empty`,
// `invalid_clone_request`, `token_invalid`, `github_rate_limited`); anything else is git's or
// GitHub's own sentence.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import type { GitCloneState, GitInspect, GithubRepo } from "@kermanych/core";
import { GitSetupService } from "../git/git-setup.service";
import { GithubClient, GithubHttpError } from "../github/github-client";

@Controller()
export class GitController {
  constructor(private git: GitSetupService) {}

  @Post("git/inspect")
  async inspect(@Body() b: { path?: string }): Promise<GitInspect> {
    if (typeof b?.path !== "string" || !b.path.trim()) throw new BadRequestException("path cannot be empty");
    try {
      return await this.git.inspect(b.path);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post("git/remote-head")
  async remoteHead(@Body() b: { url?: string; token?: string }): Promise<{ defaultBranch: string | null }> {
    try {
      return { defaultBranch: await this.git.remoteHead(String(b?.url ?? ""), String(b?.token ?? "")) };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post("git/clone")
  async clone(@Body() b: { url?: string; parentDir?: string; dirName?: string; token?: string }): Promise<GitCloneState> {
    try {
      return await this.git.clone({
        url: String(b?.url ?? ""),
        parentDir: String(b?.parentDir ?? ""),
        dirName: String(b?.dirName ?? ""),
        token: String(b?.token ?? ""),
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get("git/clone/:jobId")
  get(@Param("jobId") jobId: string): GitCloneState {
    const state = this.git.get(jobId);
    if (!state) throw new NotFoundException("clone job not found");
    return state;
  }

  @Post("git/clone/:jobId/cancel")
  async cancel(@Param("jobId") jobId: string): Promise<GitCloneState> {
    const state = await this.git.cancel(jobId);
    if (!state) throw new NotFoundException("clone job not found");
    return state;
  }

  @Post("github/token-check")
  async tokenCheck(@Body() b: { token?: string }): Promise<{ login: string }> {
    const token = String(b?.token ?? "").trim();
    if (!token) throw new BadRequestException("token_invalid");
    try {
      const { login } = await new GithubClient(token).user();
      return { login };
    } catch (err) {
      throw githubRefusal(err);
    }
  }

  @Post("github/repos")
  async repos(@Body() b: { token?: string }): Promise<GithubRepo[]> {
    const token = String(b?.token ?? "").trim();
    if (!token) throw new BadRequestException("token_invalid");
    try {
      return await new GithubClient(token).repos();
    } catch (err) {
      throw githubRefusal(err);
    }
  }
}

// A GitHub failure as the wizard's 400: an unknown or expired token, a spent hourly budget, any
// other status as GitHub's own, and an unreachable GitHub (offline, timeout) as the network's.
function githubRefusal(err: unknown): BadRequestException {
  if (err instanceof GithubHttpError) {
    if (err.rateLimited) return new BadRequestException("github_rate_limited");
    if (err.status === 401) return new BadRequestException("token_invalid");
    return new BadRequestException(err.message);
  }
  const e = err as Error & { cause?: { message?: string } };
  return new BadRequestException(`GitHub unreachable: ${e.cause?.message ?? e.message}`);
}
