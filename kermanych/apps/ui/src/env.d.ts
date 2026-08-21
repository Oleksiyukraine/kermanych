declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string;
    VUE_ROUTER_MODE: 'hash' | 'history' | 'abstract' | undefined;
    VUE_ROUTER_BASE: string | undefined;
  }
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  // The cloud coordination backend. Both are REQUIRED: the app cannot render
  // without a Supabase client. Values come from `supabase status` (local) or the
  // project's API settings (hosted). The anon key is public by design; RLS is the
  // authorization surface.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
