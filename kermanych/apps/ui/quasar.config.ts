// Quasar App configuration (@quasar/app-vite v2)
// https://legacy-app.quasar.dev/quasar-cli-vite-v2/quasar-config-file

import { defineConfig } from '#q-app/wrappers';

export default defineConfig((ctx) => {
  return {
    // app boot files (/src/boot) — order matters
    boot: ['tokens', 'tip', 'supabase'],

    // global CSS (/src/css)
    css: ['app.scss'],

    // https://github.com/quasarframework/quasar/tree/dev/extras
    extras: [],

    build: {
      typescript: {
        strict: true,
        vueShim: true,
      },

      vueRouterMode: 'hash', // 'hash' | 'history'

      // @kermanych/core is a CJS workspace dep consumed via its built dist. Vite prebundles it
      // (optimizeDeps) and converts its CJS named exports (commonjsOptions). Two hazards handled:
      //   • prod (rollup):  commonjsOptions.include converts the dist so named exports survive.
      //   • dev  (esbuild): optimizeDeps.include prebundles it (linked workspace deps are skipped
      //     by default), and force:true re-prebundles on every start so a rebuilt dist — e.g. after
      //     a merge that adds an export like buildChatBlocks — is never masked by a stale optimize
      //     cache. A stale cache lacked the new export, it resolved to undefined, and selecting a
      //     session then threw in render, which surfaced as "clicking a session does nothing".
      extendViteConf(viteConf) {
        viteConf.build ??= {};
        viteConf.build.commonjsOptions = {
          ...viteConf.build.commonjsOptions,
          include: [/node_modules/, /packages[/\\]core[/\\]dist/, /packages[/\\]cloud[/\\]dist/],
        };
        viteConf.optimizeDeps ??= {};
        viteConf.optimizeDeps.include = [
          ...(viteConf.optimizeDeps.include ?? []),
          '@kermanych/core',
          '@kermanych/core/status',
          '@kermanych/cloud',
        ];
        // Dev only: never serve a stale prebundle of the freshly-built core dist.
        if (ctx.dev) viteConf.optimizeDeps.force = true;
      },
    },

    devServer: {
      open: false,
      port: Number(process.env.PORT) || 5317,
    },

    framework: {
      // The base look is driven entirely by @kermanych/tokens + src/css/app.scss,
      // not by Quasar's Material theme, so we don't toggle Quasar's dark mode
      // (it would override the token text color). Custom K* components come later.
      config: {},
      plugins: [],
    },

    animations: [],

    electron: {
      bundler: 'builder',
      builder: {
        appId: 'com.kermanych.app',
        productName: 'Kermanych',
        mac: { target: 'dmg', identity: null }, // identity:null → unsigned
      },
    },
  };
});
