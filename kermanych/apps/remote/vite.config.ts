import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// «Пульт»'s phone client (docs/specs/2026-11-24-mobile-remote-control.md → Client). The api's
// RemoteServer serves `dist/` at `/` behind `tailscale serve`, so the base is the root and every
// asset path is absolute. `public/` carries the manifest, the service worker and the icons
// verbatim: `sw.js` must stay at `/sw.js` so its scope covers the whole app.
export default defineConfig({
  base: "/",
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // @kermanych/core is a CJS workspace dep consumed through its built dist (same hazard as
    // apps/ui/quasar.config.ts): rollup converts its named exports only when the dist is listed.
    // The client imports values only from core's leaf modules (`/remote`, `/status`), never the
    // barrel, which would pull the whole core into the phone bundle.
    commonjsOptions: { include: [/node_modules/, /packages[/\\]core[/\\]dist/] },
  },
  // Dev: linked workspace deps are not prebundled by default, and CJS modules need it.
  optimizeDeps: { include: ["@kermanych/core/remote", "@kermanych/core/status"] },
  server: {
    // `pnpm --filter @kermanych/remote dev` against a running api: the remote server's port is
    // given in REMOTE_DEV_TARGET (e.g. http://127.0.0.1:4318) so `/remote/*` stays same-origin.
    proxy: process.env.REMOTE_DEV_TARGET
      ? { "/remote": { target: process.env.REMOTE_DEV_TARGET, ws: true } }
      : undefined,
  },
});
