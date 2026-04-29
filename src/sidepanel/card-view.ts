import type { Card, LocateResponse } from '../shared/types';

type CardResult = { card: Card; locate: LocateResponse };

export function cardClassName(canHighlight: boolean): string {
  return canHighlight ? 'card' : 'card miss';
}

export function cardAriaLabel(index: number, canHighlight: boolean): string {
  return canHighlight
    ? `高亮定位第 ${index + 1} 张卡片`
    : `第 ${index + 1} 张卡片暂时无法定位`;
}

export function cardTitleAttr(canHighlight: boolean): string {
  return canHighlight ? '点击高亮定位，右键查看更多操作' : '右键查看更多操作';
}

export type CardViewDeps = {
  highlightCardAnchor: (anchor: string, index: number, canHighlight: boolean) => Promise<void>;
  showCardMenu: (
    result: Readonly<CardResult>,
    index: number,
    clientX: number,
    clientY: number,
  ) => void;
};

let activeCardEl: HTMLElement | null = null;

export function setActiveCard(index: number): void {
  activeCardEl?.classList.remove('card-active');
  const el = document.querySelector<HTMLElement>(`[data-card-index="${index}"]`);
  activeCardEl = el;
  el?.classList.add('card-active');
}

function makeBadge(label: string, hit: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = `badge ${hit ? 'hit' : 'miss'}`;
  span.textContent = `${label} ${hit ? '✓' : '✗'}`;
  return span;
}

function makeCardHead(card: Readonly<Card>, index: number, locate: LocateResponse): HTMLElement {
  const head = document.createElement('div');
  head.className = 'card-head';

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = `${index + 1}. ${card.title}`;
  head.appendChild(titleEl);

  const badges = document.createElement('div');
  badges.className = 'card-badges debug-only';
  badges.appendChild(makeBadge('原文', locate.rawHit));
  badges.appendChild(makeBadge('正文', locate.readabilityHit));
  badges.appendChild(makeBadge('定位', locate.domRange));
  head.appendChild(badges);

  return head;
}

export function renderCard(result: CardResult, index: number, deps: CardViewDeps): HTMLElement {
  const { card, locate } = result;
  const canHighlight = locate.domRange;

  const el = document.createElement('div');
  el.className = `card${canHighlight ? '' : ' miss'}`;
  el.tabIndex = 0;
  el.role = 'button';
  el.setAttribute('data-card-index', String(index));
  el.ariaLabel = canHighlight
    ? `高亮定位第 ${index + 1} 张卡片`
    : `第 ${index + 1} 张卡片暂时无法定位`;
  el.title = canHighlight ? '点击高亮定位，右键查看更多操作' : '右键查看更多操作';

  el.appendChild(makeCardHead(card, index, locate));

  const anchorEl = document.createElement('div');
  anchorEl.className = 'card-anchor';
  anchorEl.textContent = card.anchor;
  el.appendChild(anchorEl);

  const gistEl = document.createElement('div');
  gistEl.className = 'card-gist';
  gistEl.textContent = card.gist;
  el.appendChild(gistEl);

  const ul = document.createElement('ul');
  ul.className = 'card-bullets';
  for (const bullet of card.bullets) {
    const li = document.createElement('li');
    li.textContent = bullet;
    ul.appendChild(li);
  }
  el.appendChild(ul);

  el.addEventListener('click', () => {
    void deps.highlightCardAnchor(card.anchor, index, canHighlight);
  });

  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    deps.showCardMenu(result, index, event.clientX, event.clientY);
  });

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void deps.highlightCardAnchor(card.anchor, index, canHighlight);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      deps.showCardMenu(result, index, rect.left + 28, rect.top + 28);
    }
  });

  return el;
}
