// «Пульт»'s Tailscale side (docs/specs/2026-11-24-mobile-remote-control.md → Tailscale, decisions 6
// and 10): the CLI's JSON read by pure parsers, and the process calls over a fake runner. No real
// Tailscale, no network.
import { describe, expect, it } from "vitest";
import { ToolError, type RunOptions, type RunResult } from "../src/device/device-proc";
import {
  chooseHttpsPort,
  findOnPath,
  isOurServeTarget,
  parseOperator,
  parseServeStatus,
  parseTailscaleStatus,
  serveFailure,
  Tailscale,
  type TailscaleHost,
} from "../src/remote/tailscale";

// `tailscale status --json` of a signed-in Mac with MagicDNS and HTTPS certificates on (trimmed).
const STATUS_RUNNING = JSON.stringify({
  Version: "1.78.1",
  BackendState: "Running",
  Self: { ID: "n1", HostName: "mac", DNSName: "mac.tail1234.ts.net.", OS: "macOS", UserID: 12345 },
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "operator@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: ["mac.tail1234.ts.net"],
  User: { "12345": { ID: 12345, LoginName: "operator@example.com", DisplayName: "Operator" }, "777": { ID: 777, LoginName: "peer@example.com" } },
  Peer: {},
});

describe("parseTailscaleStatus", () => {
  it("reads running, the DNS name without its dot, HTTPS and the login", () => {
    expect(parseTailscaleStatus(STATUS_RUNNING)).toEqual({ running: true, https: true, dnsName: "mac.tail1234.ts.net", login: "operator@example.com" });
  });

  it("reads HTTPS certificates off as no https", () => {
    const j = JSON.parse(STATUS_RUNNING) as Record<string, unknown>;
    expect(parseTailscaleStatus(JSON.stringify({ ...j, CertDomains: null })).https).toBe(false);
    expect(parseTailscaleStatus(JSON.stringify({ ...j, CertDomains: [] })).https).toBe(false);
  });

  it("reads a signed-out or stopped daemon, and garbage, as not running", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" }, CertDomains: null })).running).toBe(false);
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" })).running).toBe(false);
    expect(parseTailscaleStatus("failed to connect to local tailscaled")).toEqual({ running: false, https: false });
  });
});

describe("parseServeStatus and the port choice", () => {
  // The operator serves their dev server on 443 and 8443; a leftover rule of ours sits on 8444.
  const SERVE = JSON.stringify({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true }, "8444": { HTTPS: true }, "2222": { TCPForward: "127.0.0.1:22" } },
    Web: {
      "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      "mac.tail1234.ts.net:8443": { Handlers: { "/": { Path: "/srv/www" } } },
      "mac.tail1234.ts.net:8444": { Handlers: { "/": { Proxy: "http://127.0.0.1:51234" } } },
    },
  });

  it("maps every served port to its targets", () => {
    const used = parseServeStatus(SERVE);
    expect(used.get(443)).toEqual(["http://127.0.0.1:3000"]);
    expect(used.get(8443)).toEqual(["path:/srv/www"]);
    expect(used.get(8444)).toEqual(["http://127.0.0.1:51234"]);
    expect(used.get(2222)).toEqual(["tcp:127.0.0.1:22"]);
  });

  it("reads no config as no ports, and counts a foreground session's rule", () => {
    expect(parseServeStatus("").size).toBe(0);
    expect(parseServeStatus("{}").size).toBe(0);
    const fg = parseServeStatus(JSON.stringify({ Foreground: { s1: { TCP: { "8445": { HTTPS: true } }, Web: { "mac:8445": { Handlers: { "/": { Text: "hi" } } } } } } }));
    expect(fg.get(8445)).toEqual(["text:hi"]);
  });

  it("keeps the stored port while only our rule is on it, else takes the first free one", () => {
    const used = parseServeStatus(SERVE);
    expect(chooseHttpsPort(used, 8444)).toBe(8444);
    expect(chooseHttpsPort(used, undefined)).toBe(8445);
    expect(chooseHttpsPort(used, 8443)).toBe(8445);
    expect(chooseHttpsPort(new Map(), undefined)).toBe(8443);
    expect(chooseHttpsPort(new Map(), 8450)).toBe(8450);
    const full = new Map(Array.from({ length: 11 }, (_, i) => [8443 + i, ["path:/x"]] as [number, string[]]));
    expect(chooseHttpsPort(full, undefined)).toBeUndefined();
  });

  it("recognises our rule's shape only", () => {
    expect(isOurServeTarget("http://127.0.0.1:51234")).toBe(true);
    expect(isOurServeTarget("http://127.0.0.1:51234/")).toBe(true);
    expect(isOurServeTarget("http://localhost:3000")).toBe(false);
    expect(isOurServeTarget("https+insecure://127.0.0.1:8443")).toBe(false);
    expect(isOurServeTarget("path:/srv")).toBe(false);
  });
});

describe("parseOperator (Linux, decision 10)", () => {
  const user = { username: "alice", uid: 1000 };
  it("is the operator when `tailscale debug prefs` names this user", () => {
    expect(parseOperator(JSON.stringify({ ControlURL: "https://controlplane.tailscale.com", OperatorUser: "alice" }), user)).toBe(true);
    expect(parseOperator(JSON.stringify({ OperatorUser: "bob" }), user)).toBe(false);
    expect(parseOperator(JSON.stringify({ OperatorUser: "" }), user)).toBe(false);
    expect(parseOperator("not json", user)).toBe(false);
  });
  it("root always is", () => {
    expect(parseOperator("{}", { username: "root", uid: 0 })).toBe(true);
  });
});

describe("serveFailure", () => {
  it("leads with the consent link when serve waits for HTTPS to be enabled", () => {
    const err = new ToolError("tailscale serve --bg --https=8443 did not finish in 20 s", null, "", "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n");
    expect(serveFailure(err)).toContain("https://login.tailscale.com/f/serve?node=abc");
  });
  it("keeps the CLI's own words otherwise", () => {
    expect(serveFailure(new ToolError("tailscale serve failed (exit 1): Access denied", 1, "Access denied"))).toBe("tailscale serve failed (exit 1): Access denied");
  });
});

// ── Process calls over a fake runner ─────────────────────────────────────────

function host(over: Partial<TailscaleHost> = {}, files: string[] = []): TailscaleHost {
  return { platform: "darwin", path: "/usr/bin:/bin", executable: (f) => files.includes(f), user: () => ({ username: "alice", uid: 1000 }), ...over };
}

function fakeRunner(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const a = answers[line];
    if (a instanceof Error) throw a;
    return { code: a === undefined ? 1 : 0, stdout: Buffer.from(a ?? ""), stderr: "" };
  };
  return { calls, runner };
}

describe("Tailscale", () => {
  it("finds the CLI on PATH first, then in the macOS app bundle", () => {
    expect(findOnPath("tailscale", host({}, ["/bin/tailscale"]))).toBe("/bin/tailscale");
    const bundle = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    expect(new Tailscale(fakeRunner({}).runner, host({}, [bundle])).findCli()).toBe(bundle);
    expect(new Tailscale(fakeRunner({}).runner, host({ platform: "linux" }, [bundle])).findCli()).toBeUndefined();
    expect(new Tailscale(fakeRunner({}).runner, host({ platform: "linux" }, ["/usr/bin/pkexec"])).findPkexec()).toBe("/usr/bin/pkexec");
    expect(new Tailscale(fakeRunner({}).runner, host({}, ["/usr/bin/pkexec"])).findPkexec()).toBeUndefined();
  });

  it("reads status, and the operator only on Linux", async () => {
    const { calls, runner } = fakeRunner({
      "ts status --json": STATUS_RUNNING,
      "ts debug prefs": JSON.stringify({ OperatorUser: "alice" }),
    });
    const mac = new Tailscale(runner, host());
    expect(await mac.status("ts")).toMatchObject({ running: true, dnsName: "mac.tail1234.ts.net" });
    expect(await mac.isOperator("ts")).toBe(true);
    expect(calls).toEqual(["ts status --json"]);
    const linux = new Tailscale(runner, host({ platform: "linux" }));
    expect(await linux.isOperator("ts")).toBe(true);
    expect(await new Tailscale(runner, host({ platform: "linux", user: () => ({ username: "bob", uid: 1001 }) })).isOperator("ts")).toBe(false);
  });

  it("turns our rule on and off with exactly the documented commands", async () => {
    const { calls, runner } = fakeRunner({ "ts serve --bg --https=8443 http://127.0.0.1:51234": "", "ts serve --https=8443 off": "" });
    const t = new Tailscale(runner, host());
    await t.serveOn("ts", 8443, 51234);
    await t.serveOff("ts", 8443);
    expect(calls).toEqual(["ts serve --bg --https=8443 http://127.0.0.1:51234", "ts serve --https=8443 off"]);
  });

  it("surfaces serve's consent link as the error", async () => {
    const consent = new ToolError("tailscale serve --bg --https=8443 did not finish in 20 s", null, "", "To enable, visit:\n  https://login.tailscale.com/f/serve?node=n1\n");
    const { runner } = fakeRunner({ "ts serve --bg --https=8443 http://127.0.0.1:1": consent });
    await expect(new Tailscale(runner, host()).serveOn("ts", 8443, 1)).rejects.toThrow("https://login.tailscale.com/f/serve?node=n1");
  });

  it("makes the user the operator through pkexec", async () => {
    const { calls, runner } = fakeRunner({ "/usr/bin/pkexec ts set --operator=alice": "" });
    await new Tailscale(runner, host({ platform: "linux" })).setOperator("ts", "/usr/bin/pkexec");
    expect(calls).toEqual(["/usr/bin/pkexec ts set --operator=alice"]);
  });
});
