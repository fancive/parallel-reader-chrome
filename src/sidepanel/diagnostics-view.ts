import {
  type DiagEntry,
  defaultDiagStorage,
  diagClear,
  diagSnapshot,
} from '../shared/diag-log';
import { t } from '../shared/i18n';
import { $ } from './dom';

const MAX_DISPLAY_ENTRIES = 80;

type RuntimeSnapshot = {
  ts: number;
  pageKey: string;
  inflight: unknown;
  lastState: unknown;
};

type DiagViewDeps = {
  readSnapshot: () => Promise<RuntimeSnapshot>;
  setStatus: (text: string) => void;
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23);
}

function renderState(snapshot: Readonly<RuntimeSnapshot>): void {
  $('diag-page-key').textContent = snapshot.pageKey || t('diagnosticsEmpty');
  $('diag-inflight').textContent = snapshot.inflight
    ? JSON.stringify(snapshot.inflight, null, 2)
    : t('diagnosticsEmpty');
  $('diag-last-state').textContent = snapshot.lastState
    ? JSON.stringify(snapshot.lastState, null, 2)
    : t('diagnosticsEmpty');
}

function renderTraceLog(entries: readonly DiagEntry[]): void {
  if (entries.length === 0) {
    $('diag-log').textContent = t('diagnosticsEmpty');
    return;
  }
  const tail = entries.slice(-MAX_DISPLAY_ENTRIES);
  const lines = tail.map((e) => `${formatTs(e.ts)}  ${e.tag}  ${JSON.stringify(e.payload)}`);
  $('diag-log').textContent = lines.join('\n');
}

async function refreshDiagnostics(deps: Readonly<DiagViewDeps>): Promise<void> {
  const [snapshot, entries] = await Promise.all([
    deps.readSnapshot(),
    diagSnapshot(defaultDiagStorage()),
  ]);
  renderState(snapshot);
  renderTraceLog(entries);
}

async function copyDiagnostics(deps: Readonly<DiagViewDeps>): Promise<void> {
  const [snapshot, entries] = await Promise.all([
    deps.readSnapshot(),
    diagSnapshot(defaultDiagStorage()),
  ]);
  const payload = JSON.stringify({ snapshot, entries }, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    deps.setStatus(t('diagnosticsCopied'));
  } catch {
    // Fallback: select pre and rely on user copy
    const log = $('diag-log');
    log.textContent = payload;
    deps.setStatus(t('diagnosticsCopied'));
  }
}

async function clearTrace(deps: Readonly<DiagViewDeps>): Promise<void> {
  await diagClear(defaultDiagStorage());
  await refreshDiagnostics(deps);
  deps.setStatus(t('diagnosticsCleared'));
}

export function bindDiagnostics(deps: Readonly<DiagViewDeps>): void {
  const panel = document.getElementById('diagnostics-panel') as HTMLDetailsElement | null;
  if (!panel) return;
  panel.hidden = !document.body.classList.contains('debug-mode');
  panel.addEventListener('toggle', () => {
    if (panel.open) void refreshDiagnostics(deps);
  });
  $('diag-refresh').addEventListener('click', () => void refreshDiagnostics(deps));
  $('diag-copy').addEventListener('click', () => void copyDiagnostics(deps));
  $('diag-clear').addEventListener('click', () => void clearTrace(deps));
}

export function applyDiagnosticsVisibility(debugEnabled: boolean): void {
  const panel = document.getElementById('diagnostics-panel') as HTMLDetailsElement | null;
  if (!panel) return;
  panel.hidden = !debugEnabled;
}
