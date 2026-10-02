import type { Modifier, Platform, Stroke } from './types';

export const modifiers: Modifier[] = ['ctrl', 'alt', 'shift', 'cmd'];
const aliases: Record<string, string> = {
  control: 'ctrl', option: 'alt', meta: 'cmd', command: 'cmd', win: 'cmd', super: 'cmd',
  escape: 'escape', esc: 'escape', return: 'enter', arrowup: 'up', arrowdown: 'down',
  arrowleft: 'left', arrowright: 'right', spacebar: 'space', ' ': 'space',
  del: 'delete', ins: 'insert', pgup: 'pageup', pgdn: 'pagedown',
  plus: '=', minus: '-', left: 'left', right: 'right',
};
const scanCodes: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Space: 'space', Enter: 'enter', Escape: 'escape', Tab: 'tab', Backspace: 'backspace',
  CapsLock: 'capslock', Insert: 'insert', Delete: 'delete', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down',
  ArrowLeft: 'left', ArrowRight: 'right', NumLock: 'numlock',
};
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') scanCodes[`Key${c}`] = c.toLowerCase();
for (let i = 0; i <= 9; i++) scanCodes[`Digit${i}`] = String(i);
for (let i = 1; i <= 12; i++) scanCodes[`F${i}`] = `f${i}`;
const scansByLower = Object.fromEntries(Object.entries(scanCodes).map(([k, v]) => [k.toLowerCase(), v]));

export interface KeyCap { key: string; label: string; width?: number; modifier?: Modifier }
export const rows: KeyCap[][] = [
  ['escape', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)].map(key => ({ key, label: key === 'escape' ? 'Esc' : key.toUpperCase() })),
  [...'`1234567890-='.split('').map(key => ({ key, label: key })), { key: 'backspace', label: 'Backspace', width: 2 }],
  [{ key: 'tab', label: 'Tab', width: 1.5 }, ...'qwertyuiop[]\\'.split('').map(key => ({ key, label: key.toUpperCase() }))],
  [{ key: 'capslock', label: 'Caps', width: 1.8 }, ..."asdfghjkl;'".split('').map(key => ({ key, label: key.toUpperCase() })), { key: 'enter', label: 'Enter', width: 2.2 }],
  [{ key: 'shift-left', label: 'Shift', width: 2.3, modifier: 'shift' }, ...'zxcvbnm,./'.split('').map(key => ({ key, label: key.toUpperCase() })), { key: 'shift-right', label: 'Shift', width: 2.7, modifier: 'shift' }],
  [
    { key: 'ctrl-left', label: 'Ctrl', width: 1.5, modifier: 'ctrl' },
    { key: 'cmd-left', label: 'Super', width: 1.3, modifier: 'cmd' },
    { key: 'alt-left', label: 'Alt', width: 1.3, modifier: 'alt' },
    { key: 'space', label: 'Space', width: 6.3 },
    { key: 'alt-right', label: 'Alt', width: 1.3, modifier: 'alt' },
    { key: 'cmd-right', label: 'Super', width: 1.3, modifier: 'cmd' },
    { key: 'ctrl-right', label: 'Ctrl', width: 1.5, modifier: 'ctrl' },
  ],
];
export const navigation: KeyCap[] = ['insert', 'home', 'pageup', 'delete', 'end', 'pagedown', 'left', 'down', 'up', 'right'].map(key => ({ key, label: ({ insert: 'Ins', pageup: 'PgUp', pagedown: 'PgDn', delete: 'Del', left: '←', down: '↓', up: '↑', right: '→' } as Record<string, string>)[key] ?? key[0]!.toUpperCase() + key.slice(1) }));
const physicalKeys = new Set([...rows.flat(), ...navigation].map(k => k.key));

export function parseShortcut(shortcut: string): Stroke[] {
  if (!shortcut.trim()) return [];
  return shortcut.trim().split(/\s+/).map(raw => {
    let remaining = raw.toLowerCase();
    const found = new Set<Modifier>();
    // Consume only modifier prefixes: punctuation keys such as '+' must survive splitting.
    while (true) {
      const match = /^([a-z]+)\+/.exec(remaining);
      if (!match) break;
      const value = aliases[match[1]!] ?? match[1]!;
      if (!modifiers.includes(value as Modifier)) break;
      found.add(value as Modifier);
      remaining = remaining.slice(match[0].length);
    }
    const key = aliases[remaining] ?? remaining;
    const ordered = modifiers.filter(m => found.has(m));
    const physical = key.startsWith('[') && key.endsWith(']')
      ? scansByLower[key.slice(1, -1)]
      : physicalKeys.has(key) ? key : undefined;
    return { modifiers: ordered, key, canonical: [...ordered, key].join('+'), physical };
  });
}

export function modifierLabel(modifier: Modifier, platform: Platform): string {
  if (modifier === 'cmd') return platform === 'darwin' ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super';
  if (modifier === 'alt' && platform === 'darwin') return 'Option';
  return modifier[0]!.toUpperCase() + modifier.slice(1);
}

export function shortcutLabel(strokes: Stroke[], platform: Platform): string {
  return strokes.map(s => [...s.modifiers.map(m => modifierLabel(m, platform)),
    s.key.startsWith('[') ? s.key : s.key === 'escape' ? 'Esc' : s.key.length === 1 ? s.key.toUpperCase() : s.key[0]!.toUpperCase() + s.key.slice(1)].join('+')).join(' → ');
}

export function sameStroke(a: Stroke, b: Stroke): boolean {
  return a.canonical === b.canonical || (!!a.physical && a.physical === b.physical && a.modifiers.join() === b.modifiers.join());
}

export function prefixMatches(prefix: Stroke[], sequence: Stroke[]): boolean {
  return prefix.length <= sequence.length && prefix.every((s, i) => sameStroke(s, sequence[i]!));
}
