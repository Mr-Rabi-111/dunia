import { el, icon, fold } from './util.js';

/**
 * Accessible searchable picker (combobox + listbox) used for countries,
 * languages and the UI language. Native <select> can't show flag images or
 * online counts, and 200 countries need type-to-search.
 *
 * openPicker({
 *   anchor,            // button that opens it (gets aria-expanded)
 *   options: [{ value, label, sub?, meta?, icon?: () => Node, keywords?, group? }],
 *   value,             // currently selected value
 *   onSelect(value),
 *   placeholder,       // search box placeholder
 *   emptyText,         // "No results"
 * })
 */
let current = null;

export function closePicker(restoreFocus = true) {
  if (!current) return;
  const { root, scrim, anchor, onKey, onResize } = current;
  root.remove();
  scrim.remove();
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) anchor.focus();
  current = null;
}

export const pickerOpen = () => !!current;

export function openPicker({ anchor, options, value, onSelect, placeholder = '', emptyText = '' }) {
  closePicker(false);
  const listId = `pk-${Math.random().toString(36).slice(2, 8)}`;
  const input = el('input', {
    type: 'search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId,
    'aria-autocomplete': 'list', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false',
  });
  const list = el('ul', { class: 'picker-list', role: 'listbox', id: listId });
  const root = el('div', { class: 'picker' },
    el('div', { class: 'picker-search' }, icon('i-search'), input),
    list,
  );
  const scrim = el('div', { class: 'picker-scrim' });
  scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); closePicker(); });

  const indexed = options.map((o, i) => ({
    ...o,
    id: `${listId}-${i}`,
    hay: fold([o.label, o.sub, o.keywords, o.value].filter(Boolean).join(' ')),
  }));
  let visible = [];
  let active = 0;

  function render() {
    const q = fold(input.value.trim());
    if (q) {
      // Groups ("Your country", "Most active") repeat options; show each once when searching.
      const seen = new Set();
      visible = indexed.filter((o) => o.hay.includes(q) && !seen.has(o.value) && seen.add(o.value));
    } else {
      visible = indexed;
    }
    list.replaceChildren();
    if (!visible.length) {
      list.append(el('li', { class: 'picker-empty', text: emptyText }));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = null;
    visible.forEach((o, i) => {
      if (!q && o.group && o.group !== lastGroup) {
        list.append(el('li', { class: 'picker-group', role: 'presentation', text: o.group }));
      }
      lastGroup = o.group;
      const li = el('li', {
        class: `picker-opt${i === active ? ' active' : ''}`,
        role: 'option', id: o.id, 'aria-selected': String(o.value === value),
      });
      if (o.icon) li.append(o.icon());
      const text = el('span', { class: 'po-label' }, o.label);
      if (o.sub) text.append(' ', el('span', { class: 'po-sub', text: o.sub }));
      li.append(text);
      if (o.meta) li.append(el('span', { class: 'po-meta', text: o.meta }));
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(o));
      li.addEventListener('pointermove', () => setActive(i, false));
      list.append(li);
    });
    input.setAttribute('aria-activedescendant', visible[active]?.id || '');
  }

  function setActive(i, scroll = true) {
    if (!visible.length) return;
    active = (i + visible.length) % visible.length;
    list.querySelectorAll('.picker-opt').forEach((n) => n.classList.toggle('active', n.id === visible[active].id));
    input.setAttribute('aria-activedescendant', visible[active].id);
    if (scroll) document.getElementById(visible[active].id)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(o) {
    closePicker();
    onSelect(o.value);
  }

  input.addEventListener('input', () => { active = 0; render(); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && !input.value) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !input.value) { e.preventDefault(); setActive(visible.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (visible[active]) choose(visible[active]); }
    else if (e.key === 'Tab') { closePicker(false); }
  };

  function position() {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 300), vw - 16);
    root.style.width = `${width}px`;
    const rtl = document.documentElement.dir === 'rtl';
    let left = rtl ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    root.style.left = `${left}px`;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    if (below < 280 && above > below) {
      root.style.top = '';
      root.style.bottom = `${vh - r.top + 6}px`;
      root.style.maxHeight = `${Math.min(440, above)}px`;
    } else {
      root.style.bottom = '';
      root.style.top = `${r.bottom + 6}px`;
      root.style.maxHeight = `${Math.min(440, below)}px`;
    }
  }
  const onResize = () => position();

  document.body.append(scrim, root);
  const selIndex = indexed.findIndex((o) => o.value === value);
  active = Math.max(0, selIndex);
  render();
  position();
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  current = { root, scrim, anchor, onKey, onResize };
  // Don't pop the on-screen keyboard over the list on phones.
  if (window.matchMedia('(hover: hover)').matches) input.focus();
  if (selIndex > 0) document.getElementById(indexed[selIndex].id)?.scrollIntoView({ block: 'center' });
}
