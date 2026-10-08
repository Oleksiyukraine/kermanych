// CDP plumbing for one session view: a bounded sendCommand, injected-script evaluation, and the
// error text a page exception becomes.
import type { SessionView } from './view';

// A CDP command that has not answered by then is reported instead of hanging the agent's turn.
export const CDP_TIMEOUT_MS = 15_000;

export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), ms);
  work.catch(() => {}); // a late rejection after the timeout must not go unhandled
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CdpException {
  text?: string;
  exception?: { description?: string; value?: unknown };
}

export function exceptionMessage(details: CdpException): string {
  const ex = details.exception;
  // Our injected scripts throw plain Errors whose message is the whole story.
  if (ex?.description) return ex.description.split('\n')[0]!.replace(/^Error: /, '');
  if (ex && ex.value !== undefined) return `Uncaught ${JSON.stringify(ex.value)}`;
  return details.text ?? 'Uncaught exception';
}

export interface CdpRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export async function cdp<T = unknown>(v: SessionView, method: string, params?: object): Promise<T> {
  if (v.wc.isDestroyed()) throw new Error('The session browser was closed');
  // DevTools' "detach" or a crashed renderer drops the session; take it back on next use.
  if (!v.wc.debugger.isAttached()) v.ensureDebugger();
  return withTimeout(
    v.wc.debugger.sendCommand(method, params) as Promise<T>,
    CDP_TIMEOUT_MS,
    `The page did not answer ${method} within ${CDP_TIMEOUT_MS / 1000}s`,
  );
}

// An injected script's value; a thrown error becomes the tool's error.
export async function run<T>(v: SessionView, expression: string): Promise<T> {
  const res = await cdp<{ result: CdpRemoteObject; exceptionDetails?: CdpException }>(v, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails));
  return res.result.value as T;
}
