import type { InflightEntry } from '../shared/analyze-inflight';

export type IdleStatusKey =
  | 'statusReading'
  | 'statusReadingTitled'
  | 'statusWaiting'
  | 'statusWaitingTitled';

export type IdleStatus = {
  messageKey: IdleStatusKey;
  title?: string;
};

export function selectIdleStatus(input: {
  inflight: InflightEntry | null;
  runningLocally: boolean;
  title: string;
}): IdleStatus {
  if (input.runningLocally || input.inflight !== null) {
    return input.title
      ? { messageKey: 'statusReadingTitled', title: input.title }
      : { messageKey: 'statusReading' };
  }
  return input.title
    ? { messageKey: 'statusWaitingTitled', title: input.title }
    : { messageKey: 'statusWaiting' };
}
