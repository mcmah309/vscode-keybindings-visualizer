import { getNodeValue, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parseShortcut, prefixMatches } from './keyboard';
import type { Binding, Platform, Source } from './types';
import { whenEquivalent, whenImplies, whenIsFalse } from './when';

export type RemovalMode = 'implication' | 'equivalent';

export function removalModeForVersion(version: string): RemovalMode {
  const [major = 1, minor = 0] = version.split('.').map(value => Number.parseInt(value, 10));
  return major > 1 || (major === 1 && minor >= 116) ? 'implication' : 'equivalent';
}

export function commandLabel(command: string): string {
  if (!command) return 'Disabled shortcut';
  const removal = command.startsWith('-');
  const id = removal ? command.slice(1) : command;
  const last = id.split('.').pop() ?? id;
  const title = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return `${removal ? 'Remove ' : ''}${title[0]?.toUpperCase() ?? ''}${title.slice(1)}`;
}

export function parseBindings(text: string, source: Source, platform: Platform, labels: Record<string, string> = {}): Binding[] {
  const errors: ParseError[] = [];
  const tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  const data: unknown = tree ? getNodeValue(tree) : undefined;
  if (errors.length) {
    const error = errors[0]!;
    const line = text.slice(0, error.offset).split('\n').length;
    throw new Error(`${printParseErrorCode(error.error)} at line ${line}`);
  }
  if (!Array.isArray(data)) throw new Error('Expected a JSON array of keybindings');
  return data.map((raw: unknown, order: number) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Binding ${order + 1} must be an object`);
    const value = raw as Record<string, unknown>;
    if (typeof value.command !== 'string') throw new Error(`Binding ${order + 1} needs a command string`);
    const platformKey = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
    const rawKey = source === 'default' && typeof value[platformKey] === 'string' ? value[platformKey] : value.key;
    if (rawKey !== undefined && typeof rawKey !== 'string') throw new Error(`Binding ${order + 1} needs a key string`);
    if (!rawKey && !value.command.startsWith('-')) throw new Error(`Binding ${order + 1} has no shortcut`);
    if (value.when !== undefined && typeof value.when !== 'string') throw new Error(`Binding ${order + 1} has an invalid when condition`);
    const key = (rawKey as string | undefined) ?? '';
    const objectNode = tree?.children?.[order];
    const commandNode = objectNode?.children?.filter(property => property.children?.[0]?.value === 'command').at(-1)?.children?.[1];
    const line = text.slice(0, commandNode?.offset ?? objectNode?.offset ?? 0).split('\n').length;
    const commandId = value.command.replace(/^-/, '');
    const label = labels[commandId];
    return {
      id: `${source}:${order}`, key, strokes: parseShortcut(key), command: value.command,
      label: label ? `${value.command.startsWith('-') ? 'Remove ' : ''}${label}` : commandLabel(value.command),
      when: value.when as string | undefined, args: value.args, source, order, line,
      status: value.command.startsWith('-') ? 'removal' : 'active',
    };
  });
}

/** Apply removals and proven shadowing while retaining every rule for inspection. */
export function mergeBindings(defaults: Binding[], custom: Binding[], platform: Platform, removalMode: RemovalMode = 'implication'): Binding[] {
  const bindings = [...defaults, ...custom].map((b, order): Binding => ({
    ...b, order, status: b.command.startsWith('-') ? 'removal' : 'active', reason: undefined,
  }));
  const removals = custom.filter(b => b.command.startsWith('-'));
  for (const binding of bindings) {
    if (binding.status === 'removal') {
      binding.reason = 'Removes matching default rules; custom rules are not removed.';
      continue;
    }
    if (binding.source === 'default') {
      const removal = removals.find(r => r.command.slice(1) === binding.command
        && prefixMatches(r.strokes, binding.strokes)
        && (!r.when?.trim() || r.when.trim() === 'true'
          || (!!binding.when?.trim() && (removalMode === 'implication' ? whenImplies(binding.when, r.when, platform) : whenEquivalent(binding.when, r.when, platform)))));
      if (removal) {
        binding.status = 'removed';
        binding.reason = `Removed by custom rule on line ${removal.line}.`;
        continue;
      }
    }
    if (whenIsFalse(binding.when, platform)) {
      binding.status = 'inactive';
      binding.reason = 'This condition is always false on this desktop platform.';
    }
  }
  // Later bindings win, including a shorter sequence or a longer chord sharing the prefix.
  // Only hide alternatives if boolean implication proves they cannot win.
  const candidatesByFirstStroke = new Map<string, Binding[]>();
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!;
    if (binding.status !== 'active') continue;
    const first = binding.strokes[0];
    const signature = first ? `${first.modifiers.join(',')}|${first.physical ?? first.key}` : '';
    const candidates = candidatesByFirstStroke.get(signature) ?? [];
    let winner: Binding | undefined;
    // Candidates were added in reverse rule order. Check the nearest later rule first.
    for (let j = candidates.length - 1; j >= 0; j--) {
      const candidate = candidates[j]!;
      if ((prefixMatches(binding.strokes, candidate.strokes) || prefixMatches(candidate.strokes, binding.strokes))
        && whenImplies(binding.when, candidate.when, platform)) { winner = candidate; break; }
    }
    if (winner) {
      binding.status = 'superseded';
      binding.reason = `Superseded by ${winner.source === 'custom' ? 'custom' : 'default'} rule on line ${winner.line}.`;
    } else {
      candidates.push(binding);
      candidatesByFirstStroke.set(signature, candidates);
    }
  }
  return bindings;
}
