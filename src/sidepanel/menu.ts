import type { Card, LocateResponse } from '../shared/types';
import { copyText } from './clipboard';
import { $ } from './dom';

type CardResult = { card: Card; locate: LocateResponse };

export type MenuDeps = {
  highlightCardAnchor: (anchor: string, index: number, canHighlight: boolean) => Promise<void>;
  setStatus: (text: string) => void;
};

export function cardSummaryText(card: Readonly<Card>, index: number): string {
  const bullets = card.bullets.map((bullet) => `- ${bullet}`);
  return [
    `${index + 1}. ${card.title}`,
    '',
    `Quote: ${card.anchor}`,
    '',
    card.gist,
    ...bullets,
  ].join('\n').trim();
}

export function closeCardMenu(): void {
  const menu = $('card-menu');
  menu.hidden = true;
  menu.textContent = '';
}

function getMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
}

function handleMenuKeydown(event: KeyboardEvent, menu: HTMLElement): void {
  const items = getMenuItems(menu);
  if (items.length === 0) return;

  const current = document.activeElement as HTMLButtonElement | null;
  const currentIndex = current ? items.indexOf(current) : -1;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
    items[next]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    items[prev]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCardMenu();
  } else if (event.key === 'Tab') {
    closeCardMenu();
  }
}

function appendMenuButton(
  menu: HTMLElement,
  label: string,
  disabled: boolean,
  onClick: () => void | Promise<void>,
): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.role = 'menuitem';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', () => {
    void onClick();
  });
  menu.appendChild(button);
}

function positionCardMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(margin, clientX), window.innerWidth - rect.width - margin);
  const top = Math.min(Math.max(margin, clientY), window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

export function showCardMenu(
  result: Readonly<CardResult>,
  index: number,
  clientX: number,
  clientY: number,
  deps: MenuDeps,
): void {
  const { card, locate } = result;
  const canHighlight = locate.domRange;
  const menu = $('card-menu');
  menu.textContent = '';

  const title = document.createElement('div');
  title.className = 'card-menu-title';
  title.textContent = `#${index + 1}`;
  menu.appendChild(title);

  appendMenuButton(menu, '高亮定位', !canHighlight, () =>
    deps.highlightCardAnchor(card.anchor, index, canHighlight),
  );
  appendMenuButton(menu, '复制引用', false, async () => {
    closeCardMenu();
    await copyText(card.anchor, `已复制引用 #${index + 1}`, deps.setStatus);
  });
  appendMenuButton(menu, '复制摘要', false, async () => {
    closeCardMenu();
    await copyText(cardSummaryText(card, index), `已复制摘要 #${index + 1}`, deps.setStatus);
  });

  menu.onkeydown = (event) => handleMenuKeydown(event, menu);

  positionCardMenu(menu, clientX, clientY);
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}
