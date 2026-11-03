import { describe, expect, it } from 'vitest';
import type { PreviewConfigStatus } from '@kermanych/core';
import { mergePreviewLogs, PREVIEW_LOG_LIMIT, previewStatusView, previewTabStatus } from '../src/lib/preview-view';

const ok: PreviewConfigStatus = { kind: 'ok', services: ['api', 'web'] };

describe('previewStatusView', () => {
  it('waits for the config before saying anything about an idle preview', () => {
    expect(previewStatusView(null, undefined)).toBeNull();
    expect(previewStatusView({ phase: 'stopped' }, undefined)).toBeNull();
  });

  it('names the step being started, setup apart', () => {
    expect(previewStatusView({ phase: 'starting', step: 'setup', services: [] }, ok)).toEqual({ key: 'setup', params: {}, tone: 'busy' });
    expect(previewStatusView({ phase: 'starting', step: 'api', services: [] }, undefined)).toEqual({
      key: 'starting',
      params: { service: 'api' },
      tone: 'busy',
    });
  });

  it('shows what runs even when the file broke meanwhile', () => {
    expect(previewStatusView({ phase: 'running', url: 'http://localhost:1', services: [] }, { kind: 'invalid', error: 'x' })?.key).toBe('running');
  });

  it('puts a missing or broken file ahead of how the last run ended', () => {
    expect(previewStatusView({ phase: 'crashed', step: 'web', code: 1, signal: null }, { kind: 'missing' })?.key).toBe('missing');
    expect(previewStatusView(null, { kind: 'invalid', error: 'services[0].command: required' })).toEqual({
      key: 'invalid',
      params: { error: 'services[0].command: required' },
      tone: 'error',
    });
  });

  it('reads crashes, failures, stops and never-started', () => {
    expect(previewStatusView({ phase: 'crashed', step: 'web', code: 137, signal: null }, ok)).toEqual({
      key: 'crashed',
      params: { service: 'web', code: 137 },
      tone: 'error',
    });
    expect(previewStatusView({ phase: 'crashed', step: 'web', code: null, signal: 'SIGKILL' }, ok)?.params).toEqual({ service: 'web', signal: 'SIGKILL' });
    expect(previewStatusView({ phase: 'failed', step: 'setup', error: 'exit 1' }, ok)?.key).toBe('failed');
    expect(previewStatusView({ phase: 'stopped' }, ok)?.key).toBe('stopped');
    expect(previewStatusView(null, ok)?.key).toBe('idle');
  });
});

describe('previewTabStatus', () => {
  it('marks starting, running and broken previews only', () => {
    expect(previewTabStatus({ phase: 'starting', step: 'setup', services: [] })).toBe('busy');
    expect(previewTabStatus({ phase: 'running', url: 'http://localhost:1', services: [] })).toBe('ok');
    expect(previewTabStatus({ phase: 'failed', step: 'web', error: 'x' })).toBe('error');
    expect(previewTabStatus({ phase: 'crashed', step: 'web', code: 1, signal: null })).toBe('error');
    expect(previewTabStatus({ phase: 'stopped' })).toBeUndefined();
    expect(previewTabStatus(undefined)).toBeUndefined();
  });
});

describe('mergePreviewLogs', () => {
  const line = (seq: number) => ({ seq, text: `l${seq}` });

  it('appends within a run and moves the cursor', () => {
    const first = mergePreviewLogs(undefined, { run: 1, steps: ['setup'], lines: [line(1), line(2)], next: 2 });
    const second = mergePreviewLogs(first, { run: 1, steps: ['setup'], lines: [line(3)], next: 3 });
    expect(second).toEqual({ run: 1, lines: [line(1), line(2), line(3)], next: 3 });
  });

  it('keeps the same buffer when nothing new arrived', () => {
    const first = mergePreviewLogs(undefined, { run: 1, steps: [], lines: [line(1)], next: 1 });
    expect(mergePreviewLogs(first, { run: 1, steps: [], lines: [], next: 1 })).toBe(first);
  });

  it('starts over on a new run', () => {
    const first = mergePreviewLogs(undefined, { run: 1, steps: [], lines: [line(1)], next: 1 });
    expect(mergePreviewLogs(first, { run: 2, steps: [], lines: [line(9)], next: 9 })).toEqual({ run: 2, lines: [line(9)], next: 9 });
  });

  it('keeps only the last PREVIEW_LOG_LIMIT lines', () => {
    const many = Array.from({ length: PREVIEW_LOG_LIMIT }, (_, i) => line(i + 1));
    const first = mergePreviewLogs(undefined, { run: 1, steps: [], lines: many, next: PREVIEW_LOG_LIMIT });
    const second = mergePreviewLogs(first, { run: 1, steps: [], lines: [line(PREVIEW_LOG_LIMIT + 1)], next: PREVIEW_LOG_LIMIT + 1 });
    expect(second.lines).toHaveLength(PREVIEW_LOG_LIMIT);
    expect(second.lines[0]!.seq).toBe(2);
  });
});
