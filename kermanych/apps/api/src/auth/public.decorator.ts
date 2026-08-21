import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "kermanych:isPublic";

// SupabaseAuthGuard is registered as APP_GUARD, so it covers every route in the
// app. @Public() is the only escape hatch: it marks the handful of endpoints that
// must work before a token exists — today just POST /api/auth/session.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
