// Quasar App configuration (@quasar/app-vite v2)
// https://legacy-app.quasar.dev/quasar-cli-vite-v2/quasar-config-file

import { defineConfig } from '#q-app/wrappers';

export default defineConfig(() => {
  return {
    // app boot files (/src/boot) — order matters
    boot: ['tokens', 'supabase'],

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

      // @kermanych/core is a CJS workspace dep resolved to its real path OUTSIDE
      // node_modules, so Vite treats it as raw source and never runs CJS→ESM interop;
      // named imports (e.g. shouldNotify from /status) then fail. Both build paths need it:
      //   • prod (rollup):  build.commonjsOptions.include converts its dist.
      //   • dev  (esbuild): optimizeDeps.include force-prebundles it — linked workspace
      //     deps are excluded from dep pre-bundling by default, so this is required.
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
