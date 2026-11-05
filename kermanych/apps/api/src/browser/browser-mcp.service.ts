// apps/api/src/browser/browser-mcp.service.ts
// The session browser's agent side (docs/specs/2026-10-05-embedded-browser.md): the tools that
// drive ONE session's embedded browser view, spoken as MCP over the local api — the same
// four-method Streamable HTTP subset as management-mcp.service.ts, so claude consumes it
// natively (SDK `mcpServers`, native `--mcp-config`) and omp through runtime/omp-mcp-bridge.ts.
//
// The bearer is per SESSION, not per child: a session's managed child and its native harness
// are relaunched freely (resume, reap, restart), and each relaunch must keep reaching the same
// browser. So the secret is minted on the session's first launch, reused by every later one
// for the life of this api process, and revoked when the session is deleted. The route is
// @Public and the bearer is the caller's whole credential; it names the session, and the tools
// act on that session's view only.
//
// The same server carries the session's «Знахідки» tools (findings/findings-tools.ts,
// docs/specs/2026-10-13-agent-findings.md), because a child gets exactly one MCP server. Those
// need no desktop app, so the server is handed out without one, and the browser tools are
// listed only while a browser host exists. A «Посіпака» run gets one more, `report_outcome`
// (minion/outcome-tool.ts, docs/specs/2026-10-23-minion-auto-run.md), listed only for it. An
// agent session also gets the live-preview tools (docs/specs/2026-11-03-session-browser-preview.md),
// which need no host either. A Mobile project's agent session gets the device tools instead of
// the browser ones (docs/specs/2026-11-03-mobile-device-preview.md, decisions 8 and 10); they need
// no host either, since the api drives the device. A back-end project has neither browser nor
// preview (decision 9): the gate is here, in tools/list and in every call, not in bindingFor.
// A managed agent or chat session also gets `improve_skill` (skills/improve-skill-tool.ts,
// docs/specs/2026-11-04-skill-self-improvement.md) while the operator's switch is not off.
import { Inject, Injectable, Optional } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { Subject } from "rxjs";
import { mkdirSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RegistryService } from "../registry/registry.service";
import { PreviewService, type PreviewStartOptions } from "../preview/preview.service";
import { FINDING_TOOL_NAMES, callFindingTool, findingTools } from "../findings/findings-tools";
import { resolveLanguage } from "../runtime/resolve-language";
import { OUTCOME_TOOL, callOutcomeTool } from "../minion/outcome-tool";
import { AuthService } from "../auth/auth.service";
import { IMPROVE_SKILL_TOOL_NAME, callImproveSkillTool, improveSkillTool } from "../skills/improve-skill-tool";
import { SkillImprovementService } from "../skills/skill-improvement.service";
import {
  CREDENTIAL_TOOL_DEF,
  DEVICE_CREDENTIAL_TOOL_DEF,
  QA_CHECKLIST_TOOL_DEF,
  QA_RESULT_TOOL_DEF,
  TESTER_QA_TOOL_NAMES,
  activeTesterOf,
  callTesterQaTool,
  credentialValue,
  isTesterSession,
  maskSecret,
} from "../tester/tester-tools";
import {
  CREDENTIAL_TOOL,
  DEVICE_CREDENTIAL_TOOL,
  DEVICE_BUTTONS,
  DEVICE_PLATFORM_BUTTONS,
  PREVIEW_CONFIG_PATH,
  PREVIEW_DEVICE_STEP,
  isDevicePlatform,
  platformHasBrowser,
  platformHasDevice,
  platformHasPreview,
  type DeviceButton,
  type DeviceElement,
  type DeviceRect,
  type DeviceRuntime,
  type MinionVerdictReport,
  type PreviewState,
  type QaChecklist,
  type Session,
} from "@kermanych/core";
import { DEVICE_API, type DeviceApi } from "../device/device.contract";
import {
  browserHost,
  type BrowserActionResult,
  type BrowserNetworkEntry,
  type BrowserPageInfo,
  type BrowserTarget,
} from "./browser-host";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

// The name the server is given in the child: claude shows `mcp__kermanych__browser_*`, omp
// the bare names.
export const BROWSER_MCP_SERVER_NAME = "kermanych";
const PROTOCOL_VERSION = "2025-06-18";

// Said once in every tool's description, because a model reads tools one by one.
const SHARED =
  "This is the operator's visible browser pane in Kermanych, belonging to THIS session only and shared live with the operator: they see every page you open and may be using it themselves.";

const REF = { type: "string", description: "A ref from the latest browser_snapshot (e.g. e12), or a CSS selector." };

const TOOLS = [
  {
    name: "browser_navigate",
    description:
      `${SHARED} Load a URL in it and wait for the page to settle. Without \`url\` it opens this session's running live preview (see preview_start). ` +
      "Answers with where the page ended up; follow with browser_snapshot to read it. A page that asks for HTTP sign-in (a browser login prompt) or opens a popup window " +
      "(e.g. an OAuth sign-in) needs the operator: ask them to complete it in the pane.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL or about:blank. Omit to open the session's running live preview." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      `${SHARED} A text outline of the whole page document, including same-origin iframes (cross-origin ones are named only). Interactive elements carry refs (e1, e2, …) that the element tools accept; ` +
      "every snapshot reassigns them, so take a fresh one after the page changes. Prefer this to find elements and read content; use browser_screenshot to check visuals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description:
      `${SHARED} Click an element with a real mouse event at its visible point. Refuses when another element covers that point and names the covering element, ` +
      "so a click never silently lands on an overlay. Answers with the page's URL and title afterwards, so you can tell whether it navigated.",
    inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "browser_type",
    description: `${SHARED} Focus an input or editable element and type text into it as real keyboard input. For a <select> use browser_select instead.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string", description: "The text to type." },
        clear: { type: "boolean", description: "Replace the field's current value (default true); false appends.", default: true },
        submit: { type: "boolean", description: "Press Enter after typing (default false).", default: false },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: `${SHARED} Press a key in the focused element, e.g. Enter, Escape, Tab, ArrowDown, a; modifiers join with +, e.g. Meta+a, Shift+Tab.`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "A KeyboardEvent.key name, optionally with modifiers joined by +." } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: `${SHARED} Move the mouse over an element, e.g. to open a hover-only menu or a tooltip; take a snapshot afterwards to see what appeared.`,
    inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "browser_select",
    description:
      `${SHARED} Choose options of a <select> element, each by its option value or visible label. Native selects cannot be operated by clicks or keys — use this. ` +
      "Answers with the labels selected.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        values: { type: "array", items: { type: "string" }, minItems: 1, description: "Option values or visible labels; more than one only for a multiple select." },
      },
      required: ["ref", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_history",
    description: `${SHARED} Go back, go forward or reload the page, and wait for it to settle.`,
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["back", "forward", "reload"] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      `${SHARED} Wait until a text appears in the page or a CSS selector matches (with \`gone\`, until it no longer does). Give exactly one of \`text\` and \`selector\`. ` +
      "Use it instead of sleeping after an action that loads content.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to look for in the page." },
        selector: { type: "string", description: "A CSS selector to look for." },
        gone: { type: "boolean", description: "Wait for it to disappear instead (default false).", default: false },
        timeout: { type: "number", description: "Seconds to wait (default 10, max 60).", default: 10, minimum: 0, maximum: 60 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_resize",
    description:
      `${SHARED} Lay the page out at a given viewport width (e.g. to check a mobile layout), and height while the operator is not looking at the pane; ` +
      "the operator sees the same viewport (scaled to fit their pane), and while they are looking the height follows their pane. " +
      "`{reset: true}` goes back to following the operator's pane.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 320, maximum: 3840, description: "Viewport width in CSS pixels." },
        height: { type: "integer", minimum: 240, maximum: 2400, description: "Viewport height in CSS pixels." },
        reset: { type: "boolean", description: "Follow the operator's pane again; not combined with width/height." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      `${SHARED} A PNG of the visible viewport, the whole page (\`full_page\`) or one element (\`ref\`). Use it to check layout and visuals; ` +
      "to find elements or read text, browser_snapshot is cheaper and gives refs. With `path` the PNG is saved into this session's worktree " +
      "instead of being shown to you — use it to keep a screenshot as a file, e.g. a design's screens as `<designDir>/screens/<screen>-<state>@<width>.png`.",
    inputSchema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the whole scrollable page (default false).", default: false },
        ref: { ...REF, description: "Capture only this element: a ref from the latest browser_snapshot, or a CSS selector." },
        path: {
          type: "string",
          description:
            "Save the PNG to this worktree-relative path under `docs/` (e.g. `docs/design/2026-10-29-orders/screens/list-empty@390.png`) " +
            "and answer with the saved path instead of the image. Only in a session with its own worktree.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload",
    description: `${SHARED} Set the files of an <input type=file> element without the native file dialog.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Absolute paths of files on this machine." },
      },
      required: ["ref", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_dialog",
    description: `${SHARED} Answer the JavaScript dialog (alert or confirm) the page is blocked on. The operator sees it too and may answer it first.`,
    inputSchema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "OK (true) or Cancel (false)." },
      },
      required: ["accept"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description: `${SHARED} Console messages, failed requests and 4xx/5xx responses collected since the browser opened or was last cleared — check it after something does not work.`,
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear the collected entries after reading them (default false).", default: false } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description: `${SHARED} Requests the page made (method, status, type, duration, URL) since the browser opened or was last cleared, oldest first.`,
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "Clear the collected requests after reading them (default false).", default: false },
        filter: { type: "string", description: "Keep only requests whose URL contains this text." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description: `${SHARED} Evaluate a JavaScript expression in the page (a promise is awaited) and answer with its result as JSON. It runs in the operator's live page: avoid side effects they did not ask for.`,
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "A JavaScript expression, e.g. document.title or (async () => { … })()." } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
];

// The live preview of this session (docs/specs/2026-11-03-session-browser-preview.md, «Agent
// tools»). The descriptions are the agent's only guidance (decision 11): no prompt line tells it
// to use them. A Mobile project's preview runs on the session's device
// (docs/specs/2026-11-03-mobile-device-preview.md, decision 10), so its descriptions say so and
// preview_start takes the platform.
const PREVIEW_SHARED =
  "The live preview runs THIS session's app from its worktree, as the repository's `.kermanych/preview.json` says (an optional `setup` command, then services started in order on free ports), and the operator watches it in the session browser's «Браузер» tab.";
const DEVICE_PREVIEW_SHARED =
  "The live preview runs THIS session's app from its worktree on the session's own virtual device (an iOS Simulator or an Android emulator), as the repository's `.kermanych/preview.json` says: step `device` boots the device, then the optional `setup`, the services in order and the platform's `install` run, and the app is launched. The operator watches the device in the session's «Пристрій» tab.";

const PREVIEW_START_PLATFORM = {
  type: "string",
  enum: ["ios", "android"],
  description: "Which device to run on when the file configures both; it becomes this project's default on this machine. Omit to keep the session's device (or the project's default).",
};

// `tester`: a «Тестувальник» run on a Mobile project (docs/specs/2026-11-04-tester-mobile-device.md,
// decision 1) — its first start is a clean one, and it cannot switch the device's platform.
function previewTools(device: boolean, tester = false) {
  const shared = device ? DEVICE_PREVIEW_SHARED : PREVIEW_SHARED;
  return [
    {
      name: "preview_start",
      description: device
        ? `${shared} Start it: the file is read and validated first, then the steps run. Answers once the app runs on the device (drive it with the device_* tools), ` +
          "or after 60 s with the step it is still waiting for — follow it with preview_status (booting a device and a first native build take minutes). A failure answers with the failed step and the last lines of its log. " +
          "Already running → the running state; pass `restart: true` to stop the services and run setup, services, install and the launch again (the device keeps running). " +
          (tester
            ? "Your first call in this run restarts the preview with the app's data cleared (a clean start), whatever it is doing; later calls start it as usual. The run uses the session's current device. "
            : "Passing another `platform` restarts on that device. ") +
          "A missing or invalid file is refused with the reason: write or fix `.kermanych/preview.json` by the preview-config skill."
        : `${shared} Start it: the file is read and validated first, then \`setup\` and each service run until ready. Answers with the URL and the service ports once it runs (the session browser then opens the page; check your work there with the browser tools), ` +
          "or after 60 s with the step it is still waiting for — follow it with preview_status. A failure answers with the failed step and the last lines of its log. Already running → the running state; pass `restart: true` to stop and start again (after you changed the code a running dev server does not reload, or the file). " +
          "A missing or invalid file is refused with the reason: write or fix `.kermanych/preview.json` by the preview-config skill.",
      inputSchema: {
        type: "object",
        properties: {
          restart: { type: "boolean", description: "Stop the running preview first and start it again (default false).", default: false },
          ...(device && !tester ? { platform: PREVIEW_START_PLATFORM } : {}),
        },
        additionalProperties: false,
      },
    },
    {
      name: "preview_status",
      description: device
        ? `${shared} Its current state: starting (and the step it waits for), running (the device, and whether the app runs or has exited), stopped, crashed (a service or the device itself exited) or failed (which step, why).`
        : `${shared} Its current state: starting (and the step it waits for), running (URL and ports), stopped, crashed (which service, its exit code) or failed (which step, why).`,
      inputSchema: {
        type: "object",
        properties: { wait: { type: "number", description: "While it is starting, wait up to this many seconds (0–60) for it to run or fail (default 0).", minimum: 0, maximum: 60 } },
        additionalProperties: false,
      },
    },
    {
      name: "preview_stop",
      description: device
        ? `${shared} Stop every process of it and shut the device down; the device keeps its data (sign-ins, installed apps) for the next start.`
        : `${shared} Stop every process of it. The page stays open in the session browser, on a dead address.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "preview_logs",
      description: device
        ? `${shared} The output of one step of the latest start: \`device\` (the device's boot lines and the app's own log), \`setup\`, \`install\` or a service name. Read it when a start fails, a service crashes or the app exits.`
        : `${shared} The output (stdout and stderr) of one step of the latest start: \`setup\` or a service name. Read it when a start fails or a service crashes.`,
      inputSchema: {
        type: "object",
        properties: {
          step: { type: "string", description: device ? "`device`, `setup`, `install` or a service name from the file." : "`setup` or a service name from the file." },
          lines: { type: "integer", description: "How many of the last lines (1–1000, default 100).", minimum: 1, maximum: 1000, default: 100 },
        },
        required: ["step"],
        additionalProperties: false,
      },
    },
  ];
}
const PREVIEW_TOOL_NAMES = new Set(previewTools(false).map((t) => t.name));

// The session's device (docs/specs/2026-11-03-mobile-device-preview.md, decision 10). Listed for
// a Mobile project's agent session; they need no desktop app, since the api drives the device.
const DEVICE_SHARED =
  "This is THIS session's virtual device (an iOS Simulator or an Android emulator) in Kermanych's «Пристрій» tab, shared live with the operator: they see its screen and may be using it themselves. It runs while the live preview runs (preview_start boots it).";
// Every tool that takes or gives coordinates says which space they are in.
const DEVICE_UNITS =
  "Coordinates are in the device's screen space that device_snapshot reports: points on iOS, pixels on Android, origin at the top left.";
const DEVICE_REF = { type: "string", description: "A ref from the latest device_snapshot (e.g. e12)." };
const DEVICE_X = { type: "number", description: "X in the device's screen space (points on iOS, pixels on Android)." };
const DEVICE_Y = { type: "number", description: "Y in the device's screen space (points on iOS, pixels on Android)." };

const DEVICE_TOOLS = [
  {
    name: "device_snapshot",
    description:
      `${DEVICE_SHARED} The screen's accessibility tree as compact text, one element per line, nested by indentation: \`e12 Button "Sign in" [24,610 345×48] id=login value="…"\` — ` +
      `a ref, the element's type, its label, its frame [x,y width×height], and its id and value when it has them. ${DEVICE_UNITS} ` +
      "Refs are bound to this snapshot: an element that moved or went away is refused rather than tapped blind, so take a new snapshot after the screen changes. Prefer this to read the screen; use device_screenshot to check visuals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "device_screenshot",
    description:
      `${DEVICE_SHARED} A PNG of the device's screen. To find elements or read text, device_snapshot is cheaper and gives refs. With \`path\` the PNG is saved into this session's worktree ` +
      "instead of being shown to you — use it to keep a screenshot as a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Save the PNG to this worktree-relative path under `docs/` (e.g. `docs/screens/login-error.png`) and answer with the saved path instead of the image. Only in a session with its own worktree.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "device_tap",
    description:
      `${DEVICE_SHARED} Tap once: an element by \`ref\`, the first element whose accessibility \`label\` or \`id\` equals the given one, or the point \`x\`,\`y\`. Give exactly one of ref, label, id, or x with y. ` +
      `An element is tapped at the centre of its frame. ${DEVICE_UNITS}`,
    inputSchema: {
      type: "object",
      properties: {
        ref: DEVICE_REF,
        label: { type: "string", description: "An element's exact accessibility label, as device_snapshot shows it in quotes." },
        id: { type: "string", description: "An element's exact accessibility id (iOS) or resource-id (Android)." },
        x: DEVICE_X,
        y: DEVICE_Y,
      },
      additionalProperties: false,
    },
  },
  {
    name: "device_swipe",
    description:
      `${DEVICE_SHARED} Swipe with one finger: from the point \`x\`,\`y\` (or the centre of \`ref\`, or the centre of the screen) either to \`to_x\`,\`to_y\` or in a \`direction\` ` +
      "the finger moves for `distance` of the screen. A finger moving up scrolls the content down (to what is below). " +
      `${DEVICE_UNITS}`,
    inputSchema: {
      type: "object",
      properties: {
        ref: { ...DEVICE_REF, description: "Start at the centre of this element: a ref from the latest device_snapshot." },
        x: DEVICE_X,
        y: DEVICE_Y,
        to_x: { type: "number", description: "End X in the device's screen space." },
        to_y: { type: "number", description: "End Y in the device's screen space." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "The way the finger moves; instead of to_x/to_y." },
        distance: { type: "number", minimum: 0.05, maximum: 1, default: 0.5, description: "With direction: how far, as a fraction of the screen's height (up/down) or width (left/right); default 0.5." },
        duration_ms: { type: "integer", minimum: 50, maximum: 5000, default: 300, description: "How long the swipe takes; a slow one drags, a fast one flings (default 300)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "device_type",
    description:
      `${DEVICE_SHARED} Type text into the focused field (tap the field first). Any text works: what a keyboard cannot type (Cyrillic, emoji) is pasted through the device's clipboard.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after typing (default false).", default: false },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "device_press",
    description: `${DEVICE_SHARED} Press a hardware button. An iOS simulator has no back or recents button: those are refused there.`,
    inputSchema: {
      type: "object",
      properties: { button: { type: "string", enum: [...DEVICE_BUTTONS], description: "The button to press." } },
      required: ["button"],
      additionalProperties: false,
    },
  },
  {
    name: "device_wait_for",
    description:
      `${DEVICE_SHARED} Wait until an element whose label or value contains \`text\`, or whose id equals \`id\`, appears in the accessibility tree (with \`gone\`, until none is left). ` +
      "Give exactly one of `text` and `id`. Use it instead of sleeping after an action that loads a screen.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to look for in elements' labels and values." },
        id: { type: "string", description: "An exact accessibility id (iOS) or resource-id (Android)." },
        gone: { type: "boolean", description: "Wait for it to disappear instead (default false).", default: false },
        timeout: { type: "number", description: "Seconds to wait (default 10, max 60).", default: 10, minimum: 0, maximum: 60 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "device_open_url",
    description: `${DEVICE_SHARED} Open a URL on the device: a deep link into the app (\`myapp://orders/42\`) or a web page in the device's browser.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "A URL with a scheme, e.g. myapp://path or https://example.com." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "device_app",
    description:
      `${DEVICE_SHARED} Launch, terminate or restart the app the preview file names, on the running preview's device. Use \`launch\` after the app exited (preview_status says so), ` +
      "`restart` to start it from a clean process. This does not rebuild it: after a code change, restart the preview (preview_start with restart) or hot-reload as the preview-config skill says.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["launch", "terminate", "restart"] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "device_rotate",
    description: `${DEVICE_SHARED} Rotate the device. The screen space of every other tool turns with it: take a new device_snapshot afterwards.`,
    inputSchema: {
      type: "object",
      properties: { orientation: { type: "string", enum: ["portrait", "landscape"] } },
      required: ["orientation"],
      additionalProperties: false,
    },
  },
];
const DEVICE_TOOL_NAMES = new Set(DEVICE_TOOLS.map((t) => t.name));

// How long preview_start waits for running before it hands over to preview_status.
const PREVIEW_START_WAIT_MS = 60_000;
// The log lines a failed preview_start ends with.
const PREVIEW_FAILURE_LINES = 50;

// Tools that skip the session's queue. browser_dialog must reach a page whose queued action is
// itself blocked on that very dialog (actions return early when they open one, but a dialog the
// page opens on its own — a timer, a late handler — can still catch an action mid-flight), and
// browser_console / browser_network only read buffers the main process collects, which is how
// the agent finds out why an action hangs. The preview tools skip it too (routed apart, below):
// they never touch the page, and a start can take minutes.
const UNQUEUED = new Set(["browser_dialog", "browser_console", "browser_network"]);

// browser_network's answer is capped so a chatty page cannot flood the agent's context; the
// newest requests are the interesting ones, so the oldest are dropped.
export const NETWORK_OUTPUT_LIMIT = 20_000;

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function at(p: BrowserPageInfo): string {
  return `now at ${p.url} (${p.title})`;
}

// An input action's answer: where the page is, and what the action set off that the agent
// must act on (a blocking dialog) or leave to the operator (a popup window).
function acted(r: BrowserActionResult, extra = ""): string {
  const lines = [at(r) + extra];
  if (r.dialog) {
    lines.push(`A JavaScript ${r.dialog.type} dialog is open: «${r.dialog.message}» — the page is blocked until you answer it with browser_dialog.`);
  }
  if (r.popup) lines.push(`A popup window opened at ${r.popup}; it belongs to the operator (agent tools cannot drive it).`);
  return lines.join("\n");
}

// A preview state in the agent's words, with what to do next.
function describePreview(state: PreviewState | null): string {
  const ports = (services: { name: string; port: number }[]) => services.map((s) => `${s.name} :${s.port}`).join(", ");
  if (!state) return "The preview has not been started since Kermanych started. Call preview_start.";
  switch (state.phase) {
    case "starting":
      return `Starting: waiting for ${state.step}${state.services.length ? ` (ports: ${ports(state.services)})` : ""}. Call preview_status with \`wait\` to follow it.`;
    case "running": {
      if (!state.device) return `Running at ${state.url} (${ports(state.services)}). The session browser opens it; browser_navigate without a url returns to it.`;
      const d = state.device;
      const on = `Running on ${d.name} (${d.platform}, DEVICE_ID ${d.serial}, screen ${d.screen.width}×${d.screen.height} ${d.platform === "ios" ? "points" : "pixels"})${state.services.length ? `, ports: ${ports(state.services)}` : ""}.`;
      return state.app === "exited"
        ? `${on} The app has exited (it crashed or was closed); the services and the device keep running. Read preview_logs for \`device\`, then start it again with device_app launch.`
        : `${on} The app is running: drive it with the device_* tools.`;
    }
    case "stopped":
      return "The preview is stopped. Call preview_start to run it.";
    case "crashed":
      if (state.step === PREVIEW_DEVICE_STEP)
        return "Crashed: the device itself (simulator or emulator) exited while the preview was running, and the services were stopped. Read preview_logs for `device`, then call preview_start.";
      return `Crashed: ${state.step} ${state.code !== null ? `exited with code ${state.code}` : `was killed by ${state.signal}`} while the preview was running, and the other services were stopped. Read preview_logs for \`${state.step}\`, then call preview_start.`;
    case "failed":
      return `Failed at ${state.step}: ${state.error}\nRead preview_logs for \`${state.step}\`, fix the cause, then call preview_start.`;
  }
}

// What a device ref stands for: enough to find the same element in a fresh tree.
type DeviceRef = { type: string; label: string | null; frame: DeviceRect };

// How far a ref's element may have moved and still be the one the snapshot showed, as a share
// of the screen's longer side: a few points of layout jitter, not another row of a list.
const REF_TOLERANCE = 0.02;

// device_wait_for polls the tree this often.
const DEVICE_WAIT_POLL_MS = 500;

const round = (n: number) => Math.round(n);

function centre(f: DeviceRect): { x: number; y: number } {
  return { x: f.x + f.width / 2, y: f.y + f.height / 2 };
}

// Depth-first, the order device_snapshot numbers refs in.
function walk(tree: DeviceElement[], visit: (e: DeviceElement, depth: number) => void, depth = 0): void {
  for (const e of tree) {
    visit(e, depth);
    walk(e.children, visit, depth + 1);
  }
}

// One element the way device_snapshot shows it (without the ref).
export function describeElement(e: Omit<DeviceElement, "children">): string {
  const f = e.frame;
  let line = `${e.type}${e.label ? ` ${JSON.stringify(e.label)}` : ""} [${round(f.x)},${round(f.y)} ${round(f.width)}×${round(f.height)}]`;
  if (e.id) line += ` id=${e.id}`;
  if (e.value) line += ` value=${JSON.stringify(e.value)}`;
  if (!e.enabled) line += " disabled";
  return line;
}

// device_snapshot's text (mobile decision 10): `e12 Button "Увійти" [24,610 345×48]`, nested by
// indentation, refs numbered depth-first. Elements with no area are not on screen: skipped, their
// children kept. Answers the refs the text names.
export function formatDeviceTree(tree: DeviceElement[]): { text: string; refs: Map<string, DeviceRef> } {
  const refs = new Map<string, DeviceRef>();
  const lines: string[] = [];
  walk(tree, (e, depth) => {
    if (e.frame.width <= 0 || e.frame.height <= 0) return;
    const ref = `e${refs.size + 1}`;
    refs.set(ref, { type: e.type, label: e.label, frame: e.frame });
    lines.push(`${"  ".repeat(depth)}${ref} ${describeElement(e)}`);
  });
  return { text: lines.join("\n"), refs };
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`\`${key}\` must be a number`);
  return v;
}

function networkLine(e: BrowserNetworkEntry): string {
  const outcome = e.failed ? `failed(${e.failed})` : e.status !== undefined ? String(e.status) : "…";
  const parts = [e.method, outcome];
  if (e.type) parts.push(e.type);
  if (e.ms !== undefined) parts.push(`${Math.round(e.ms)}ms`);
  parts.push(e.url);
  if (e.ms === undefined && !e.failed) parts.push("(pending)");
  return parts.join(" ");
}

export function formatNetwork(entries: BrowserNetworkEntry[]): string {
  if (!entries.length) return "(no requests)";
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = networkLine(entries[i]);
    if (kept.length && size + line.length + 1 > NETWORK_OUTPUT_LIMIT) break;
    kept.push(line);
    size += line.length + 1;
  }
  kept.reverse();
  const dropped = entries.length - kept.length;
  return (dropped ? `(${dropped} older requests dropped)\n` : "") + kept.join("\n");
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`\`${key}\` is required`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`\`${key}\` must be a string`);
  return v;
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : fallback;
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x))
    throw new Error(`\`${key}\` must be a non-empty array of non-empty strings`);
  return v as string[];
}

function int(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${key}\` must be an integer from ${min} to ${max}`);
  return v;
}

// Where `browser_screenshot` may write: a worktree-relative `.png` under `docs/`, spelled with
// plain forward-slash segments, whose real location (symlinks of the existing chain resolved)
// stays inside the worktree's own `docs/`. Answers the absolute path to write; throws the
// reason otherwise. Reads the disk (realpath), writes nothing.
export function screenshotFile(worktreePath: string, path: string): string {
  if (path.includes("\\")) throw new Error(`\`path\` must use forward slashes: ${path}`);
  if (isAbsolute(path)) throw new Error(`\`path\` must be relative to the worktree: ${path}`);
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) throw new Error(`\`path\` must not contain empty, "." or ".." segments: ${path}`);
  if (segments[0] !== "docs" || segments.length < 2) throw new Error(`\`path\` must be under docs/: ${path}`);
  if (!path.toLowerCase().endsWith(".png") || segments[segments.length - 1].length <= ".png".length)
    throw new Error(`\`path\` must name a .png file: ${path}`);
  const root = realpathSync(worktreePath);
  const docs = join(root, "docs");
  // The deepest entry that exists (lstat: a dangling symlink counts and then fails realpath),
  // resolved; the part not yet on disk is appended as written — it holds no symlinks yet.
  let existing = join(root, ...segments);
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      rest.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  let real: string;
  try {
    real = join(realpathSync(existing), ...rest);
  } catch {
    throw new Error(`\`path\` resolves outside the worktree's docs/: ${path}`);
  }
  const inside = relative(docs, real);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside))
    throw new Error(`\`path\` resolves outside the worktree's docs/: ${path}`);
  return real;
}

@Injectable()
export class BrowserMcpService {
  private tokens = new Map<string, string>(); // sessionId → token
  private sessions = new Map<string, string>(); // token → sessionId
  // A session whose agent just reported a finding — the supervisor re-sends the session so its
  // open-findings counter reaches the UI while the agent keeps working.
  readonly findingReported$ = new Subject<string>();
  // A «Посіпака» run reported its verdict — the supervisor holds it for the turn's end.
  readonly outcomeReported$ = new Subject<{ sessionId: string; report: MinionVerdictReport }>();
  // A «Тестувальник» run wrote its card's QA checklist (a verdict, or the checklist it composed) —
  // the supervisor forwards it as `qa_checklist_update`.
  readonly qaChecklistChanged$ = new Subject<{ taskId: string; checklist: QaChecklist }>();
  // The tail of each session's tool-call chain. Agents fire calls in parallel (a snapshot
  // beside the navigate it depends on — observed with omp), and one page cannot serve two
  // actions at once, so a session's calls run one after another in arrival order.
  private queues = new Map<string, Promise<unknown>>();
  // The refs of each device's latest device_snapshot (mobile decision 10), keyed by the device's
  // session: a ref is bound to the snapshot that gave it.
  private deviceRefs = new Map<string, Map<string, DeviceRef>>();
  // A Mobile tester run's clean start (docs/specs/2026-11-04-tester-mobile-device.md, decision 1),
  // by tester session id: `starting` once its first preview_start asked for one, `done` once the
  // doer's preview ran after it. Until then the run's device tools are refused.
  private cleanStarts = new Map<string, "starting" | "done">();

  constructor(
    private registry: RegistryService,
    private preview: PreviewService,
    @Inject(DEVICE_API) private device: DeviceApi,
    @Optional() private http?: HttpAdapterHost,
    // The cloud client for a tester run's checklist writes. Optional so specs construct the
    // service without it — then those writes refuse.
    @Optional() private auth?: AuthService,
    // improve_skill's work. Optional and last so specs construct the service positionally
    // without it — then the tool is not listed.
    @Optional() private improvements?: SkillImprovementService,
  ) {}

  // Whose live preview — and, in a Mobile project, whose device — a session's tools act on: its
  // own, or for a tester run the parent's (docs/specs/2026-11-04-qa-tester-agent.md, decision 6;
  // docs/specs/2026-11-04-tester-mobile-device.md, decision 1) — no second set of dev servers
  // from the same worktree, no second device.
  private previewOwner(session: Session): string {
    return isTesterSession(session) && session.parentSessionId ? session.parentSessionId : session.id;
  }

  // The doer's device belongs to its tester until the run is retired
  // (docs/specs/2026-11-04-tester-mobile-device.md, decision 2).
  private refuseWhileTested(session: Session): void {
    if (activeTesterOf(this.registry.listSessions(), session.id)) throw new Error(DEVICE_BUSY);
  }

  // Whether a tester run has had its clean start: asked for by its first preview_start, and the
  // doer's preview has run since.
  private testerCleaned(testerId: string, ownerId: string): boolean {
    const mark = this.cleanStarts.get(testerId);
    if (mark === "done") return true;
    if (mark !== "starting" || this.preview.state(ownerId)?.phase !== "running") return false;
    this.cleanStarts.set(testerId, "done");
    return true;
  }

  tokenFor(sessionId: string): string {
    let token = this.tokens.get(sessionId);
    if (!token) {
      token = randomBytes(32).toString("base64url");
      this.tokens.set(sessionId, token);
      this.sessions.set(token, sessionId);
    }
    return token;
  }

  sessionFor(token: string | undefined): string | undefined {
    return token ? this.sessions.get(token) : undefined;
  }

  revoke(sessionId: string): void {
    this.deviceRefs.delete(sessionId);
    this.cleanStarts.delete(sessionId);
    const token = this.tokens.get(sessionId);
    if (!token) return;
    this.tokens.delete(sessionId);
    this.sessions.delete(token);
  }

  // The server a launch hands its agent, or undefined when there is no port to reach this api
  // on yet (specs) — then the agent gets no tools. A standalone api (no desktop app) still hands
  // it out: the findings tools work there, and tools/list then omits the browser ones.
  bindingFor(sessionId: string): { name: string; url: string; token: string } | undefined {
    const address = this.http?.httpAdapter?.getHttpServer()?.address() as { port?: number } | string | null | undefined;
    const port = address && typeof address === "object" ? address.port : undefined;
    if (!port) return undefined;
    return { name: BROWSER_MCP_SERVER_NAME, url: `http://127.0.0.1:${port}/api/browser/mcp`, token: this.tokenFor(sessionId) };
  }

  // One POST body → the response body, or `undefined` when it held only notifications.
  async handle(sessionId: string, body: unknown): Promise<unknown> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(sessionId, m)))).filter((r) => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.one(sessionId, body);
  }

  private async one(sessionId: string, raw: unknown): Promise<unknown> {
    const msg = (raw && typeof raw === "object" ? raw : {}) as JsonRpcRequest;
    if (msg.id === undefined || msg.id === null) return undefined;
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    switch (msg.method) {
      case "initialize":
        return result({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BROWSER_MCP_SERVER_NAME, version: "1.0.0" },
        });
      case "ping":
        return result({});
      case "tools/list": {
        const session = this.registry.listSessions().find((s) => s.id === sessionId);
        const platform = this.registry.listProjects().find((p) => p.id === session?.projectId)?.platform;
        const agent = session?.kind === "agent";
        const authRow = this.registry.getAuthSession();
        const language = resolveLanguage(process.env.KERMANYCH_LANGUAGE, authRow?.agentLanguage);
        const findings = findingTools(language);
        // A tester run (a `review` child stamped `tester`) gets the agent's browser or device and
        // the parent's preview, plus its QA and credential tools; any other review or discussion
        // fork is never handed this server at all. In a Mobile project the device and the preview
        // are the doer's (docs/specs/2026-11-04-tester-mobile-device.md, decisions 1 and 7).
        const tester = isTesterSession(session);
        const device = platformHasDevice(platform);
        // Only a managed agent or chat session improves skills: a native TUI or a review fork
        // never read the library's skills through Kermanych, and the switch off means off.
        const improve =
          !!this.improvements && !!session && !session.native && (agent || session.kind === "chat") && !tester && authRow?.skillImprovement !== false;
        const tools = [
          ...(browserHost() && platformHasBrowser(platform) ? TOOLS : []),
          ...(browserHost() && platformHasBrowser(platform) && tester ? [CREDENTIAL_TOOL_DEF] : []),
          ...((agent || tester) && platformHasPreview(platform) ? previewTools(device, tester) : []),
          ...((agent || tester) && device ? DEVICE_TOOLS : []),
          ...(tester && device ? [DEVICE_CREDENTIAL_TOOL_DEF] : []),
          ...findings,
          ...(session?.minion === true ? [OUTCOME_TOOL] : []),
          ...(tester ? [QA_RESULT_TOOL_DEF, QA_CHECKLIST_TOOL_DEF] : []),
          ...(improve ? [improveSkillTool(language)] : []),
        ];
        return result({ tools });
      }
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        let run: Promise<ToolResult>;
        if (FINDING_TOOL_NAMES.has(name))
          run = Promise.resolve().then(() => this.callFinding(sessionId, name, args));
        else if (name === IMPROVE_SKILL_TOOL_NAME && this.improvements) {
          const improvements = this.improvements;
          run = Promise.resolve().then(() => callImproveSkillTool(improvements, sessionId, args));
        } else if (name === OUTCOME_TOOL.name)
          run = Promise.resolve().then(() => callOutcomeTool(this.registry, sessionId, args, (report) => this.outcomeReported$.next({ sessionId, report })));
        else if (TESTER_QA_TOOL_NAMES.has(name))
          run = callTesterQaTool(
            {
              registry: this.registry,
              client: () => {
                if (!this.auth) throw new Error("not signed in");
                return this.auth.cloudClient();
              },
              changed: (taskId, checklist) => this.qaChecklistChanged$.next({ taskId, checklist }),
              screenshotFile,
            },
            sessionId,
            name,
            args,
          );
        else if (PREVIEW_TOOL_NAMES.has(name)) run = this.callPreview(sessionId, name, args);
        else if (UNQUEUED.has(name)) run = this.call(sessionId, name, args);
        else {
          // The device has one screen as the page has one view: its actions queue the same way —
          // on the device's own session, which for a tester run is the doer's.
          const onDevice = DEVICE_TOOL_NAMES.has(name) || name === DEVICE_CREDENTIAL_TOOL;
          const exec = onDevice ? () => this.callDevice(sessionId, name, args) : () => this.call(sessionId, name, args);
          const caller = onDevice ? this.registry.listSessions().find((s) => s.id === sessionId) : undefined;
          const key = caller ? this.previewOwner(caller) : sessionId;
          run = (this.queues.get(key) ?? Promise.resolve()).then(exec);
          const tail = run.catch(() => undefined);
          this.queues.set(key, tail);
          void tail.then(() => {
            if (this.queues.get(key) === tail) this.queues.delete(key);
          });
        }
        try {
          return result(await run);
        } catch (err) {
          return result({ content: [{ type: "text", text: (err as Error)?.message ?? String(err) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
    }
  }

  // No queue and no host: a findings call only reads and writes this machine's registry.
  private callFinding(sessionId: string, name: string, args: Record<string, unknown>): ToolResult {
    if (!this.registry.listSessions().some((s) => s.id === sessionId)) throw new Error("This session no longer exists.");
    return callFindingTool(this.registry, sessionId, name, args, () => this.findingReported$.next(sessionId));
  }

  private async call(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const host = browserHost();
    if (!host) throw new Error("The session browser is not available: Kermanych is running without its desktop app.");
    const session = this.registry.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("This session no longer exists.");
    // Tools listed before the project became back-end or mobile stay in the agent's list.
    const platform = this.registry.listProjects().find((p) => p.id === session.projectId)?.platform;
    if (!platformHasBrowser(platform)) throw new Error(`The session browser is off: this is a ${platform} project.`);
    const target: BrowserTarget = { sessionId, projectId: session.projectId, ...(isTesterSession(session) ? { ephemeral: true } : {}) };
    // A tester run writes screenshots into the tested session's worktree: it has none of its own.
    const shotOwner = isTesterSession(session) ? this.registry.listSessions().find((s) => s.id === session.parentSessionId) : session;
    switch (name) {
      case "browser_navigate": {
        const url = typeof args.url === "string" && args.url ? args.url : this.preview.urlOf(this.previewOwner(session));
        if (!url)
          throw new Error(
            "No url given and this session's live preview is not running. Pass a url, or start the preview with preview_start.",
          );
        const page = await host.navigate(target, url);
        return text(`${at(page)}${page.status && page.status >= 400 ? ` — HTTP ${page.status}` : ""}`);
      }
      case "browser_snapshot": {
        const page = await host.snapshot(target);
        return text(`Page: ${page.title} — ${page.url}\n\n${page.text}`);
      }
      case "browser_click":
        return text(acted(await host.click(target, str(args, "ref"))));
      case "browser_type": {
        const typed = typeof args.text === "string" ? args.text : undefined;
        if (typed === undefined) throw new Error("`text` is required");
        return text(acted(await host.type(target, str(args, "ref"), typed, { clear: bool(args, "clear", true), submit: bool(args, "submit", false) })));
      }
      case CREDENTIAL_TOOL: {
        if (!isTesterSession(session)) throw new Error(`${CREDENTIAL_TOOL} is only for «Тестувальник» runs.`);
        const ref = str(args, "ref");
        const { account, field, value } = credentialValue(this.registry, session.projectId, args);
        let r: BrowserActionResult;
        try {
          r = await host.type(target, ref, value, { clear: true, submit: bool(args, "submit", false) });
        } catch (err) {
          throw new Error(maskSecret((err as Error)?.message ?? String(err), value));
        }
        return text(acted(r, `\ntyped the ${field} of «${account.name}»`));
      }
      case "browser_press":
        return text(acted(await host.press(target, str(args, "key"))));
      case "browser_hover":
        return text(acted(await host.hover(target, str(args, "ref"))));
      case "browser_select": {
        const ref = str(args, "ref");
        const r = await host.select(target, ref, strings(args, "values"));
        return text(acted(r, `\nselected: ${r.selected.join(", ")}`));
      }
      case "browser_history": {
        const action = args.action;
        if (action !== "back" && action !== "forward" && action !== "reload") throw new Error("`action` must be back, forward or reload");
        return text(acted(await host.history(target, action)));
      }
      case "browser_wait_for": {
        const waitText = optStr(args, "text");
        const selector = optStr(args, "selector");
        if (!waitText === !selector) throw new Error("Give exactly one of `text` and `selector`.");
        const timeout = args.timeout === undefined || args.timeout === null ? 10 : args.timeout;
        if (typeof timeout !== "number" || !(timeout >= 0 && timeout <= 60)) throw new Error("`timeout` must be a number of seconds from 0 to 60");
        const r = await host.waitFor(target, { text: waitText, selector, gone: bool(args, "gone", false), timeoutMs: Math.round(timeout * 1000) });
        return text(`found after ${r.waitedMs} ms; ${at(r)}`);
      }
      case "browser_resize": {
        const width = int(args, "width", 320, 3840);
        const height = int(args, "height", 240, 2400);
        const reset = bool(args, "reset", false);
        if (reset && (width !== undefined || height !== undefined)) throw new Error("`reset` cannot be combined with `width`/`height`.");
        if (!reset && width === undefined) throw new Error("Give `width` (and optionally `height`), or `reset: true`.");
        const r = await host.resize(target, reset ? null : height === undefined ? { width: width! } : { width: width!, height });
        return text(`viewport ${r.viewport.width}×${r.viewport.height}; ${at(r)}`);
      }
      case "browser_screenshot": {
        const fullPage = bool(args, "full_page", false);
        const ref = optStr(args, "ref");
        const path = optStr(args, "path");
        if (fullPage && ref) throw new Error("`full_page` and `ref` cannot be combined.");
        // A chat in the operator's checkout has no worktree of its own: writing there would
        // change the operator's files behind their back.
        if (path !== undefined && (!shotOwner?.worktree || !shotOwner.worktreePath))
          throw new Error("`path` needs a session with its own worktree; this one works in the operator's checkout.");
        const file = path === undefined ? undefined : screenshotFile(shotOwner!.worktreePath, path);
        const shot = await host.screenshot(target, ref ? { fullPage, ref } : { fullPage });
        if (!file) return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
        const bytes = Buffer.from(shot.data, "base64");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        return text(`saved ${path} (${bytes.length} bytes)`);
      }
      case "browser_upload": {
        const ref = str(args, "ref");
        const paths = strings(args, "paths");
        const relative = paths.find((p) => !isAbsolute(p));
        if (relative) throw new Error(`Paths must be absolute: ${relative}`);
        return text(acted(await host.upload(target, ref, paths)));
      }
      case "browser_dialog": {
        if (typeof args.accept !== "boolean") throw new Error("`accept` is required (true for OK, false for Cancel)");
        return text(acted(await host.dialog(target, { accept: args.accept })));
      }
      case "browser_console": {
        const entries = await host.console(target, { clear: bool(args, "clear", false) });
        return text(entries.length ? entries.map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ""}`).join("\n") : "(no entries)");
      }
      case "browser_network": {
        const filter = optStr(args, "filter");
        return text(formatNetwork(await host.network(target, filter ? { clear: bool(args, "clear", false), filter } : { clear: bool(args, "clear", false) })));
      }
      case "browser_evaluate":
        return text(await host.evaluate(target, str(args, "expression")));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // No queue and no host: the preview runs in the api (decision 8 — agent sessions of a project
  // with a browser, or with a device: mobile decision 8). A tester run acts on its doer's.
  private async callPreview(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.registry.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("This session no longer exists.");
    const tester = isTesterSession(session);
    if (session.kind !== "agent" && !tester) throw new Error(`The live preview is only for agent sessions (this is a ${session.kind}).`);
    const platform = this.registry.listProjects().find((p) => p.id === session.projectId)?.platform;
    if (!platformHasPreview(platform)) throw new Error(`The live preview is off: this is a ${platform} project.`);
    const onDevice = platformHasDevice(platform);
    const owner = this.previewOwner(session);
    // The operator's «Агент» pause covers starting and stopping, not reading. A device's pause
    // lives in the api, since the device exists in the web build too (mobile decision 9), and is
    // the device's own — the doer's for its tester too; a web preview's is the pause of the
    // caller's own page.
    if (name === "preview_start" || name === "preview_stop") {
      if (onDevice && !tester) this.refuseWhileTested(session);
      if (onDevice && this.device.paused(owner)) throw new Error(DEVICE_PAUSED);
      if (!onDevice && browserHost()?.isPaused(sessionId) === true)
        throw new Error("The operator paused your control of this session's browser and preview. Ask them to resume it, or wait.");
    }
    const testerId = session.id;
    sessionId = owner;
    switch (name) {
      case "preview_start": {
        const platformArg = args.platform ?? undefined;
        if (platformArg !== undefined && !isDevicePlatform(platformArg)) throw new Error("`platform` must be ios or android");
        let opts: PreviewStartOptions = { restart: bool(args, "restart", false), ...(platformArg !== undefined ? { platform: platformArg } : {}) };
        // A Mobile tester run's first start is a clean one (docs/specs/2026-11-04-tester-mobile-device.md,
        // decision 1). A clean start still under way is followed, not started again.
        let follow = false;
        if (tester && onDevice) {
          if (platformArg !== undefined) throw new Error("A «Тестувальник» run cannot pick the platform: it tests on the session's current device.");
          if (!this.testerCleaned(testerId, owner)) {
            follow = this.cleanStarts.get(testerId) === "starting" && this.preview.state(owner)?.phase === "starting";
            opts = { restart: true, clean: true };
          }
        }
        if (!follow) {
          try {
            this.preview.start(sessionId, opts);
          } catch (err) {
            const message = (err as Error).message;
            throw new Error(message.includes(PREVIEW_CONFIG_PATH) ? `${message}. Write or fix the file by the preview-config skill, then call preview_start again.` : message);
          }
          if (opts.clean) this.cleanStarts.set(testerId, "starting");
        }
        const state = await this.preview.settled(sessionId, PREVIEW_START_WAIT_MS);
        if (state?.phase !== "failed") return text(describePreview(state));
        const lines = this.preview.tail(sessionId, state.step, PREVIEW_FAILURE_LINES);
        const reason = state.error.split("\n")[0];
        return {
          content: [{ type: "text", text: `Failed at ${state.step}: ${reason}\n\nLast ${lines.length} lines of ${state.step}:\n${lines.join("\n") || "(no output)"}` }],
          isError: true,
        };
      }
      case "preview_status": {
        const wait = args.wait === undefined || args.wait === null ? 0 : args.wait;
        if (typeof wait !== "number" || !(wait >= 0 && wait <= 60)) throw new Error("`wait` must be a number of seconds from 0 to 60");
        return text(describePreview(await this.preview.settled(sessionId, Math.round(wait * 1000))));
      }
      case "preview_stop":
        await this.preview.stop(sessionId);
        return text(
          onDevice
            ? "The preview is stopped and the device shut down; it keeps its data for the next start."
            : "The preview is stopped. The page stays as it is in the session browser.",
        );
      case "preview_logs": {
        const step = str(args, "step");
        const n = int(args, "lines", 1, 1000) ?? 100;
        const steps = this.preview.steps(sessionId);
        if (!steps.length) throw new Error("The preview has not been started since Kermanych started: there are no logs. Call preview_start.");
        if (!steps.includes(step)) throw new Error(`No log for \`${step}\` in the latest start. Its steps: ${steps.join(", ")}.`);
        const lines = this.preview.tail(sessionId, step, n);
        return text(lines.length ? lines.join("\n") : "(no output yet)");
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // The session's device (mobile decision 10): an agent session of a Mobile project — or its
  // tester run, on the doer's device — on the device's queue, under the operator's pause. The
  // gate is checked on every call: tools listed before the project left Mobile stay in the list.
  private async callDevice(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.registry.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("This session no longer exists.");
    const tester = isTesterSession(session);
    if (session.kind !== "agent" && !tester) throw new Error(`The device is only for agent sessions (this is a ${session.kind}).`);
    const platform = this.registry.listProjects().find((p) => p.id === session.projectId)?.platform;
    if (!platformHasDevice(platform)) throw new Error(`The device is off: this project's platform is ${platform ?? "not set"}, not Mobile.`);
    // A tester run drives its doer's device, once its clean start has run; the doer is locked out
    // meanwhile (docs/specs/2026-11-04-tester-mobile-device.md, decisions 1 and 2).
    const owner = tester ? this.registry.listSessions().find((s) => s.id === session.parentSessionId) : session;
    if (!owner) throw new Error("The tested session no longer exists.");
    if (tester && !this.testerCleaned(session.id, owner.id))
      throw new Error("Start the preview with preview_start first: a «Тестувальник» run starts from a clean app.");
    if (!tester) this.refuseWhileTested(session);
    sessionId = owner.id;
    if (this.device.paused(sessionId)) throw new Error(DEVICE_PAUSED);
    const runtime = this.device.runtime(sessionId);
    if (!runtime) throw new Error("The device is not running. Start the live preview with preview_start: it boots the device.");
    switch (name) {
      case "device_snapshot": {
        const { text: body, refs } = formatDeviceTree(await this.device.tree(sessionId));
        this.deviceRefs.set(sessionId, refs);
        const head = `Device: ${runtime.name} (${runtime.platform}), screen ${runtime.screen.width}×${runtime.screen.height} ${unitsOf(runtime)}. The refs are valid for this snapshot only.`;
        return text(`${head}\n\n${body || "(the accessibility tree is empty: the screen may still be loading — wait, or look with device_screenshot)"}`);
      }
      case "device_screenshot": {
        const path = optStr(args, "path");
        // A tester run's screenshots go into the tested session's worktree: it has none of its own.
        if (path !== undefined && (!owner.worktree || !owner.worktreePath))
          throw new Error("`path` needs a session with its own worktree; this one works in the operator's checkout.");
        const file = path === undefined ? undefined : screenshotFile(owner.worktreePath, path);
        const png = await this.device.screenshot(sessionId);
        if (!file) return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, png);
        return text(`saved ${path} (${png.length} bytes)`);
      }
      case "device_tap": {
        const ref = optStr(args, "ref");
        const label = optStr(args, "label");
        const id = optStr(args, "id");
        const x = num(args, "x");
        const y = num(args, "y");
        const point = x !== undefined || y !== undefined;
        if ([ref, label, id].filter((v) => v !== undefined).length + (point ? 1 : 0) !== 1) throw new Error("Give exactly one of `ref`, `label`, `id`, or `x` with `y`.");
        if (point) {
          const at = onScreen(runtime, x, y);
          await this.device.tap(sessionId, at.x, at.y);
          return text(`tapped (${round(at.x)}, ${round(at.y)})`);
        }
        const el = ref !== undefined ? await this.refElement(sessionId, runtime, ref) : await this.findElement(sessionId, label, id);
        const at = centre(el.frame);
        await this.device.tap(sessionId, at.x, at.y);
        return text(`tapped ${describeElement(el)}`);
      }
      case "device_swipe": {
        const ref = optStr(args, "ref");
        const x = num(args, "x");
        const y = num(args, "y");
        const toX = num(args, "to_x");
        const toY = num(args, "to_y");
        const direction = optStr(args, "direction");
        const distance = num(args, "distance") ?? 0.5;
        const duration = int(args, "duration_ms", 50, 5000) ?? 300;
        if (ref !== undefined && (x !== undefined || y !== undefined)) throw new Error("Start at `ref` or at `x`,`y`, not both.");
        if ((x === undefined) !== (y === undefined)) throw new Error("Give both `x` and `y`.");
        if ((toX === undefined) !== (toY === undefined)) throw new Error("Give both `to_x` and `to_y`.");
        if ((toX !== undefined) === (direction !== undefined)) throw new Error("Give exactly one of `to_x`,`to_y` and `direction`.");
        if (direction !== undefined && !SWIPE_DIRECTIONS.includes(direction)) throw new Error("`direction` must be up, down, left or right");
        if (!(distance >= 0.05 && distance <= 1)) throw new Error("`distance` must be a fraction of the screen from 0.05 to 1");
        if (toX !== undefined && ref === undefined && x === undefined) throw new Error("Give the start: `x`,`y` or `ref`.");
        const { width, height } = runtime.screen;
        const from =
          ref !== undefined ? centre((await this.refElement(sessionId, runtime, ref)).frame) : x !== undefined ? onScreen(runtime, x, y) : { x: width / 2, y: height / 2 };
        let to: { x: number; y: number };
        if (toX !== undefined) to = onScreen(runtime, toX, toY);
        else {
          const dx = direction === "left" ? -width * distance : direction === "right" ? width * distance : 0;
          const dy = direction === "up" ? -height * distance : direction === "down" ? height * distance : 0;
          to = { x: clamp(from.x + dx, 0, width), y: clamp(from.y + dy, 0, height) };
        }
        await this.device.swipe(sessionId, from, to, duration);
        return text(`swiped from (${round(from.x)}, ${round(from.y)}) to (${round(to.x)}, ${round(to.y)}) in ${duration} ms`);
      }
      case "device_type": {
        const typed = args.text;
        if (typeof typed !== "string") throw new Error("`text` is required");
        const submit = bool(args, "submit", false);
        if (!typed && !submit) throw new Error("`text` is empty and `submit` is false: nothing to do.");
        if (typed) await this.device.type(sessionId, typed);
        if (submit) await this.device.press(sessionId, "enter");
        return text(`typed ${[...typed].length} characters${submit ? " and pressed Enter" : ""}`);
      }
      case DEVICE_CREDENTIAL_TOOL: {
        if (!tester) throw new Error(`${DEVICE_CREDENTIAL_TOOL} is only for «Тестувальник» runs.`);
        const { account, field, value } = credentialValue(this.registry, session.projectId, args);
        const submit = bool(args, "submit", false);
        try {
          await this.device.type(sessionId, value, { secret: true });
          if (submit) await this.device.press(sessionId, "enter");
        } catch (err) {
          throw new Error(maskSecret((err as Error)?.message ?? String(err), value));
        }
        return text(`typed the ${field} of «${account.name}»${submit ? " and pressed Enter" : ""}`);
      }
      case "device_press": {
        const button = str(args, "button");
        if (!(DEVICE_BUTTONS as readonly string[]).includes(button)) throw new Error(`\`button\` must be one of ${DEVICE_BUTTONS.join(", ")}`);
        const has = DEVICE_PLATFORM_BUTTONS[runtime.platform];
        if (!has.includes(button as DeviceButton)) throw new Error(`An ${runtime.platform} device has no ${button} button (it has: ${has.join(", ")}).`);
        await this.device.press(sessionId, button as DeviceButton);
        return text(`pressed ${button}`);
      }
      case "device_wait_for": {
        const waitText = optStr(args, "text");
        const id = optStr(args, "id");
        if ((waitText === undefined) === (id === undefined)) throw new Error("Give exactly one of `text` and `id`.");
        const timeout = args.timeout === undefined || args.timeout === null ? 10 : args.timeout;
        if (typeof timeout !== "number" || !(timeout >= 0 && timeout <= 60)) throw new Error("`timeout` must be a number of seconds from 0 to 60");
        const gone = bool(args, "gone", false);
        const matches = (e: DeviceElement) =>
          waitText !== undefined ? !!(e.label?.includes(waitText) || e.value?.includes(waitText)) : e.id === id;
        const started = Date.now();
        const deadline = started + timeout * 1000;
        for (;;) {
          const found = flatten(await this.device.tree(sessionId)).find(matches);
          if (gone ? !found : found) return text(`${gone ? "gone" : `found ${describeElement(found!)}`} after ${Date.now() - started} ms`);
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`${gone ? "Still on the screen" : "Not on the screen"} after ${timeout} s: ${waitText !== undefined ? `text ${JSON.stringify(waitText)}` : `id ${id}`}.`);
          await sleep(Math.min(DEVICE_WAIT_POLL_MS, left));
        }
      }
      case "device_open_url": {
        const url = str(args, "url");
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new Error("`url` needs a scheme, e.g. myapp://path or https://example.com");
        await this.device.openUrl(sessionId, url);
        return text(`opened ${url}`);
      }
      case "device_app": {
        const action = args.action;
        if (action !== "launch" && action !== "terminate" && action !== "restart") throw new Error("`action` must be launch, terminate or restart");
        const state = await this.preview.app(sessionId, action);
        const running = state.phase === "running" && state.app === "running";
        if (action !== "terminate" && !running) throw new Error("The app did not start. Read preview_logs for `device` to see why.");
        return text(action === "terminate" ? (running ? "terminated the app, but it is running again" : "terminated the app") : `${action === "launch" ? "launched" : "restarted"} the app; it is running`);
      }
      case "device_rotate": {
        const orientation = args.orientation;
        if (orientation !== "portrait" && orientation !== "landscape") throw new Error("`orientation` must be portrait or landscape");
        await this.device.rotate(sessionId, orientation);
        // The screen space turned: every ref of the last snapshot points elsewhere now.
        this.deviceRefs.delete(sessionId);
        return text(`rotated to ${orientation}; take a new device_snapshot`);
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // A ref of the latest device_snapshot, in a fresh tree: the element of the same type and
  // label nearest to where the snapshot saw it, within REF_TOLERANCE. Anything else is refused
  // rather than tapped blind (mobile decision 10).
  private async refElement(sessionId: string, runtime: DeviceRuntime, ref: string): Promise<DeviceElement> {
    const seen = this.deviceRefs.get(sessionId)?.get(ref);
    if (!seen) throw new Error(`Unknown ref ${ref}: use a ref from the latest device_snapshot (take one first).`);
    const tolerance = Math.max(runtime.screen.width, runtime.screen.height) * REF_TOLERANCE;
    const was = centre(seen.frame);
    let best: DeviceElement | undefined;
    let bestDistance = Infinity;
    for (const e of flatten(await this.device.tree(sessionId))) {
      if (e.type !== seen.type || e.label !== seen.label) continue;
      const c = centre(e.frame);
      const d = Math.hypot(c.x - was.x, c.y - was.y);
      if (d <= tolerance && d < bestDistance) [best, bestDistance] = [e, d];
    }
    if (!best)
      throw new Error(
        `${ref} (${seen.type}${seen.label ? ` ${JSON.stringify(seen.label)}` : ""}) is no longer where device_snapshot saw it: the screen changed. Take a new device_snapshot.`,
      );
    return best;
  }

  // device_tap by label or id: the first match on screen, an enabled one first.
  private async findElement(sessionId: string, label: string | undefined, id: string | undefined): Promise<DeviceElement> {
    const all = flatten(await this.device.tree(sessionId)).filter(
      (e) => e.frame.width > 0 && e.frame.height > 0 && (label !== undefined ? e.label === label : e.id === id),
    );
    const el = all.find((e) => e.enabled) ?? all[0];
    if (!el) throw new Error(`No element with ${label !== undefined ? `label ${JSON.stringify(label)}` : `id ${id}`} on the screen. Take a device_snapshot to see what is there.`);
    return el;
  }
}

const DEVICE_PAUSED = "The operator paused your control of this session's device and preview. Ask them to resume it, or wait.";
const DEVICE_BUSY =
  "The device is busy with a «Тестувальник» run of this session: wait until it ends (the operator hands its result over to you or discards it). preview_status and preview_logs still answer.";
const SWIPE_DIRECTIONS = ["up", "down", "left", "right"];

function unitsOf(runtime: DeviceRuntime): string {
  return runtime.platform === "ios" ? "points" : "pixels";
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function flatten(tree: DeviceElement[]): DeviceElement[] {
  const out: DeviceElement[] = [];
  walk(tree, (e) => out.push(e));
  return out;
}

// A point the agent gave, refused when it is off the screen.
function onScreen(runtime: DeviceRuntime, x: number | undefined, y: number | undefined): { x: number; y: number } {
  const { width, height } = runtime.screen;
  if (x === undefined || y === undefined) throw new Error("Give both `x` and `y`.");
  if (x < 0 || y < 0 || x > width || y > height) throw new Error(`(${x}, ${y}) is off the screen: it is ${width}×${height} ${unitsOf(runtime)}.`);
  return { x, y };
}
