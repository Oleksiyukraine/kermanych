declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string;
    VUE_ROUTER_MODE: 'hash' | 'history' | 'abstract' | undefined;
    VUE_ROUTER_BASE: string | undefined;
  }
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  // Set by PreviewService on a preview web server (src/lib/preview.ts): the api it is
  // wired to needs no session, so the app adopts a demo user instead of showing /login.
  readonly VITE_KERMANYCH_PREVIEW?: string;
  // The cloud coordination backend — an OVERRIDE, not a requirement: with none of
  // these set, cloudEnv('ui') resolves the team's hosted project from
  // DEFAULT_CLOUD, so the app runs on a fresh clone. Set them to point at a local
  // `supabase status` stack or your own project instead; a URL without a key (or
  // the reverse) is refused rather than silently mixed. The key is public by
  // design; RLS is the authorization surface.
  //
  // Two accepted spellings of the same value: `PUBLISHABLE` is the modern
  // dashboard's `sb_publishable_…` key, `ANON` the legacy JWT a local CLI stack
  // still issues. cloudEnv('ui') prefers the publishable one.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
