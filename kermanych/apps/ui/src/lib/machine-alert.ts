import type { MachineAlert } from '@kermanych/core';

// Not core's `humanBytes`: that one tops out at KB (it sizes file reads), and a watchdog
// subtree is gigabytes — «9437184.0 KB» says nothing at a glance.
export function memorySize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

type Tr = (key: string, named?: Record<string, unknown>) => string;

export interface MachineAlertView {
  message: string;
  kind: 'error' | 'info';
  // «Зупинити команду» is offered only for a named, still-running command: a killed one is
  // gone, and an alert without a session has nothing of Керманич's to stop.
  killable: boolean;
}

// How a watchdog finding (spec decision 7) reads to the operator. Warn and critical-but-not-
// killed share the wording — what differs is the severity and whether the watchdog acted.
export function machineAlertView(alert: MachineAlert, t: Tr): MachineAlertView {
  const kind = alert.level === 'critical' ? 'error' : 'info';
  if (!alert.sessionId) {
    return { message: t('machineAlert.notAgents'), kind, killable: false };
  }
  const named = {
    name: alert.sessionName ?? '',
    command: alert.command ?? '',
    size: memorySize(alert.rssBytes),
  };
  // A warn-level kill is the operator's own «Зупинити команду» echoing back: confirmation,
  // not alarm. A critical one is the watchdog acting on its own.
  if (alert.killed) {
    return alert.level === 'critical'
      ? { message: t('machineAlert.killed', named), kind: 'error', killable: false }
      : { message: t('machineAlert.stopped', named), kind: 'info', killable: false };
  }
  return { message: t('machineAlert.heavy', named), kind, killable: alert.pid !== undefined };
}
