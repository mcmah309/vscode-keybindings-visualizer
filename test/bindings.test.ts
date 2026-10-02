import { describe, expect, it } from 'vitest';
import { mergeBindings, parseBindings, removalModeForVersion } from '../src/model/bindings';
import { parseShortcut, sameStroke, shortcutLabel } from '../src/model/keyboard';
import { whenEquivalent, whenImplies, whenIsFalse } from '../src/model/when';

const defaults = (text: string) => parseBindings(text, 'default', 'linux');
const custom = (text: string) => parseBindings(text, 'custom', 'linux');

describe('JSONC and shortcut parsing', () => {
  it('accepts comments, BOM, trailing commas and preserves args/conditions/order', () => {
    const rules = custom('\uFEFF[\n// comment\n{"key":"control+shift+w", "command":"runCommands", "args":{"commands":["a","b"]},"when":"editorTextFocus"},\n]');
    expect(rules[0]).toMatchObject({ source: 'custom', line: 3, args: { commands: ['a', 'b'] }, when: 'editorTextFocus' });
    expect(rules[0]!.strokes[0]!.canonical).toBe('ctrl+shift+w');
  });
  it('reports invalid JSON and invalid structures instead of silently losing rules', () => {
    expect(() => custom('[{"key":')).toThrow(/line/);
    expect(() => custom('{}')).toThrow(/array/);
    expect(() => custom('[{"key":"ctrl+w","command":3}]')).toThrow(/command string/);
  });
  it('uses command token locations rather than strings in comments and arguments', () => {
    const rules = custom(`[
      // "second" is a comment, not the next rule
      {"key":"a","command":"first","args":{"command":"second"}},
      {"key":"b",
       "command":"second"},
      {"key":"c","command":"third","command":"final"}
    ]`);
    expect(rules.map(rule => rule.line)).toEqual([3, 5, 6]);
    expect(rules[2]!.command).toBe('final');
  });
  it('handles chords, punctuation, scan codes, modifier order and unmapped keys', () => {
    expect(parseShortcut('shift+control+k ctrl+[KeyC]').map(s => s.canonical)).toEqual(['ctrl+shift+k', 'ctrl+[keyc]']);
    expect(parseShortcut('alt+;')[0]!.physical).toBe(';');
    expect(parseShortcut('ctrl++')[0]!.key).toBe('+');
    expect(parseShortcut('ctrl+oem_102')[0]!.physical).toBeUndefined();
    expect(sameStroke(parseShortcut('ctrl+c')[0]!, parseShortcut('ctrl+[KeyC]')[0]!)).toBe(true);
    expect(shortcutLabel(parseShortcut('cmd+alt+w'), 'darwin')).toBe('Option+Cmd+W');
  });
  it('selects platform overrides in contributed defaults', () => {
    expect(parseBindings('[{"key":"ctrl+w","mac":"cmd+w","command":"close"}]', 'default', 'darwin')[0]!.key).toBe('cmd+w');
  });
});

describe('merging defaults and user rules', () => {
  it('preserves context-dependent alternatives and descending precedence', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+w","command":"close"}]'), custom('[{"key":"ctrl+w","command":"custom.close","when":"editorTextFocus"}]'), 'linux');
    expect(bindings.map(b => b.status)).toEqual(['active', 'active']);
    expect(bindings.map(b => b.order)).toEqual([0, 1]);
  });
  it('marks an unconditional custom override and disables with empty command', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+w","command":"close","when":"editorTextFocus"}]'), custom('[{"key":"ctrl+w","command":""}]'), 'linux');
    expect(bindings.map(b => b.status)).toEqual(['superseded', 'active']);
    expect(bindings[1]!.label).toBe('Disabled shortcut');
  });
  it('removes only matching defaults, keeps user reassignments', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+w","command":"close"},{"key":"alt+w","command":"close"}]'), custom('[{"key":"ctrl+w","command":"-close"},{"key":"ctrl+w","command":"close"}]'), 'linux');
    expect(bindings.map(b => b.status)).toEqual(['removed', 'active', 'removal', 'active']);
  });
  it('supports command-wide removals and removal prefixes for chords', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+k ctrl+c","command":"comment"}]'), custom('[{"key":"ctrl+k","command":"-comment"}]'), 'linux');
    expect(bindings[0]!.status).toBe('removed');
    expect(mergeBindings(defaults('[{"key":"ctrl+k ctrl+c","command":"comment"}]'), custom('[{"command":"-comment"}]'), 'linux')[0]!.status).toBe('removed');
  });
  it('removes narrower default when conditions but retains unrelated ones', () => {
    const bindings = mergeBindings(defaults('[{"key":"tab","command":"next","when":"snippetMode && editorTextFocus"},{"key":"tab","command":"next","when":"terminalFocus"}]'), custom('[{"key":"tab","command":"-next","when":"snippetMode"}]'), 'linux');
    expect(bindings.map(b => b.status)).toEqual(['removed', 'active', 'removal']);
  });
  it('matches legacy removal conditions without applying newer implication behavior', () => {
    const rules = defaults('[{"key":"tab","command":"next","when":"snippetMode && editorTextFocus"}]');
    const broad = custom('[{"key":"tab","command":"-next","when":"snippetMode"}]');
    expect(mergeBindings(rules, broad, 'linux', 'equivalent')[0]!.status).toBe('active');
    expect(mergeBindings(rules, broad, 'linux', 'implication')[0]!.status).toBe('removed');
    const equivalent = custom('[{"key":"tab","command":"-next","when":"editorTextFocus && snippetMode"}]');
    expect(mergeBindings(rules, equivalent, 'linux', 'equivalent')[0]!.status).toBe('removed');
    expect(removalModeForVersion('1.96.0')).toBe('equivalent');
    expect(removalModeForVersion('1.115.0')).toBe('equivalent');
    expect(removalModeForVersion('1.116.0')).toBe('implication');
    expect(removalModeForVersion('1.140.0-insider')).toBe('implication');
  });
  it('does not remove an unconditional default using a condition that substitutes to true', () => {
    const bindings = mergeBindings(defaults('[{"key":"a","command":"run"}]'), custom('[{"key":"a","command":"-run","when":"isLinux"}]'), 'linux');
    expect(bindings[0]!.status).toBe('active');
  });
  it('does not suppress chords with different second strokes', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+k ctrl+c","command":"comment"}]'), custom('[{"key":"ctrl+k ctrl+u","command":"uncomment"}]'), 'linux');
    expect(bindings.every(b => b.status === 'active')).toBe(true);
  });
  it('marks prefix conflicts only when their conditions prove shadowing', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+k ctrl+c","command":"comment"}]'), custom('[{"key":"ctrl+k","command":"single"}]'), 'linux');
    expect(bindings[0]!.status).toBe('superseded');
  });
  it('preserves reachable chord alternatives after a shorter rule is superseded', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+k ctrl+c","command":"comment"}]'), custom('[{"key":"ctrl+k","command":"single"},{"key":"ctrl+k ctrl+u","command":"uncomment"}]'), 'linux');
    expect(bindings.map(binding => binding.status)).toEqual(['active', 'superseded', 'active']);
  });
  it('groups physical and logical equivalents while retaining nearest-rule reasons', () => {
    const bindings = mergeBindings(defaults('[{"key":"ctrl+k","command":"first"}]'), custom('[{"key":"ctrl+[KeyK]","command":"second","when":"focused"},{"key":"ctrl+k","command":"third","when":"other"}]'), 'linux');
    expect(bindings.every(binding => binding.status === 'active')).toBe(true);
    const shadowed = mergeBindings(defaults('[{"key":"ctrl+k","command":"first","when":"focused"}]'), custom('[{"key":"ctrl+[KeyK]","command":"second","when":"focused"},{"key":"ctrl+k","command":"third","when":"other"}]'), 'linux');
    expect(shadowed[0]!.status).toBe('superseded');
    expect(shadowed[0]!.reason).toContain(`line ${shadowed[1]!.line}`);
  });
  it('keeps inactive platform rules inspectable', () => {
    const bindings = mergeBindings(defaults('[{"key":"cmd+w","command":"close","when":"isMac"}]'), [], 'linux');
    expect(bindings[0]!.status).toBe('inactive');
  });
});

describe('conservative when reasoning', () => {
  it('proves conjunctions, disjunctions, parentheses and boolean negation', () => {
    expect(whenImplies('a && (b || c)', 'a', 'linux')).toBe(true);
    expect(whenImplies('a', 'a || b', 'linux')).toBe(true);
    expect(whenImplies('a || b', 'a', 'linux')).toBe(false);
    expect(whenImplies('!a && !b', '!(a || b)', 'linux')).toBe(true);
    expect(whenIsFalse('a && !a', 'linux')).toBe(true);
  });
  it('normalizes legacy expression ordering and constants without distributing groups', () => {
    expect(whenEquivalent('a && b && isLinux', 'b && (a)', 'linux')).toBe(true);
    expect(whenEquivalent('a && (b || c)', '(a && b) || (a && c)', 'linux')).toBe(false);
  });
  it('does not split regexes or quoted values at boolean symbols', () => {
    expect(whenImplies('resource =~ /a||b/ && editorTextFocus', 'resource =~ /a||b/', 'linux')).toBe(true);
    expect(whenImplies("lang == 'a && b'", "lang == 'a'", 'linux')).toBe(false);
    expect(whenImplies("lang == 'a == b'", "lang == 'a==b'", 'linux')).toBe(false);
    expect(whenImplies('resource =~ /[/]a == b/', 'resource =~ /[/]a==b/', 'linux')).toBe(false);
    expect(whenImplies('resource =~ /[a/&&]/ && editorTextFocus', 'editorTextFocus', 'linux')).toBe(true);
    expect(whenImplies('(resource =~ /[a/)||]/ && editorTextFocus)', 'editorTextFocus', 'linux')).toBe(true);
    expect(whenImplies(String.raw`resource =~ /a\/b||c/ && editorTextFocus`, String.raw`resource =~ /a\/b||c/`, 'linux')).toBe(true);
  });
  it('substitutes desktop platform constants without guessing context values', () => {
    expect(whenIsFalse('isWindows && editorTextFocus', 'linux')).toBe(true);
    expect(whenImplies('editorTextFocus && isLinux', 'editorTextFocus', 'linux')).toBe(true);
    expect(whenIsFalse('editorTextFocus', 'linux')).toBe(false);
  });
});
