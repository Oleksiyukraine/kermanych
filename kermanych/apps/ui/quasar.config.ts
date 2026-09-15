// Quasar App configuration (@quasar/app-vite v2)
// https://legacy-app.quasar.dev/quasar-cli-vite-v2/quasar-config-file

import { defineConfig } from '#q-app/wrappers';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export default defineConfig((ctx) => {
  return {
    // app boot files (/src/boot) — order matters
    boot: ['tokens', 'i18n', 'tip', 'supabase'],

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

      // Quasar always runs `<packager> install` inside dist/electron/UnPackaged before
      // packaging. In a pnpm workspace the default `pnpm install --prod` resolves UP to
      // the monorepo ROOT (UnPackaged lives inside it), wipes the root node_modules and
      // reinstalls it with --prod — deleting every devDependency (tsc, vite, quasar,
      // electron-builder) and then crashing #packageFiles (quasar #18139). `--ignore-workspace`
      // alone is not enough here because @kermanych/ui has real `workspace:*` runtime deps
      // that can only be resolved via the workspace, so we make Quasar's forced step inert
      // (`pnpm -v`) and provision the production node_modules ourselves in beforePackaging().
      unPackagedInstallParams: ['-v'],

      builder: {
        appId: 'com.kermanych.app',
        productName: 'Kermanych',
        mac: { target: 'dmg', identity: null }, // identity:null → unsigned
        // better-sqlite3's native .node must live OUTSIDE the asar — Electron cannot dlopen
        // from an archive. Its v13 prebuilds are N-API (ABI-stable across Node/Electron), so
        // unpacking them suffices; electron-builder's own native rebuild is unnecessary here.
        asarUnpack: ['**/node_modules/better-sqlite3/**'],
        npmRebuild: false,
      },

      // The Electron main process externalizes @kermanych/api (see the esbuild bundle),
      // which pulls in NestJS, native better-sqlite3 and @kermanych/{core,cloud} through
      // `workspace:*` deps. `pnpm deploy` is the only thing that flattens that graph into a
      // self-contained node_modules; we then hand it to electron-builder to pack.
      async beforePackaging({ appPaths, unpackagedDir }: { appPaths: { appDir: string }; unpackagedDir: string }) {
        const repoRoot = resolve(appPaths.appDir, '..', '..');
        const deployTmp = join(unpackagedDir, '..', 'deploy-tmp');
        rmSync(deployTmp, { recursive: true, force: true });
        mkdirSync(deployTmp, { recursive: true });

        // --legacy: pnpm 10 refuses to deploy non-injected workspaces otherwise.
        // node-linker=hoisted: real files (no symlinks asar cannot follow into the store).
        // --ignore-scripts: the deployed tree needs no lifecycle scripts — better-sqlite3's
        //   N-API prebuilds load as-is under Electron's ABI (see builder.asarUnpack above).
        execFileSync(
          'pnpm',
          [
            '--filter=@kermanych/ui',
            '--prod',
            '--legacy',
            '--config.node-linker=hoisted',
            '--ignore-scripts',
            'deploy',
            deployTmp,
          ],
          { cwd: repoRoot, stdio: 'inherit' },
        );

        const dest = join(unpackagedDir, 'node_modules');
        rmSync(dest, { recursive: true, force: true });
        renameSync(join(deployTmp, 'node_modules'), dest);
        rmSync(deployTmp, { recursive: true, force: true });

        // Quasar keeps `workspace:*` specifiers in the generated manifest; rewrite them to
        // '*' so electron-builder's production-dependency scan accepts them (the packages are
        // already present in node_modules from the deploy above).
        const pkgPath = join(unpackagedDir, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            dependencies?: Record<string, string>;
          };
          if (pkg.dependencies) {
            for (const [name, spec] of Object.entries(pkg.dependencies)) {
              if (typeof spec === 'string' && spec.startsWith('workspace:')) {
                pkg.dependencies[name] = '*';
              }
            }
            writeFileSync(pkgPath, JSON.stringify(pkg));
          }
        }
      },
    },
  };
});
