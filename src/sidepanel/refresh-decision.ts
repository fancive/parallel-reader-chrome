import type { InflightEntry, InflightLocating } from '../shared/analyze-inflight';
import type { PageState } from './page-cache';

export type RefreshDecision =
  | { kind: 'render-cached'; state: PageState }
  | { kind: 'show-stale'; cachedFingerprint: string; liveFingerprint: string }
  | { kind: 'resume-inflight'; entry: InflightLocating }
  | { kind: 'idle' };

export type RefreshDecisionInput = {
  readonly cached: PageState | null;
  // `null` means the caller chose not to compute it (e.g. cached.fingerprint
  // was empty/sentinel and the mismatch check should be skipped).
  readonly liveFingerprint: string | null;
  readonly inflight: InflightEntry | null;
  readonly runningLocally: boolean;
  // Current side panel's tabId, when bound. Used to gate resume so a side
  // panel for tab B doesn't pick up an inflight that tab A wrote — the
  // resume would then locate against B's DOM, which is wrong.
  readonly currentTabId: number | null;
};

/**
 * Pure decision function for refreshCurrentPage. Side effects (DOM, storage,
 * status messages) live in the caller; this resolver only declares intent.
 *
 * Branches must mirror src/sidepanel.ts:refreshCurrentPage. The mapping is:
 *   cached + matching/empty fingerprint  -> render-cached
 *   cached + mismatching fingerprint     -> show-stale
 *   no cache + locating + not busy       -> resume-inflight
 *   anything else                        -> idle
 */
export function decideRefreshAction(input: Readonly<RefreshDecisionInput>): RefreshDecision {
  const { cached, liveFingerprint, inflight, runningLocally, currentTabId } = input;

  if (cached) {
    if (
      cached.fingerprint &&
      liveFingerprint !== null &&
      liveFingerprint !== cached.fingerprint
    ) {
      return {
        kind: 'show-stale',
        cachedFingerprint: cached.fingerprint,
        liveFingerprint,
      };
    }
    return { kind: 'render-cached', state: cached };
  }

  if (
    inflight?.phase === 'locating' &&
    !runningLocally &&
    (currentTabId === null || inflight.tabId === currentTabId)
  ) {
    return { kind: 'resume-inflight', entry: inflight };
  }

  return { kind: 'idle' };
}
