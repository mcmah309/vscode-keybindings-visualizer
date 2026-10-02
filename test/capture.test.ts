// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventStroke, mountCapture, type CaptureHandlers } from '../src/webview/capture';

let root: HTMLElement;
let handlers: CaptureHandlers;
let cleanup: () => void;
function press(key: string, options: KeyboardEventInit = {}, target: Element = root): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  document.body.innerHTML = '<main id="app" tabindex="0"><input type="search" id="search"><select id="profile"></select></main>';
  root = document.getElementById('app')!;
  root.focus();
  handlers = { onStroke: vi.fn(), onModifiers: vi.fn(), isChordPending: () => false };
  cleanup = mountCapture(root, handlers);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('shortcut capture', () => {
  it.each([
    ['w', 'KeyW', { ctrlKey: true }, 'ctrl+w'],
    ['P', 'KeyP', { ctrlKey: true, shiftKey: true }, 'ctrl+shift+p'],
    ['p', 'KeyP', { metaKey: true }, 'cmd+p'],
    ['F5', 'F5', {}, 'f5'],
    ['?', 'Slash', { ctrlKey: true, shiftKey: true }, 'ctrl+shift+/'],
    ['ArrowLeft', 'ArrowLeft', { altKey: true }, 'alt+left'],
  ])('captures %s before the VS Code bridge receives it', (key, code, options, canonical) => {
    const bridge = vi.fn();
    window.addEventListener('keydown', bridge);
    try {
      expect(press(key, { code, ...options }).defaultPrevented).toBe(true);
      expect(handlers.onStroke).toHaveBeenCalledWith(expect.objectContaining({ canonical }), false);
      expect(bridge).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', bridge); }
  });

  it('tracks chord continuation with a five-second timeout and resets on blur', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    handlers.isChordPending = () => true;
    press('k', { code: 'KeyK', ctrlKey: true });
    press('c', { code: 'KeyC', ctrlKey: true });
    expect(handlers.onStroke).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'c' }), true);
    vi.advanceTimersByTime(5001);
    press('k', { code: 'KeyK', ctrlKey: true });
    expect(handlers.onStroke).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'k' }), false);
    window.dispatchEvent(new Event('blur'));
    press('c', { code: 'KeyC', ctrlKey: true });
    expect(handlers.onStroke).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'c' }), false);
  });

  it('allows search typing, editing, IME and accessible Tab navigation', () => {
    const input = document.getElementById('search')!;
    for (const key of ['a', 'Enter', 'Escape', 'ArrowDown']) expect(press(key, {}, input).defaultPrevented).toBe(false);
    expect(press('a', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press('Process', { isComposing: true }).defaultPrevented).toBe(false);
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(handlers.onStroke).not.toHaveBeenCalled();
    expect(press('w', { ctrlKey: true, code: 'KeyW' }, input).defaultPrevented).toBe(true);
  });

  it('updates held modifier layers and consumes repeats without changing selection', () => {
    press('Control', { code: 'ControlLeft', ctrlKey: true });
    expect(handlers.onModifiers).toHaveBeenCalledWith(['ctrl']);
    expect(press('w', { ctrlKey: true, code: 'KeyW', repeat: true }).defaultPrevented).toBe(true);
    expect(handlers.onStroke).not.toHaveBeenCalled();
  });

  it('does not intercept events outside the visualizer or after disposal', () => {
    const outside = document.createElement('button'); document.body.append(outside);
    expect(press('w', { ctrlKey: true }, outside).defaultPrevented).toBe(false);
    cleanup();
    expect(press('w', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('allows local combobox handlers while blocking native forwarding and captured key releases', () => {
    const bridge = vi.fn();
    const local = vi.fn();
    const input = document.getElementById('search')!;
    input.addEventListener('keydown', local);
    window.addEventListener('keydown', bridge);
    window.addEventListener('keyup', bridge);
    try {
      press('ArrowDown', {}, input);
      expect(local).toHaveBeenCalledOnce();
      expect(bridge).not.toHaveBeenCalled();
      press('w', { code: 'KeyW', ctrlKey: true });
      const release = new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
      root.dispatchEvent(release);
      expect(release.defaultPrevented).toBe(true);
      expect(bridge).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', bridge); window.removeEventListener('keyup', bridge); }
  });

  it('normalizes shifted symbols and physical scan-code positions', () => {
    expect(eventStroke(new KeyboardEvent('keydown', { code: 'Digit1', key: '!', shiftKey: true }))?.canonical).toBe('shift+1');
    expect(eventStroke(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))?.key).toBe('space');
    expect(eventStroke(new KeyboardEvent('keydown', { key: 'Dead' }))).toBeUndefined();
  });
});
