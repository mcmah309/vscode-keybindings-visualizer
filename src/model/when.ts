import type { Platform } from './types';

/** Conservative boolean reasoning; never consults or invents the live editor context. */
type Dnf = Set<string>[];
const limit = 128;
function platformConstants(platform: Platform): Record<string, boolean> {
  return { true: true, false: false, isMac: platform === 'darwin', isWindows: platform === 'win32', isLinux: platform === 'linux', isWeb: false, isMacNative: platform === 'darwin' };
}

/** Shared lexical state for quoted values and regexes, including / inside [classes]. */
class LiteralScanner {
  private quote = '';
  private escaped = false;
  private characterClass = false;

  /** True only for a character outside a string or regular expression. */
  outside(c: string): boolean {
    if (this.quote) {
      if (this.escaped) this.escaped = false;
      else if (c === '\\') this.escaped = true;
      else if (this.quote === '/' && c === '[') this.characterClass = true;
      else if (this.quote === '/' && c === ']') this.characterClass = false;
      else if (c === this.quote && !this.characterClass) this.quote = '';
      return false;
    }
    if (c === '"' || c === "'" || c === '/') {
      this.quote = c;
      this.characterClass = false;
      return false;
    }
    return true;
  }
}

function canonicalAtom(text: string): string {
  // Normalize spaces outside strings/regexes, preserving their contents.
  const scanner = new LiteralScanner();
  let out = '';
  for (const c of text.trim()) {
    if (!scanner.outside(c)) out += c;
    else if (/\s/.test(c)) {
      if (!out.endsWith(' ') && !/[=!<>~]$/.test(out)) out += ' ';
    } else if (/[=!<>~]/.test(c)) {
      out = out.trimEnd() + c;
    } else out += c;
  }
  return out.trim();
}

/** Find operators outside quoted values, regular expressions, and parentheses. */
function splitTopLevel(text: string, operator: '&&' | '||'): string[] {
  let depth = 0, start = 0;
  const scanner = new LiteralScanner();
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!scanner.outside(c)) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (!depth && text.slice(i, i + 2) === operator) {
      pieces.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  pieces.push(text.slice(start));
  return pieces;
}

function unwrap(text: string): string {
  // Only strip enclosing parentheses, not '(a) || (b)'.
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0, wraps = true;
    const scanner = new LiteralScanner();
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (!scanner.outside(c)) continue;
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (!depth && i < text.length - 1) { wraps = false; break; }
    }
    if (!wraps || depth) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function conjunction(left: Dnf, right: Dnf): Dnf {
  if (left.length * right.length > limit) throw new Error('Expression too complex');
  const output: Dnf = [];
  for (const a of left) for (const b of right) {
    const both = new Set([...a, ...b]);
    if (![...both].some(s => both.has(s.startsWith('!') ? s.slice(1) : `!${s}`))) output.push(both);
  }
  return output;
}

function dnf(raw: string, platform: Platform, negate = false, depth = 0): Dnf {
  if (depth > 40) throw new Error('Expression too deep');
  const text = unwrap(raw.trim());
  const ors = splitTopLevel(text, '||');
  if (ors.length > 1) {
    const result = negate
      ? ors.reduce<Dnf>((acc, p) => conjunction(acc, dnf(p, platform, true, depth + 1)), [new Set()])
      : ors.flatMap(p => dnf(p, platform, false, depth + 1));
    if (result.length > limit) throw new Error('Expression too complex');
    return result;
  }
  const ands = splitTopLevel(text, '&&');
  if (ands.length > 1) {
    const result = negate
      ? ands.flatMap(p => dnf(p, platform, true, depth + 1))
      : ands.reduce<Dnf>((acc, p) => conjunction(acc, dnf(p, platform, false, depth + 1)), [new Set()]);
    if (result.length > limit) throw new Error('Expression too complex');
    return result;
  }
  if (text.startsWith('!') && !text.startsWith('!=')) return dnf(text.slice(1), platform, !negate, depth + 1);
  const constants = platformConstants(platform);
  if (text === '' || Object.hasOwn(constants, text)) {
    const value = text === '' ? true : constants[text]!;
    return value !== negate ? [new Set()] : [];
  }
  const atom = canonicalAtom(text);
  return [new Set([negate ? `!${atom}` : atom])];
}

export function whenImplies(left: string | undefined, right: string | undefined, platform: Platform): boolean {
  if (!right || right.trim() === 'true') return true;
  if (left?.trim() === right.trim()) return true;
  try {
    const a = dnf(left ?? '', platform), b = dnf(right, platform);
    return a.every(clause => b.some(target => [...target].every(atom => clause.has(atom))));
  } catch {
    // Unknown implication must retain both rules rather than hide a potentially active binding.
    return false;
  }
}

export function whenIsFalse(when: string | undefined, platform: Platform): boolean {
  try { return dnf(when ?? '', platform).length === 0; } catch { return false; }
}

type Condition = boolean | { op: 'atom'; value: string; negated: boolean } | { op: 'and' | 'or'; children: Condition[] };
function fingerprint(condition: Condition): string {
  return typeof condition === 'boolean' ? String(condition) : condition.op === 'atom'
    ? JSON.stringify(['atom', condition.value, condition.negated])
    : JSON.stringify([condition.op, condition.children.map(fingerprint).sort()]);
}

function normalizeCondition(raw: string, platform: Platform, negate = false, depth = 0): Condition {
  if (depth > 40) throw new Error('Expression too deep');
  const text = unwrap(raw.trim());
  const ors = splitTopLevel(text, '||');
  const ands = ors.length > 1 ? [] : splitTopLevel(text, '&&');
  const pieces = ors.length > 1 ? ors : ands.length > 1 ? ands : undefined;
  if (pieces) {
    const originalOp = ors.length > 1 ? 'or' : 'and';
    const op = negate ? originalOp === 'or' ? 'and' : 'or' : originalOp;
    const children: Condition[] = [];
    for (const piece of pieces) {
      const value = normalizeCondition(piece, platform, negate, depth + 1);
      if (typeof value === 'boolean') {
        if (value === (op === 'or')) return value;
      } else if (value.op === op) children.push(...value.children);
      else children.push(value);
    }
    const unique = [...new Map(children.map(value => [fingerprint(value), value])).values()];
    for (const value of unique) {
      if (typeof value !== 'boolean' && value.op === 'atom'
        && unique.some(other => typeof other !== 'boolean' && other.op === 'atom' && other.value === value.value && other.negated !== value.negated)) return op === 'or';
    }
    return unique.length === 0 ? op === 'and' : unique.length === 1 ? unique[0]! : { op, children: unique };
  }
  if (text.startsWith('!') && !text.startsWith('!=')) return normalizeCondition(text.slice(1), platform, !negate, depth + 1);
  const constants = platformConstants(platform);
  if (text === '' || Object.hasOwn(constants, text)) return (text === '' ? true : constants[text]!) !== negate;
  return { op: 'atom', value: canonicalAtom(text), negated: negate };
}

/** Older VS Code versions compare normalized expressions, without implication/distribution. */
export function whenEquivalent(left: string | undefined, right: string | undefined, platform: Platform): boolean {
  try { return fingerprint(normalizeCondition(left ?? '', platform)) === fingerprint(normalizeCondition(right ?? '', platform)); }
  catch { return left?.trim() === right?.trim(); }
}
