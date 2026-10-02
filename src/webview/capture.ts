import { modifiers, parseShortcut } from '../model/keyboard';
import type { Modifier, Stroke } from '../model/types';

export interface CaptureHandlers {
  onStroke(stroke: Stroke, continueChord: boolean): void;
  onModifiers(modifiers: Modifier[]): void;
  isChordPending(): boolean;
}

function heldModifiers(event: KeyboardEvent): Modifier[] {
  return modifiers.filter(modifier => ({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, cmd: event.metaKey })[modifier]);
}

/** Normalize shifted punctuation to its US key, leaving Shift as its own layer. */
export function eventStroke(event: KeyboardEvent): Stroke | undefined {
  const physical = event.code ? parseShortcut(`[${event.code}]`)[0]?.physical : undefined;
  const key = physical ?? ({ ' ': 'space', '+': '=', Esc: 'escape', OS: 'cmd' } as Record<string, string>)[event.key] ?? event.key.toLowerCase();
  if (!key || ['unidentified', 'dead', 'process'].includes(key)) return undefined;
  const held = heldModifiers(event);
  const parsed = parseShortcut([...held, key].join('+'))[0];
  if (parsed && physical) parsed.physical = physical;
  return parsed;
}

function editingKey(event: KeyboardEvent): boolean {
  // Keep typing and the combobox/select's navigation usable. Other combinations
  // (including Ctrl+W/P) still select a shortcut even when the search input has focus.
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return true;
  const key = event.key.toLowerCase();
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'].includes(key)) return true;
  return !event.altKey && (event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x', 'z', 'y'].includes(key);
}

export function mountCapture(root: HTMLElement, handlers: CaptureHandlers): () => void {
  let lastStrokeAt = 0;
  const captured = new Set<string>();
  const keydown = (event: KeyboardEvent): void => {
    if (!root.isConnected || event.isComposing || event.key === 'Process') return;
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (target && target !== document.body && !root.contains(target)) return;
    const editable = target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
    if (editable && editingKey(event)) { lastStrokeAt = 0; return; }
    // Enter/Space activate focused UI buttons; with root focus they inspect those keys.
    if (target instanceof Element && target.closest('button') && ['Enter', ' '].includes(event.key)
      && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) return;
    // Plain Tab keeps keyboard navigation accessible; modified shortcuts are inspected.
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    const modifierOnly = ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(event.key);
    const stroke = modifierOnly ? undefined : eventStroke(event);
    if (!modifierOnly && !stroke) return;
    // VS Code's webview bridge forwards keydown in the window's bubble phase and
    // does not check defaultPrevented. Stopping propagation is essential here.
    event.preventDefault();
    event.stopImmediatePropagation();
    captured.add(event.code || event.key);
    if (event.repeat) return;
    if (modifierOnly) { handlers.onModifiers(heldModifiers(event)); return; }
    const now = Date.now();
    const continueChord = lastStrokeAt > 0 && now - lastStrokeAt < 5000 && handlers.isChordPending();
    lastStrokeAt = now;
    handlers.onStroke(stroke!, continueChord);
  };
  const keyup = (event: KeyboardEvent): void => {
    if (!captured.delete(event.code || event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Let local input/combobox handlers and browser editing run, but stop the
  // workbench bridge from handling those events afterward as editor shortcuts.
  const stopBridge = (event: KeyboardEvent): void => { event.stopPropagation(); };
  const blur = () => { lastStrokeAt = 0; captured.clear(); };
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('keyup', keyup, true);
  root.addEventListener('keydown', stopBridge);
  root.addEventListener('keyup', stopBridge);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('keyup', keyup, true);
    root.removeEventListener('keydown', stopBridge);
    root.removeEventListener('keyup', stopBridge);
    window.removeEventListener('blur', blur);
  };
}
