declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string;
    VUE_ROUTER_MODE: 'hash' | 'history' | 'abstract' | undefined;
    VUE_ROUTER_BASE: string | undefined;
  }
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  // The cloud coordination backend. A URL and a key are REQUIRED: the app cannot
  // render without a Supabase client. Values come from `supabase status` (local)
  // or the project's API settings (hosted). The key is public by design; RLS is
  // the authorization surface.
  //
  // Two accepted spellings of the same value: `PUBLISHABLE` is the modern
  // dashboard's `sb_publishable_…` key, `ANON` the legacy JWT a local CLI stack
  // still issues. Both are optional here because only one has to be set;
  // cloudEnv('ui') prefers the publishable one and throws when neither is there.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
