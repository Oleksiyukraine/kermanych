import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY } from "./public.decorator";

type GuardedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string };
};

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private auth: AuthService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<GuardedRequest>();
    const raw = req.headers.authorization ?? req.headers.Authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (!token) throw new UnauthorizedException("missing bearer token");

    const cur = this.auth.current();
    // ONLY the cached token is accepted — expiry included. The machine's owner is
    // unambiguous, and refusing local session control because a JWT aged out (or
    // because Supabase is unreachable) would break Requirement 7. Cloud freshness
    // only gates cloud pushes, which queue in the outbox instead.
    //
    // An unknown bearer is refused even when the cloud would happily verify it:
    // adopting it here silently undid DELETE /api/auth/session, because the same
    // still-valid token re-created the session the user had just ended.
    // POST /api/auth/session is the sole way to establish a local session.
    if (cur && cur.accessToken === token) {
      req.user = { id: cur.userId };
      return true;
    }

    throw new UnauthorizedException("invalid access token");
  }
}
