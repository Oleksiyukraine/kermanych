import { BadRequestException, Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  // The ONE public route: the UI cannot present a bearer token before it has
  // handed one over. Everything after this is guarded.
  @Public()
  @Post("session")
  async setSession(@Body() body: { accessToken: string }) {
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

  @Get("session")
  getSession() {
    const cur = this.auth.current();
    if (!cur) return { signedIn: false };
    return {
      signedIn: true,
      userId: cur.userId,
      githubUsername: cur.githubUsername,
      expiresAt: cur.expiresAt,
    };
  }
}
