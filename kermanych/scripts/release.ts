// Release tooling for the desktop app (docs/specs/2026-10-12-desktop-releases-and-updates.md).
//
//   pnpm release:prepare <version>   bump apps/ui/package.json and open a CHANGELOG.md section
//   pnpm release:notes <version>     (the release workflow) check the tag against the package
//                                    version and print that version's notes; fails on no notes
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, compareAppVersions, isAppVersion } from "../packages/core/src/app-release";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PKG = join(ROOT, "apps", "ui", "package.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function readPkg(): { version: string } & Record<string, unknown> {
  const pkg: unknown = JSON.parse(readFileSync(PKG, "utf8"));
  if (!pkg || typeof pkg !== "object" || !("version" in pkg) || typeof pkg.version !== "string") {
    fail(`${PKG} has no version`);
  }
  return { ...pkg, version: pkg.version };
}

function prepare(version: string): void {
  const pkg = readPkg();
  if (compareAppVersions(version, pkg.version) !== 1) fail(`${version} is not higher than the current ${pkg.version}`);
  const changelog = readFileSync(CHANGELOG, "utf8");
  if (changelogSection(changelog, version)) fail(`CHANGELOG.md already has a ${version} section`);

  writeFileSync(PKG, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  // The new section goes above the newest one (or at the end of a file that has none yet).
  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${version} — ${date}\n\n- \n\n`;
  const at = changelog.search(/^## /m);
  writeFileSync(CHANGELOG, at === -1 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, at) + section + changelog.slice(at));

  console.log(`apps/ui/package.json → ${version}; CHANGELOG.md has an empty ${version} section.`);
  console.log("Write the notes (in English), merge the PR, then:");
  console.log(`  git tag v${version} && git push origin v${version}`);
}

function notes(version: string): void {
  const pkg = readPkg();
  if (pkg.version !== version) fail(`tag v${version} does not match apps/ui/package.json version ${pkg.version}`);
  const entry = changelogSection(readFileSync(CHANGELOG, "utf8"), version);
  if (!entry) fail(`CHANGELOG.md has no ${version} section`);
  // `- ` alone is the placeholder release:prepare writes.
  if (!entry.body || entry.body === "-") fail(`CHANGELOG.md's ${version} section is empty`);
  process.stdout.write(`${entry.body}\n`);
}

const [command, raw] = process.argv.slice(2);
const version = (raw ?? "").replace(/^v/, "");
if (!isAppVersion(version)) fail(`expected a version like 1.2.3, got "${raw ?? ""}"`);
if (command === "prepare") prepare(version);
else if (command === "notes") notes(version);
else fail(`unknown command "${command ?? ""}" (prepare | notes)`);
