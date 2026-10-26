import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { bearerToken } from "./auth.guard";
import { Public } from "./public.decorator";
import { provesAppUi } from "./ui-proof";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  // The ONE public route: the UI cannot present a bearer token before it has
  // handed one over. Everything after this is guarded — so the handoff itself must
  // come from the app's own ui (ui-proof.ts): the current bearer (a token refresh), the
  // desktop app's per-launch key, or a trusted dev-ui Origin. A valid Supabase JWT alone
  // is not enough: any page in the operator's browser could otherwise push its own
  // account's token and take over the api. 403, not 401: the ui reads 401 as «signed out».
  @Public()
  @Post("session")
  async setSession(
    @Body() body: { accessToken: string },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!this.auth.userForToken(bearerToken(headers)) && !provesAppUi(headers)) {
      throw new ForbiddenException("the session handoff must come from the Kermanych ui");
    }
    try {
      if (!body?.accessToken) throw new Error("accessToken is required");
      return await this.auth.setToken(body.accessToken);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // Guarded on purpose: sign-out must be presented by the signed-in token, so a
  // stray request cannot log the machine out. The UI sends this BEFORE it drops
  // its local copy of the token.
  @Delete("session")
  clearSession() {
    this.auth.clear();
    return { ok: true };
  }

  // Guarded like every other route: reaching this handler means the guard already
  // matched the bearer against the cached session, so `current()` is defined.
  @Get("session")
  getSession() {
    const cur = this.auth.current()!;
    return {
      signedIn: true,
      userId: cur.userId,
      githubUsername: cur.githubUsername,
      expiresAt: cur.expiresAt,
    };
  }
}
