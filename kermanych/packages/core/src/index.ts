// `export *` stays here only because no renderer code imports a RUNTIME value from this
// barrel: the api is CommonJS (where `__exportStar` works) and the ui takes values from
// "@kermanych/core/status" and types — erased at build time — from here. The moment a
// renderer module needs a runtime value off this barrel it will be `undefined`, because
// Vite's cjs-module-lexer cannot see through `__exportStar`; switch to explicit named
// re-exports then, as packages/cloud/src/index.ts already had to.
export * from "./types";
export * from "./tool-summary";
export * from "./rpc-frames";
export * from "./status";
export * from "./worktree-names";
export * from "./platform";
