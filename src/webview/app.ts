import { modifiers, modifierLabel, navigation, prefixMatches, rows, shortcutLabel } from '../model/keyboard';
import type { Binding, Modifier, Snapshot, Stroke, ToHost, ToWebview } from '../model/types';

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
  function change(update: Partial<ViewState>): void {
    state = { ...state, ...update };
    api.setState(state);
    render();
  }
  function choose(binding: Binding): void {
    change({ selected: binding.strokes, selectedBindingId: binding.id, modifiers: binding.strokes.at(-1)?.modifiers ?? [] });
  }
  function render(): void {
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusId = focused?.id;
    const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null;
    root.replaceChildren();
    const header = element('header', 'page-header');
    const heading = element('div');
    heading.append(element('div', 'eyebrow', 'YOUR SHORTCUTS, AT A GLANCE'), element('h1', '', 'Keybindings Visualizer'), element('p', 'subtitle', 'Explore a layer. Select a key. See what is bound.'));
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
    const profileBar = element('div', 'profile-bar');
    const profileLabel = element('label', '', 'Profile');
    profileLabel.htmlFor = 'profile';
    const profiles = element('select');
    profiles.id = 'profile';
    for (const profile of data.profiles) {
      const option = element('option', '', profile.name + (profile.inherited ? ' · inherited shortcuts' : ''));
      option.value = profile.id;
      option.selected = profile.id === data.selectedProfile;
      profiles.append(option);
    }
    profiles.addEventListener('change', () => api.postMessage({ type: 'profile', id: profiles.value }));
    const file = element('span', 'file-path', data.file || 'No custom keybindings file');
    file.title = data.file;
    profileBar.append(profileLabel, profiles, file);
    if (data.preview) profileBar.append(element('span', 'preview-badge', 'Unsaved preview'));
    if (loading) profileBar.append(element('span', 'muted', 'Refreshing…'));
    root.append(profileBar);
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
      root.append(notices);
    }
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
    const source = element('div', 'source-group');
    source.setAttribute('role', 'group');
    source.setAttribute('aria-label', 'Binding sources');
    for (const customOnly of [false, true]) {
      const toggle = button(customOnly ? 'Custom only' : 'All bindings', () => change({ customOnly }), 'source-toggle');
      toggle.id = customOnly ? 'source-custom' : 'source-all';
      toggle.setAttribute('aria-pressed', String(state.customOnly === customOnly));
      source.append(toggle);
    }
    toolbar.append(modifierGroup, source);
    root.append(toolbar);
    const layers = element('div', 'layer-shortcuts');
    layers.append(element('span', 'muted', 'Populated layers'));
    const counts = new Map<string, number>();
    for (const binding of usable) {
      const stroke = binding.strokes[stage];
      if (stroke && prefixMatches(prefix, binding.strokes)) counts.set(stroke.modifiers.join(), (counts.get(stroke.modifiers.join()) ?? 0) + 1);
    }
    for (const [layer, count] of [...counts].sort(([a], [b]) => a.split(',').length - b.split(',').length || a.localeCompare(b))) {
      const mods = layer ? layer.split(',') as Modifier[] : [];
      const toggle = button(`${mods.map(m => modifierLabel(m, data.platform)).join(' + ') || 'Base'} · ${count}`, () => change({ modifiers: mods }), 'layer-chip');
      toggle.id = `layer-${layer || 'base'}`;
      toggle.setAttribute('aria-pressed', String(layer === state.modifiers.join()));
      layers.append(toggle);
    }
    root.append(layers);
    const keyboardCard = element('section', 'keyboard-card');
    const keyboardHeading = element('div', 'keyboard-heading');
    keyboardHeading.append(element('h2', '', state.modifiers.map(m => modifierLabel(m, data.platform)).join(' + ') || 'Base layer'), element('span', 'muted', `${displayed.length} binding${displayed.length === 1 ? '' : 's'} · US QWERTY`));
    keyboardCard.append(keyboardHeading);
    if (state.selected.length || selectedRule) {
      const trail = element('div', 'chord-trail');
      trail.append(element('span', 'shortcut', state.selected.length ? shortcutLabel(state.selected, data.platform) : 'Command-wide rule'));
      if (continuing) trail.append(element('span', 'muted', 'Choose the next stroke below'));
      if (state.selected.length > 1) trail.append(button('Back one stroke', () => { const selected = state.selected.slice(0, -1); change({ selected, selectedBindingId: undefined, modifiers: selected.at(-1)?.modifiers ?? [] }); }, 'text-button'));
      trail.append(button('Clear selection', () => change({ selected: [], selectedBindingId: undefined }), 'text-button'));
      keyboardCard.append(trail);
    }
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
    keyboardCard.append(board);
    const legend = element('div', 'keyboard-legend');
    legend.append(element('span', 'default-legend', 'Default binding'), element('span', 'custom-legend', 'Custom binding'), element('span', '', '↗ Chord prefix'), element('span', '', 'Numbers indicate multiple candidates'));
    keyboardCard.append(legend);
    root.append(keyboardCard);
    const lower = element('div', 'lower-grid');
    const details = element('section', 'details-panel');
    details.setAttribute('aria-label', 'Selected shortcut details');
    details.append(element('h2', '', 'Shortcut details'));
    if (!state.selected.length && selectedRule) {
      details.append(element('div', 'selected-shortcut', 'Command-wide rule'), element('p', 'context-note', 'This rule applies to the command across shortcuts rather than to one key combination.'), bindingDetail(selectedRule));
    } else if (!state.selected.length) details.append(element('p', 'empty-hint', 'Select a key or a search result to inspect its commands and conditions.'));
    else {
      details.append(element('div', 'selected-shortcut', shortcutLabel(state.selected, data.platform)));
      const selectedBindings = bindings.filter(b => b.strokes.length === state.selected.length && prefixMatches(state.selected, b.strokes)).sort((a, b) => b.order - a.order);
      const nextBindings = usable.filter(b => b.strokes.length > state.selected.length && prefixMatches(state.selected, b.strokes));
      if (selectedBindings.some(b => b.when)) details.append(element('p', 'context-note', 'VS Code checks candidates from bottom to top in the source rules. The current editor context determines which condition matches; this view does not execute commands.'));
      if (!selectedBindings.length) details.append(element('p', 'empty-hint', nextBindings.length ? 'This shortcut starts a chord. Choose a continuation.' : 'No matching bindings in this view.'));
      for (const binding of selectedBindings) details.append(bindingDetail(binding));
      if (nextBindings.length) {
        details.append(element('h3', '', 'Chord continuations'));
        for (const binding of nextBindings.slice(0, 30)) {
          const next = button(`${shortcutLabel(binding.strokes, data.platform)} — ${title(binding)}`, () => choose(binding), 'continuation');
          details.append(next);
        }
        if (nextBindings.length > 30) details.append(element('p', 'muted', 'Use search to see additional continuations.'));
      }
    }
    const results = element('section', 'results-panel');
    const searchLabel = element('label', 'search-label', 'Find a shortcut');
    searchLabel.htmlFor = 'shortcut-search';
    const search = element('input', 'search-input');
    search.type = 'search';
    search.id = 'shortcut-search';
    search.placeholder = 'Command, title, or ctrl+w…';
    search.value = state.query;
    search.addEventListener('input', () => change({ query: search.value }));
    results.append(searchLabel, search);
    const query = state.query.toLowerCase().trim();
    const hits = bindings.filter(b => !query || searchable(b).includes(query) || shortcutLabel(b.strokes, data.platform).toLowerCase().includes(query)).sort((a, b) => Number(b.source === 'custom') - Number(a.source === 'custom') || a.key.localeCompare(b.key) || b.order - a.order);
    const resultSummary = element('p', 'result-summary', `${hits.length} ${state.customOnly ? 'custom ' : ''}binding${hits.length === 1 ? '' : 's'}${hits.length > 100 ? ' · showing first 100, narrow your search' : ''}`);
    resultSummary.setAttribute('role', 'status');
    results.append(resultSummary);
    const resultList = element('div', 'result-list');
    for (const binding of hits.slice(0, 100)) {
      const hit = button('', () => choose(binding), `search-result ${binding.source === 'custom' ? 'custom-result' : ''}`);
      hit.id = `result-${binding.id}`;
      hit.append(element('span', 'result-title', title(binding)), element('span', 'result-shortcut', shortcutLabel(binding.strokes, data.platform) || binding.key || 'All shortcuts'), element('span', 'result-source', `${binding.source}${binding.status === 'active' ? '' : ` · ${binding.status}`}`));
      resultList.append(hit);
    }
    if (!hits.length) resultList.append(element('p', 'empty-hint', 'No matching shortcuts. Try a command ID or another key combination.'));
    results.append(resultList);
    lower.append(details, results);
    root.append(lower);
    const footer = element('footer', 'page-footer', 'Custom bindings are highlighted in amber. Conditions are shown as candidates, in precedence order.');
    root.append(footer);
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
  window.addEventListener('message', receive);
  render();
  api.postMessage({ type: 'ready' });
  return () => window.removeEventListener('message', receive);
}

declare const acquireVsCodeApi: undefined | (() => WebviewApi);
if (typeof acquireVsCodeApi === 'function') {
  const root = document.getElementById('app');
  if (root) mountApp(root, acquireVsCodeApi());
}
