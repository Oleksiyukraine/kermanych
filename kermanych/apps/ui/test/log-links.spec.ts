import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { logLinkTarget } from "../src/lib/log-links";
import { routeLinksToDefaultBrowser } from "../src-electron/external-links";

const ROOT = "/Users/me/proj/.worktrees/feature/x";

describe("logLinkTarget", () => {
  it("opens a repo-relative doc link as a file of the tree", () =>
    expect(logLinkTarget("docs/superpowers/specs/2026-11-04-poster-online-payment-orders-design.md", ROOT)).toEqual({
      kind: "file",
      path: "docs/superpowers/specs/2026-11-04-poster-online-payment-orders-design.md",
    }));
  it("decodes the percent-encoding markdown-it puts on non-ASCII paths", () =>
    expect(logLinkTarget("docs/%D1%81%D0%BF%D0%B5%D0%BA.md", ROOT)).toEqual({ kind: "file", path: "docs/спек.md" }));
  it("drops an editor line suffix that would otherwise read as a URL scheme", () => {
    expect(logLinkTarget("client.ts:280-288", ROOT)).toEqual({ kind: "file", path: "client.ts" });
    expect(logLinkTarget("src/a.ts:12:5", ROOT)).toEqual({ kind: "file", path: "src/a.ts" });
  });
  it("places an absolute path or file URL inside the tree relative to its root", () => {
    expect(logLinkTarget(`${ROOT}/src/a.ts`, ROOT)).toEqual({ kind: "file", path: "src/a.ts" });
    expect(logLinkTarget(`file://${ROOT}/src/a.ts#L3`, ROOT)).toEqual({ kind: "file", path: "src/a.ts" });
  });
  it("swallows links with nothing to open: anchors, folders, paths outside the tree", () => {
    expect(logLinkTarget("#heading", ROOT)).toEqual({ kind: "none" });
    expect(logLinkTarget("docs/specs/", ROOT)).toEqual({ kind: "none" });
    expect(logLinkTarget("/etc/passwd", ROOT)).toEqual({ kind: "none" });
    expect(logLinkTarget(`${ROOT}-other/a.ts`, ROOT)).toEqual({ kind: "none" });
    expect(logLinkTarget("../outside.md", ROOT)).toEqual({ kind: "none" });
    expect(logLinkTarget("src/a.ts", undefined)).toEqual({ kind: "file", path: "src/a.ts" });
    expect(logLinkTarget(`${ROOT}/src/a.ts`, undefined)).toEqual({ kind: "none" });
  });
  it("leaves web and mail links to the browser", () => {
    expect(logLinkTarget("https://example.com/a.md", ROOT)).toBeNull();
    expect(logLinkTarget("http://localhost:3000", ROOT)).toBeNull();
    expect(logLinkTarget("mailto:a@b.c", ROOT)).toBeNull();
    expect(logLinkTarget("//cdn.example.com/x", ROOT)).toBeNull();
  });
});

describe("routeLinksToDefaultBrowser: will-navigate", () => {
  function setup(appUrl: string) {
    let onNavigate: ((e: { url: string; preventDefault: () => void }) => void) | undefined;
    const win = {
      webContents: {
        setWindowOpenHandler: () => {},
        on: (_: string, cb: typeof onNavigate) => { onNavigate = cb; },
        getURL: () => appUrl,
      },
    } as unknown as BrowserWindow;
    const openExternal = vi.fn((_url: string) => Promise.resolve());
    routeLinksToDefaultBrowser(win, openExternal);
    return (url: string) => {
      const preventDefault = vi.fn();
      onNavigate!({ url, preventDefault });
      return { prevented: preventDefault.mock.calls.length > 0, opened: openExternal.mock.calls.map((c) => c[0]) };
    };
  }

  it("keeps the app when a relative doc link resolves against the packaged file:// app", () => {
    const nav = setup("file:///Applications/Kermanych.app/Contents/Resources/app.asar/index.html#/agents");
    expect(nav("file:///Applications/Kermanych.app/Contents/Resources/app.asar/docs/specs/x.md")).toEqual({ prevented: true, opened: [] });
  });
  it("keeps the app when a relative doc link resolves against the dev server", () => {
    const nav = setup("http://localhost:9000/#/agents");
    expect(nav("http://localhost:9000/docs/specs/x.md")).toEqual({ prevented: true, opened: [] });
  });
  it("lets the app reload its own document", () => {
    const nav = setup("http://localhost:9000/#/agents");
    expect(nav("http://localhost:9000/")).toEqual({ prevented: false, opened: [] });
  });
  it("sends another origin to the default browser", () => {
    const nav = setup("http://localhost:9000/#/agents");
    expect(nav("https://example.com/a")).toEqual({ prevented: true, opened: ["https://example.com/a"] });
  });
});
