import { modifiers, modifierLabel, navigation, prefixMatches, rows, shortcutLabel } from '../model/keyboard';
import type { Binding, Modifier, Snapshot, Stroke, ToHost, ToWebview } from '../model/types';
import { mountCapture } from './capture';

export interface WebviewApi {
  postMessage(message: ToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
interface ViewState {
  modifiers: Modifier[];
  customOnly: boolean;
  query: string;
  selected: Stroke[];
  selectedBindingId?: string;
}
const emptyState = (): ViewState => ({ modifiers: [], customOnly: false, query: '', selected: [] });
function restoredState(value: unknown): ViewState {
  if (!value || typeof value !== 'object') return emptyState();
  const saved = value as Partial<ViewState>;
  return {
    modifiers: modifiers.filter(m => Array.isArray(saved.modifiers) && saved.modifiers.includes(m)),
    customOnly: saved.customOnly === true,
    query: typeof saved.query === 'string' ? saved.query : '',
    selected: Array.isArray(saved.selected) ? saved.selected.filter(s => s && typeof s.canonical === 'string' && typeof s.key === 'string' && Array.isArray(s.modifiers)) : [],
    selectedBindingId: typeof saved.selectedBindingId === 'string' ? saved.selectedBindingId : undefined,
  };
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text: string, onClick: () => void, className = ''): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
function title(binding: Binding): string { return binding.label || binding.command || 'Disabled shortcut'; }
function searchable(binding: Binding): string {
  return [binding.key, binding.command, binding.label, binding.when, binding.source, binding.reason].filter(Boolean).join(' ').toLowerCase();
}
function currentBindings(snapshot: Snapshot, state: ViewState): Binding[] {
  return snapshot.bindings.filter(b => !state.customOnly || b.source === 'custom');
}
function active(binding: Binding): boolean { return binding.status === 'active'; }

/** Mounts a self-contained, text-only UI. Returns cleanup for tests and panel disposal. */
export function mountApp(root: HTMLElement, api: WebviewApi): () => void {
  let snapshot: Snapshot | undefined;
  let state = restoredState(api.getState());
  let loading = true;
  let searchOpen = false;
  let activeResult = 0;
  let lastDetailsKey = '';
  root.tabIndex = 0;
  root.setAttribute('aria-label', 'Keybindings Visualizer. Press a shortcut to inspect it.');
  function change(update: Partial<ViewState>): void {
    state = { ...state, ...update };
    api.setState(state);
    render();
  }
  function choose(binding: Binding): void {
    searchOpen = false;
    root.focus();
    change({ selected: binding.strokes, selectedBindingId: binding.id, modifiers: binding.strokes.at(-1)?.modifiers ?? [] });
  }
  function render(): void {
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusId = focused?.id;
    const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null;
    const oldDetailsScroll = root.querySelector('.details-scroll')?.scrollTop ?? 0;
    root.replaceChildren();
    const header = element('header', 'page-header');
    const heading = element('div', 'heading');
    heading.append(element('span', 'brand-mark', '⌨'), element('h1', '', 'Keybindings Visualizer'));
    const actions = element('div', 'header-actions');
    actions.append(button('Choose file…', () => api.postMessage({ type: 'chooseFile' }), 'secondary'), button('Refresh', () => api.postMessage({ type: 'refresh' }), 'secondary'));
    header.append(heading, actions);
    root.append(header);
    if (!snapshot) {
      const wait = element('div', 'empty-state', 'Loading default and custom keybindings…');
      wait.setAttribute('role', 'status');
      root.append(wait);
      return;
    }
    const data = snapshot;
    const bindings = currentBindings(data, state);
    const selectedRule = state.selectedBindingId ? bindings.find(b => b.id === state.selectedBindingId) : undefined;
    const usable = bindings.filter(active);
    const continuing = state.selected.length > 0 && usable.some(b => b.strokes.length > state.selected.length && prefixMatches(state.selected, b.strokes));
    const prefix = continuing ? state.selected : [];
    const stage = prefix.length;
    const displayed = usable.filter(b => prefixMatches(prefix, b.strokes) && b.strokes[stage]?.modifiers.join() === state.modifiers.join());
    const controls = element('div', 'controls');
    const profileGroup = element('div', 'profile-group');
    const profileLabel = element('label', '', 'Profile');
    profileLabel.htmlFor = 'profile';
    const profiles = element('select');
    profiles.id = 'profile';
    profiles.title = data.file || 'No custom keybindings file';
    for (const profile of data.profiles) {
      const option = element('option', '', profile.name + (profile.inherited ? ' · inherited' : ''));
      option.value = profile.id;
      option.selected = profile.id === data.selectedProfile;
      profiles.append(option);
    }
    profiles.addEventListener('change', () => api.postMessage({ type: 'profile', id: profiles.value }));
    profileGroup.append(profileLabel, profiles);
    const source = element('div', 'source-group');
    source.setAttribute('role', 'group');
    source.setAttribute('aria-label', 'Binding sources');
    for (const customOnly of [false, true]) {
      const toggle = button(customOnly ? 'Custom only' : 'All bindings', () => change({ customOnly }), 'source-toggle');
      toggle.id = customOnly ? 'source-custom' : 'source-all';
      toggle.setAttribute('aria-pressed', String(state.customOnly === customOnly));
      source.append(toggle);
    }
    const searchShell = element('div', 'search-shell');
    searchShell.addEventListener('focusout', () => {
      // Rendering replaces the input before restoring its focus. Check after
      // that restoration rather than treating it as leaving the search UI.
      queueMicrotask(() => {
        if (searchOpen && !root.querySelector('.search-shell')?.contains(document.activeElement)) closeSearchPopup();
      });
    });
    const searchLabel = element('label', 'visually-hidden', 'Find a shortcut');
    searchLabel.htmlFor = 'shortcut-search';
    const search = element('input', 'search-input');
    search.type = 'search';
    search.id = 'shortcut-search';
    search.placeholder = 'Find a shortcut…';
    search.value = state.query;
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-controls', 'search-results');
    search.setAttribute('aria-expanded', String(searchOpen && !!state.query.trim()));
    search.addEventListener('input', () => { searchOpen = true; activeResult = 0; change({ query: search.value }); });
    search.addEventListener('focus', () => { if (state.query.trim() && !searchOpen) { searchOpen = true; activeResult = 0; render(); } });
    const query = state.query.toLowerCase().trim();
    const hits = query ? bindings.filter(b => searchable(b).includes(query) || shortcutLabel(b.strokes, data.platform).toLowerCase().includes(query)).sort((a, b) => Number(b.source === 'custom') - Number(a.source === 'custom') || a.key.localeCompare(b.key) || b.order - a.order) : [];
    const visibleHits = hits.slice(0, 60);
    activeResult = Math.min(activeResult, Math.max(0, visibleHits.length - 1));
    if (searchOpen && query && visibleHits.length) search.setAttribute('aria-activedescendant', `result-${visibleHits[activeResult]!.id}`);
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); searchOpen = false; root.focus(); render();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visibleHits.length) {
        event.preventDefault(); event.stopPropagation(); searchOpen = true;
        activeResult = (activeResult + (event.key === 'ArrowDown' ? 1 : -1) + visibleHits.length) % visibleHits.length;
        render();
        root.querySelector(`#search-results [aria-selected="true"]`)?.scrollIntoView?.({ block: 'nearest' });
      } else if (event.key === 'Enter' && searchOpen && visibleHits.length) {
        event.preventDefault(); event.stopPropagation(); choose(visibleHits[activeResult]!);
      }
    });
    searchShell.append(searchLabel, search);
    if (searchOpen && query) {
      const popup = element('div', 'search-popup');
      const summary = element('p', 'result-summary', `${hits.length} matching binding${hits.length === 1 ? '' : 's'}${hits.length > 60 ? ' · showing first 60' : ''}`);
      summary.setAttribute('role', 'status');
      const list = element('div', 'result-list');
      list.id = 'search-results';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Matching shortcuts');
      for (const [index, binding] of visibleHits.entries()) {
        const hit = button('', () => choose(binding), `search-result ${binding.source === 'custom' ? 'custom-result' : ''}`);
        hit.id = `result-${binding.id}`;
        hit.tabIndex = -1;
        hit.setAttribute('role', 'option');
        hit.setAttribute('aria-selected', String(index === activeResult));
        hit.addEventListener('mousedown', event => event.preventDefault());
        hit.append(element('span', 'result-title', title(binding)), element('span', 'result-shortcut', shortcutLabel(binding.strokes, data.platform) || binding.key || 'All shortcuts'), element('span', 'result-source', `${binding.source}${binding.status === 'active' ? '' : ` · ${binding.status}`}`));
        list.append(hit);
      }
      if (!hits.length) list.append(element('p', 'empty-hint', 'No matching shortcuts. Try a command ID or another key combination.'));
      popup.append(summary, list);
      searchShell.append(popup);
    }
    controls.append(profileGroup, source, searchShell);
    root.append(controls);
    const toolbar = element('section', 'toolbar');
    toolbar.setAttribute('aria-label', 'Shortcut filters');
    const modifierGroup = element('div', 'modifier-group');
    modifierGroup.setAttribute('role', 'group');
    modifierGroup.setAttribute('aria-label', 'Modifier layer');
    for (const modifier of modifiers) {
      const toggle = button(modifierLabel(modifier, data.platform), () => change({ modifiers: modifiers.filter(m => m === modifier ? !state.modifiers.includes(m) : state.modifiers.includes(m)) }), 'modifier-toggle');
      toggle.id = `modifier-${modifier}`;
      toggle.setAttribute('aria-pressed', String(state.modifiers.includes(modifier)));
      modifierGroup.append(toggle);
    }
    const counts = new Map<string, number>();
    for (const binding of usable) {
      const stroke = binding.strokes[stage];
      if (stroke && prefixMatches(prefix, binding.strokes)) counts.set(stroke.modifiers.join(), (counts.get(stroke.modifiers.join()) ?? 0) + 1);
    }
    const layerGroup = element('div', 'layer-group');
    const layerLabel = element('label', '', 'Layers');
    layerLabel.htmlFor = 'layer-select';
    const layers = element('select');
    layers.id = 'layer-select';
    const entries = [...counts].sort(([a], [b]) => a.split(',').length - b.split(',').length || a.localeCompare(b));
    if (!counts.has(state.modifiers.join())) entries.unshift([state.modifiers.join(), 0]);
    for (const [layer, count] of entries) {
      const mods = layer ? layer.split(',') as Modifier[] : [];
      const option = element('option', '', `${mods.map(m => modifierLabel(m, data.platform)).join(' + ') || 'Base'} · ${count}`);
      option.value = layer;
      option.selected = layer === state.modifiers.join();
      layers.append(option);
    }
    layers.addEventListener('change', () => change({ modifiers: layers.value ? layers.value.split(',') as Modifier[] : [] }));
    layerGroup.append(layerLabel, layers);
    toolbar.append(modifierGroup, layerGroup);
    if (data.preview) toolbar.append(element('span', 'preview-badge', 'Unsaved preview'));
    if (loading) toolbar.append(element('span', 'muted', 'Refreshing…'));
    root.append(toolbar);
    const workarea = element('div', 'workarea');
    const keyboardCard = element('section', 'keyboard-card');
    const keyboardHeading = element('div', 'keyboard-heading');
    keyboardHeading.append(element('h2', '', state.modifiers.map(m => modifierLabel(m, data.platform)).join(' + ') || 'Base layer'), element('span', 'muted', `${displayed.length} bindings · US QWERTY`));
    keyboardCard.append(keyboardHeading);
    if (state.selected.length || selectedRule) {
      const trail = element('div', 'chord-trail');
      trail.append(element('span', 'shortcut', state.selected.length ? shortcutLabel(state.selected, data.platform) : 'Command-wide rule'));
      if (continuing) trail.append(element('span', 'muted', 'Next stroke →'));
      if (state.selected.length > 1) trail.append(button('Back one stroke', () => { const selected = state.selected.slice(0, -1); change({ selected, selectedBindingId: undefined, modifiers: selected.at(-1)?.modifiers ?? [] }); }, 'text-button'));
      trail.append(button('Clear selection', () => change({ selected: [], selectedBindingId: undefined }), 'text-button'));
      keyboardCard.append(trail);
    }
    const keyboardScroll = element('div', 'keyboard-scroll');
    const board = element('div', 'keyboard');
    const mainKeys = element('div', 'main-keys');
    const selectedStroke = state.selected.at(-1);
    const makeKey = (cap: (typeof rows)[number][number]): HTMLButtonElement => {
      const matches = cap.modifier ? [] : displayed.filter(b => b.strokes[stage]?.physical === cap.key);
      const key = button('', () => {
        if (cap.modifier) {
          const mod = cap.modifier;
          change({ modifiers: modifiers.filter(m => m === mod ? !state.modifiers.includes(m) : state.modifiers.includes(m)) });
        } else {
          const stroke: Stroke = { key: cap.key, physical: cap.key, modifiers: state.modifiers, canonical: [...state.modifiers, cap.key].join('+') };
          change({ selected: [...prefix, stroke], selectedBindingId: undefined });
        }
      }, 'keycap');
      key.id = `key-${cap.key}`;
      key.dataset.key = cap.key;
      if (cap.width) key.classList.add(`key-width-${String(cap.width).replace('.', '-')}`);
      const pressed = cap.modifier ? state.modifiers.includes(cap.modifier) : selectedStroke?.physical === cap.key && selectedStroke.modifiers.join() === state.modifiers.join();
      key.setAttribute('aria-pressed', String(pressed));
      key.classList.toggle('selected', pressed);
      key.classList.toggle('bound', matches.length > 0);
      key.classList.toggle('custom-bound', matches.some(b => b.source === 'custom'));
      const label = cap.modifier ? modifierLabel(cap.modifier, data.platform) : cap.label;
      key.append(element('span', 'key-label', label));
      if (matches.length) {
        const sorted = [...matches].sort((a, b) => b.order - a.order);
        key.append(element('span', 'key-command', title(sorted[0]!)));
        if (matches.length > 1) key.append(element('span', 'key-count', String(matches.length)));
        if (matches.some(b => b.strokes.length > stage + 1)) key.append(element('span', 'chord-dot', '↗'));
      }
      key.setAttribute('aria-label', `${label}${cap.modifier ? ' modifier' : `, ${matches.length} binding${matches.length === 1 ? '' : 's'}${matches.length ? `: ${matches.map(title).join('; ')}` : ''}`}`);
      key.title = matches.length ? matches.map(b => `${title(b)}${b.when ? ` (${b.when})` : ''}`).join('\n') : label;
      return key;
    };
    for (const caps of rows) {
      const row = element('div', 'keyboard-row');
      for (const cap of caps) row.append(makeKey(cap));
      mainKeys.append(row);
    }
    const nav = element('div', 'navigation-keys');
    nav.setAttribute('aria-label', 'Navigation and arrow keys');
    for (const cap of navigation) nav.append(makeKey(cap));
    board.append(mainKeys, nav);
    keyboardScroll.append(board);
    keyboardCard.append(keyboardScroll);
    const legend = element('div', 'keyboard-legend');
    legend.append(element('span', 'default-legend', 'Default'), element('span', 'custom-legend', 'Custom'), element('span', '', '↗ Chord'), element('span', '', 'Press a shortcut to inspect'));
    keyboardCard.append(legend);
    const details = element('aside', 'details-panel');
    details.setAttribute('aria-label', 'Selected shortcut details');
    const detailsHeader = element('div', 'details-header');
    detailsHeader.append(element('h2', '', 'Shortcut details'));
    if (state.selected.length) detailsHeader.append(element('div', 'selected-shortcut', shortcutLabel(state.selected, data.platform)));
    else if (selectedRule) detailsHeader.append(element('div', 'selected-shortcut', 'Command-wide rule'));
    const detailsBody = element('div', 'details-scroll');
    if (!state.selected.length && selectedRule) {
      detailsBody.append(element('p', 'context-note', 'This rule applies to the command across shortcuts rather than to one key combination.'), bindingDetail(selectedRule));
    } else if (!state.selected.length) detailsBody.append(element('p', 'empty-hint', 'Click a key or press a shortcut to inspect its commands and conditions. Use Find a shortcut to search by title, command ID, or binding.'));
    else {
      const selectedBindings = bindings.filter(b => b.strokes.length === state.selected.length && prefixMatches(state.selected, b.strokes)).sort((a, b) => b.order - a.order);
      const nextBindings = usable.filter(b => b.strokes.length > state.selected.length && prefixMatches(state.selected, b.strokes));
      if (selectedBindings.some(b => b.when)) detailsBody.append(element('p', 'context-note', 'Candidates are ordered by precedence. The current editor context determines which condition matches; selecting a binding does not execute commands.'));
      if (!selectedBindings.length) detailsBody.append(element('p', 'empty-hint', nextBindings.length ? 'This shortcut starts a chord. Choose a continuation.' : 'No matching bindings in this view.'));
      for (const binding of selectedBindings) detailsBody.append(bindingDetail(binding));
      if (nextBindings.length) {
        detailsBody.append(element('h3', '', 'Chord continuations'));
        for (const binding of nextBindings.slice(0, 30)) detailsBody.append(button(`${shortcutLabel(binding.strokes, data.platform)} — ${title(binding)}`, () => choose(binding), 'continuation'));
        if (nextBindings.length > 30) detailsBody.append(element('p', 'muted', 'Use search to see additional continuations.'));
      }
    }
    if (data.errors.length || data.warnings.length || !data.defaultsAvailable) {
      const notices = element('div', 'notices');
      notices.setAttribute('role', 'status');
      for (const error of data.errors) notices.append(element('p', 'notice error', error));
      for (const warning of data.warnings) notices.append(element('p', 'notice', warning));
      if (!data.defaultsAvailable) {
        const failure = element('p', 'notice error', 'Default keybindings are unavailable. Custom bindings are still shown. ');
        failure.append(button('Retry', () => api.postMessage({ type: 'refresh' }), 'text-button'));
        notices.append(failure);
      }
      detailsBody.append(notices);
    }
    const file = element('p', 'file-path', data.file || 'No custom keybindings file');
    file.title = data.file;
    detailsBody.append(file);
    const detailsKey = state.selected.map(s => s.canonical).join(' ') + (state.selectedBindingId ?? '');
    const restoredDetailsScroll = detailsKey === lastDetailsKey ? oldDetailsScroll : 0;
    lastDetailsKey = detailsKey;
    details.append(detailsHeader, detailsBody);
    workarea.append(keyboardCard, details);
    root.append(workarea);
    // A detached element has no scroll range, so restore only after mounting.
    detailsBody.scrollTop = restoredDetailsScroll;
    if (focusId) {
      const restore = document.getElementById(focusId);
      restore?.focus();
      if (restore instanceof HTMLInputElement && caret !== null) restore.setSelectionRange(caret, caret);
    }
  }
  function bindingDetail(binding: Binding): HTMLElement {
    const card = element('article', `binding-detail ${binding.source === 'custom' ? 'custom-detail' : ''}`);
    card.append(element('h3', '', title(binding)), element('span', 'binding-badge', `${binding.source} · ${binding.status}`));
    const fields = element('dl');
    const field = (label: string, value: string): void => { fields.append(element('dt', '', label), element('dd', '', value)); };
    field('Command', binding.command || '(disabled)');
    if (binding.when) field('When', binding.when);
    if (binding.args !== undefined) field('Arguments', JSON.stringify(binding.args, null, 2));
    field('Source', `${binding.source === 'custom' ? snapshot!.file : 'VS Code defaults'}:${binding.line}`);
    if (binding.reason) field('Status', binding.reason);
    card.append(fields);
    return card;
  }
  const receive = (event: MessageEvent<ToWebview>): void => {
    if (event.data?.type === 'snapshot') { snapshot = event.data.snapshot; loading = false; render(); }
    else if (event.data?.type === 'loading') { loading = true; render(); }
  };
  function closeSearchPopup(): void {
    searchOpen = false;
    root.querySelector('.search-popup')?.remove();
    root.querySelector('#shortcut-search')?.setAttribute('aria-expanded', 'false');
    root.querySelector('#shortcut-search')?.removeAttribute('aria-activedescendant');
  }
  const dismissSearch = (event: PointerEvent): void => {
    if (searchOpen && event.target instanceof Node && !root.querySelector('.search-shell')?.contains(event.target)) {
      closeSearchPopup();
    }
  };
  const unmountCapture = mountCapture(root, {
    onStroke(stroke: Stroke, continueChord: boolean) {
      searchOpen = false;
      root.focus();
      change({ selected: continueChord ? [...state.selected, stroke] : [stroke], selectedBindingId: undefined, modifiers: stroke.modifiers });
    },
    onModifiers(next: Modifier[]) { change({ modifiers: next }); },
    isChordPending() { return !!snapshot && state.selected.length > 0 && currentBindings(snapshot, state).some(b => active(b) && b.strokes.length > state.selected.length && prefixMatches(state.selected, b.strokes)); },
  });
  window.addEventListener('message', receive);
  window.addEventListener('pointerdown', dismissSearch);
  render();
  api.postMessage({ type: 'ready' });
  return () => { window.removeEventListener('message', receive); window.removeEventListener('pointerdown', dismissSearch); unmountCapture(); };
}

declare const acquireVsCodeApi: undefined | (() => WebviewApi);
if (typeof acquireVsCodeApi === 'function') {
  const root = document.getElementById('app');
  if (root) mountApp(root, acquireVsCodeApi());
}
