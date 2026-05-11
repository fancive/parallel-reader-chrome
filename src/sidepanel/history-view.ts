import { t } from '../shared/i18n';
import {
  type HistoryEntry,
  formatAnalyzedAt,
  truncateUrl,
} from './history';

export type HistoryViewDeps = {
  onOpen: (entry: Readonly<HistoryEntry>) => void | Promise<void>;
  onDelete: (entry: Readonly<HistoryEntry>) => void | Promise<void>;
  onExport: (entry: Readonly<HistoryEntry>) => void | Promise<void>;
};

function makeMetaLine(text: string, className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function makeActionButton(label: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function renderHistoryItem(
  entry: Readonly<HistoryEntry>,
  deps: HistoryViewDeps,
): HTMLElement {
  const item = document.createElement('article');
  item.className = 'history-item';
  item.dataset.pageKey = entry.pageKey;

  const titleEl = makeMetaLine(entry.title || entry.url, 'history-title');
  item.appendChild(titleEl);

  const urlEl = makeMetaLine(truncateUrl(entry.url), 'history-url');
  urlEl.title = entry.url;
  item.appendChild(urlEl);

  const stamp = formatAnalyzedAt(entry.analyzedAt);
  const cardCountText = t('historyCardsCount', { count: entry.cardCount });
  const metaEl = makeMetaLine(`${stamp} · ${cardCountText}`, 'history-meta');
  item.appendChild(metaEl);

  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  const openBtn = makeActionButton(t('historyOpen'), 'history-action');
  openBtn.addEventListener('click', () => {
    void deps.onOpen(entry);
  });
  actions.appendChild(openBtn);

  const exportBtn = makeActionButton(t('historyExportMarkdown'), 'history-action');
  exportBtn.disabled = entry.cardCount === 0;
  exportBtn.addEventListener('click', () => {
    void deps.onExport(entry);
  });
  actions.appendChild(exportBtn);

  const deleteBtn = makeActionButton(t('historyDelete'), 'history-action history-action-danger');
  deleteBtn.dataset.state = 'idle';
  deleteBtn.addEventListener('click', () => {
    if (deleteBtn.dataset.state === 'confirm') {
      deleteBtn.dataset.state = 'idle';
      void deps.onDelete(entry);
      return;
    }
    deleteBtn.dataset.state = 'confirm';
    deleteBtn.textContent = t('historyDeleteConfirm');
    setTimeout(() => {
      if (deleteBtn.dataset.state === 'confirm') {
        deleteBtn.dataset.state = 'idle';
        deleteBtn.textContent = t('historyDelete');
      }
    }, 3000);
  });
  actions.appendChild(deleteBtn);

  item.appendChild(actions);
  return item;
}

export function renderHistoryList(
  container: HTMLElement,
  emptyState: HTMLElement,
  entries: ReadonlyArray<HistoryEntry>,
  deps: HistoryViewDeps,
): void {
  container.textContent = '';
  if (entries.length === 0) {
    emptyState.hidden = false;
    container.hidden = true;
    return;
  }
  emptyState.hidden = true;
  container.hidden = false;
  for (const entry of entries) {
    container.appendChild(renderHistoryItem(entry, deps));
  }
}

export function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
