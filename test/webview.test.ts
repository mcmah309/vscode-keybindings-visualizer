// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp, type WebviewApi } from '../src/webview/app';
import { parseShortcut } from '../src/model/keyboard';
import type { Binding, Snapshot } from '../src/model/types';

function binding(key: string, command: string, source: 'custom' | 'default' = 'default', extra: Partial<Binding> = {}): Binding {
  return { id: command, key, strokes: parseShortcut(key), command, label: command, source, order: 0, line: 2, status: 'active', ...extra };
}
const base: Snapshot = {
  bindings: [
    binding('ctrl+w', 'Close editor'),
    binding('ctrl+w', 'Custom close', 'custom', { order: 3, when: 'editorTextFocus', args: { text: '<script>alert(1)</script>' } }),
    binding('alt+w', 'Switch window'),
    binding('ctrl+k ctrl+c', 'Comment line', 'custom'),
    binding('ctrl+k ctrl+u', 'Uncomment line'),
    binding('ctrl+[Numpad0]', 'Unmapped shortcut', 'custom'),
    binding('ctrl+x', '-removed.command', 'custom', { status: 'removal' }),
    binding('', '-global.command', 'custom', { status: 'removal', reason: 'Removes every default shortcut for this command' }),
  ],
  profiles: [{ id: 'default', name: 'Default', uri: '/user/keybindings.json' }, { id: 'work', name: 'Work', uri: '/user/profiles/work/keybindings.json' }],
  selectedProfile: 'default', file: '/user/keybindings.json', platform: 'linux', errors: [], warnings: [], preview: false, defaultsAvailable: true, updatedAt: '',
};
let root: HTMLElement;
let api: WebviewApi;
let cleanup: () => void;
const send = (snapshot: Snapshot = base): void => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot } })); };
const click = (selector: string): void => { const button = root.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); button!.click(); };
const query = (value: string): void => { const input = root.querySelector<HTMLInputElement>('#shortcut-search')!; input.focus(); input.value = value; input.dispatchEvent(new Event('input')); };
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  root = document.getElementById('app')!;
  api = { postMessage: vi.fn(), setState: vi.fn(), getState: () => undefined };
  cleanup = mountApp(root, api);
  send();
});
afterEach(() => cleanup());

describe('interactive keyboard', () => {
  it('independently toggles modifier layers and marks custom keys', () => {
    click('#modifier-ctrl');
    expect(root.querySelector('[data-key="w"]')?.classList.contains('custom-bound')).toBe(true);
    expect(root.querySelector('[data-key="w"] .key-count')?.textContent).toBe('2');
    click('#modifier-alt');
    expect(root.querySelector('#modifier-ctrl')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('#modifier-alt')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-key="w"]')?.classList.contains('bound')).toBe(false);
    click('#modifier-ctrl');
    expect(root.querySelector('[data-key="w"] .key-command')?.textContent).toBe('Switch window');
  });
  it('shows candidates in precedence order and highlights selected keys', () => {
    click('#modifier-ctrl');
    click('[data-key="w"]');
    expect(root.querySelector('[data-key="w"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-key="ctrl-left"]')?.getAttribute('aria-pressed')).toBe('true');
    const titles = Array.from(root.querySelectorAll('.binding-detail h3')).map(el => el.textContent);
    expect(titles).toEqual(['Custom close', 'Close editor']);
    expect(root.querySelector('.context-note')?.textContent).toContain('current editor context');
    expect(root.querySelector('.details-panel')?.textContent).toContain('editorTextFocus');
    expect(root.querySelector('.details-panel script')).toBeNull();
    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });
  it('supports chord continuations and selecting the full sequence', () => {
    click('#modifier-ctrl');
    click('[data-key="k"]');
    expect(root.querySelector('.chord-trail')?.textContent).toContain('Next stroke');
    expect(root.querySelector('[data-key="c"] .key-command')?.textContent).toBe('Comment line');
    expect(root.querySelector('[data-key="w"]')?.classList.contains('bound')).toBe(false);
    click('[data-key="c"]');
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+K → Ctrl+C');
    expect(root.querySelector('.binding-detail h3')?.textContent).toBe('Comment line');
    const back = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Back one stroke');
    back!.click();
    expect(root.querySelector('[data-key="u"] .key-command')?.textContent).toBe('Uncomment line');
  });
  it('filters custom bindings but keeps removal rules searchable and off the keyboard', () => {
    click('#source-custom');
    click('#modifier-ctrl');
    expect(root.querySelector('[data-key="w"] .key-count')).toBeNull();
    expect(root.querySelector('[data-key="x"]')?.classList.contains('bound')).toBe(false);
    query('removed.command');
    expect(root.querySelector('.result-source')?.textContent).toBe('custom · removal');
    click('.search-result');
    expect(root.querySelector('.binding-badge')?.textContent).toBe('custom · removal');
  });
  it('inspects and persists command-wide removal rules without selecting keyboard keys', () => {
    query('global.command');
    expect(root.querySelector('.result-shortcut')?.textContent).toBe('All shortcuts');
    click('.search-result');
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Command-wide rule');
    expect(root.querySelector('.binding-badge')?.textContent).toBe('custom · removal');
    expect(root.querySelector('.details-panel')?.textContent).toContain('-global.command');
    expect(root.querySelector('.details-panel')?.textContent).toContain('Removes every default shortcut');
    expect(root.querySelectorAll('.keycap.selected')).toHaveLength(0);
    const saved = vi.mocked(api.setState).mock.calls.at(-1)![0];
    cleanup();
    api.getState = () => saved;
    cleanup = mountApp(root, api);
    send();
    expect(root.querySelector('.details-panel')?.textContent).toContain('-global.command');
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Clear selection')!.click();
    expect(root.querySelector('.binding-detail')).toBeNull();
  });
  it('uses stylesheet width classes with no inline styles', () => {
    const space = root.querySelector('[data-key="space"]')!;
    expect(space.classList.contains('key-width-6-3')).toBe(true);
    expect(space.hasAttribute('style')).toBe(false);
    expect(root.querySelector('[data-key="backspace"]')?.classList.contains('key-width-2')).toBe(true);
  });
  it('searches labels and shortcuts and activates the layer for results', () => {
    query('alt+w');
    expect(root.querySelectorAll('.search-result')).toHaveLength(1);
    click('.search-result');
    expect(root.querySelector('#modifier-alt')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-key="w"]')?.getAttribute('aria-pressed')).toBe('true');
    query('Unmapped');
    click('.search-result');
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+[numpad0]');
    expect(root.querySelector('.binding-detail h3')?.textContent).toBe('Unmapped shortcut');
  });
  it('preserves search focus, modifier, filter, and selection across snapshots', () => {
    click('#source-custom');
    query('Custom close');
    click('.search-result');
    query('Custom');
    send({ ...base, preview: true, bindings: [...base.bindings, binding('ctrl+s', 'Custom save', 'custom')] });
    expect(root.querySelector<HTMLInputElement>('#shortcut-search')?.value).toBe('Custom');
    expect(document.activeElement?.id).toBe('shortcut-search');
    expect(root.querySelector('#modifier-ctrl')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('#source-custom')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-key="w"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.preview-badge')?.textContent).toBe('Unsaved preview');
    expect(api.setState).toHaveBeenCalled();
  });
  it('restores saved view state on mount', () => {
    cleanup();
    api.getState = () => ({ modifiers: ['ctrl'], query: 'Custom', customOnly: true, selected: parseShortcut('ctrl+w') });
    cleanup = mountApp(root, api);
    send();
    expect(root.querySelector<HTMLInputElement>('#shortcut-search')?.value).toBe('Custom');
    expect(root.querySelector('[data-key="w"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('offers labelled accessible controls and keeps keyboard focus after selection', () => {
    expect(root.querySelector('label[for="profile"]')).not.toBeNull();
    expect(root.querySelector('label[for="shortcut-search"]')).not.toBeNull();
    const key = root.querySelector<HTMLButtonElement>('[data-key="w"]')!;
    expect(key.getAttribute('aria-label')).toContain('W');
    key.focus();
    key.click();
    expect(document.activeElement?.id).toBe('key-w');
  });
});

describe('compact search and sidebar', () => {
  it('keeps results hidden until searching and dismisses them after selection', () => {
    expect(root.querySelector('.search-popup')).toBeNull();
    expect(root.querySelector('.results-panel')).toBeNull();
    query('close');
    expect(root.querySelector('#shortcut-search')?.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelectorAll('.search-result')).toHaveLength(2);
    click('.search-result');
    expect(root.querySelector('.search-popup')).toBeNull();
    expect(document.activeElement).toBe(root);
    expect(root.querySelector<HTMLInputElement>('#shortcut-search')?.value).toBe('close');
    expect(root.querySelector('.workarea > .details-panel .binding-detail')).not.toBeNull();
    expect(root.querySelector('.details-panel > .details-scroll')).not.toBeNull();
  });
  it('provides combobox navigation, Enter selection, and Escape dismissal', () => {
    query('close');
    let input = root.querySelector<HTMLInputElement>('#shortcut-search')!;
    expect(input.getAttribute('role')).toBe('combobox');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input = root.querySelector<HTMLInputElement>('#shortcut-search')!;
    const activeId = input.getAttribute('aria-activedescendant')!;
    expect(document.getElementById(activeId)?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(activeId)?.textContent).toContain('Close editor');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+W');
    expect(root.querySelector('.search-popup')).toBeNull();
    query('close');
    root.querySelector<HTMLInputElement>('#shortcut-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(root.querySelector('.search-popup')).toBeNull();
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+W');
  });
  it('dismisses search on outside pointer action and keeps sidebar scroll across snapshots', () => {
    click('#modifier-ctrl');
    click('[data-key="w"]');
    const details = root.querySelector<HTMLElement>('.details-scroll')!;
    details.scrollTop = 75;
    query('close');
    root.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    root.focus();
    expect(root.querySelector('.search-popup')).toBeNull();
    send();
    expect(root.querySelector('.details-scroll')?.scrollTop).toBe(75);
    expect(root.querySelector('.search-popup')).toBeNull();
  });
  it('closes search after focus leaves while preserving popup through snapshot focus restoration', async () => {
    query('close');
    send();
    await Promise.resolve();
    expect(document.activeElement?.id).toBe('shortcut-search');
    expect(root.querySelector('.search-popup')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('#modifier-ctrl')!.focus();
    await Promise.resolve();
    expect(root.querySelector('.search-popup')).toBeNull();
    expect(root.querySelector('#shortcut-search')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('#shortcut-search')?.hasAttribute('aria-activedescendant')).toBe(false);
    expect(root.querySelector<HTMLInputElement>('#shortcut-search')?.value).toBe('close');
    root.querySelector<HTMLInputElement>('#shortcut-search')!.focus();
    expect(root.querySelector('.search-popup')).not.toBeNull();
  });
  it('wires physical shortcut selection and chord continuation into the compact UI', () => {
    root.focus();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+W');
    expect(root.querySelector('[data-key="w"]')?.getAttribute('aria-pressed')).toBe('true');
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('.selected-shortcut')?.textContent).toBe('Ctrl+K → Ctrl+C');
    expect(root.querySelector('.binding-detail h3')?.textContent).toBe('Comment line');
  });
});

describe('host messaging and errors', () => {
  it('sends ready, profile, choose-file, and refresh without command execution', () => {
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    const select = root.querySelector<HTMLSelectElement>('#profile')!;
    select.value = 'work';
    select.dispatchEvent(new Event('change'));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'profile', id: 'work' });
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Choose file…')!.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'chooseFile' });
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Refresh')!.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'refresh' });
  });
  it('shows defaults failures, retry, and preserved custom bindings', () => {
    send({ ...base, defaultsAvailable: false, errors: ['Cannot read defaults'], warnings: ['Previewing another profile'] });
    expect(root.querySelector('.notices')?.textContent).toContain('Cannot read defaults');
    expect(root.querySelector('.notices')?.textContent).toContain('Custom bindings are still shown');
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Retry')!.click();
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'refresh' });
    query('Custom close');
    expect(root.querySelector('.result-title')?.textContent).toBe('Custom close');
  });
});
