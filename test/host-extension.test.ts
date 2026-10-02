import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';

const mocks = vi.hoisted(() => {
  class Uri {
    constructor(readonly value: string) {}
    static parse(value: string) { return new Uri(value); }
    static file(path: string) { return new Uri(`file://${path}`); }
    static joinPath(uri: Uri, ...parts: string[]) {
      const url = new URL(uri.value);
      const segments = [...url.pathname.split('/'), ...parts.flatMap(part => part.split('/'))];
      const normalized: string[] = [];
      for (const part of segments) { if (part === '..') normalized.pop(); else if (part && part !== '.') normalized.push(part); }
      url.pathname = '/' + normalized.join('/');
      return new Uri(url.toString());
    }
    get path() { return new URL(this.value).pathname; }
    with(changes: { path: string }) { const url = new URL(this.value); url.pathname = changes.path; return new Uri(url.toString()); }
    toString() { return this.value; }
  }
  const disposable = () => ({ dispose: vi.fn() });
  const event = () => {
    let handler: (...args: any[]) => void = () => {};
    return { subscribe: vi.fn((next: (...args: any[]) => void) => { handler = next; return disposable(); }), fire: (...args: any[]) => handler(...args) };
  };
  const watchers: { pattern: any; dispose: ReturnType<typeof vi.fn>; change: ReturnType<typeof event>; create: ReturnType<typeof event>; delete: ReturnType<typeof event> }[] = [];
  const message = event();
  const close = event();
  const visible = event();
  const textChanged = event();
  const configuration = event();
  const files = new Map<string, string>();
  const api = {
    version: '1.140.0',
    Uri, FileType: { Directory: 2 }, FileSystemError: class extends Error { code = 'FileNotFound'; }, ViewColumn: { Active: -1 },
    RelativePattern: class { constructor(readonly base: Uri, readonly pattern: string) {} },
    workspace: {
      fs: { readFile: vi.fn(async (uri: Uri) => { const text = files.get(uri.toString()); if (text === undefined) throw new api.FileSystemError(); return Buffer.from(text); }), readDirectory: vi.fn(async () => []) },
      textDocuments: [] as any[],
      getConfiguration: vi.fn(() => ({ get: () => '' })),
      createFileSystemWatcher: vi.fn((pattern: any) => { const change = event(); const create = event(); const deleted = event(); const watcher = { pattern, change, create, delete: deleted, dispose: vi.fn(), onDidChange: change.subscribe, onDidCreate: create.subscribe, onDidDelete: deleted.subscribe }; watchers.push(watcher); return watcher; }),
      onDidChangeTextDocument: textChanged.subscribe, onDidSaveTextDocument: event().subscribe, onDidCloseTextDocument: event().subscribe, onDidChangeConfiguration: configuration.subscribe,
    },
    window: { createWebviewPanel: vi.fn(() => ({ visible: true, webview: { html: '', cspSource: 'https://resource', asWebviewUri: (uri: Uri) => uri, postMessage: vi.fn(async () => true), onDidReceiveMessage: message.subscribe }, reveal: vi.fn(), onDidDispose: close.subscribe, onDidChangeViewState: visible.subscribe, dispose: vi.fn(() => close.fire()) })), showOpenDialog: vi.fn(async () => [] as Uri[]), showErrorMessage: vi.fn() },
    commands: { registerCommand: vi.fn(() => disposable()), executeCommand: vi.fn(async (_command: string) => []) },
    extensions: { all: [], onDidChange: event().subscribe },
  };
  return { api, Uri, files, watchers, message, close, visible, textChanged, configuration };
});
vi.mock('vscode', () => mocks.api);
import { activate } from '../src/extension';

describe('extension host lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.files.clear(); mocks.watchers.length = 0;
    mocks.files.set('vscode://defaultsettings/keybindings.json', '[{"key":"ctrl+w","command":"close"}]');
    mocks.api.workspace.fs.readFile.mockClear();
    mocks.api.commands.executeCommand.mockClear();
    mocks.api.window.createWebviewPanel.mockClear();
  });
  afterEach(() => vi.useRealTimers());
  const context = () => ({ globalStorageUri: mocks.Uri.parse('file:///data/User/globalStorage/visualizer'), extensionUri: mocks.Uri.parse('file:///extension'), subscriptions: [] }) as unknown as VSCode.ExtensionContext;

  it('loads through filesystem APIs, uses a singleton panel, and opens no JSON editors', async () => {
    const api = activate(context());
    expect((await api.open()).defaultsAvailable).toBe(true);
    await api.open();
    expect(mocks.api.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mocks.api.commands.executeCommand.mock.calls.every(args => args[0] === '_getAllCommands')).toBe(true);
    expect(api.getSnapshot().file).toBe('file:///data/User/keybindings.json');
    mocks.close.fire();
  });

  it('debounces parent-directory events and disposes watchers when closed', async () => {
    const api = activate(context());
    await api.open();
    const watcher = mocks.watchers[0]!;
    expect(watcher.pattern.base.toString()).toBe('file:///data/User');
    expect(watcher.pattern.pattern).toBe('keybindings.json');
    mocks.files.set('file:///data/User/keybindings.json', '[{"key":"ctrl+x","command":"new"}]');
    watcher.change.fire(); watcher.create.fire(); watcher.delete.fire();
    await vi.advanceTimersByTimeAsync(199);
    expect(api.getSnapshot().bindings.some(binding => binding.command === 'new')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.getSnapshot().bindings.some(binding => binding.command === 'new')).toBe(true);
    mocks.close.fire();
    expect(watcher.dispose).toHaveBeenCalledOnce();
    const reads = mocks.api.workspace.fs.readFile.mock.calls.length;
    watcher.change.fire();
    await vi.advanceTimersByTimeAsync(201);
    expect(mocks.api.workspace.fs.readFile.mock.calls).toHaveLength(reads);
  });

  it('derives the default User directory when activated from a named profile', async () => {
    const ctx = context();
    (ctx as any).globalStorageUri = mocks.Uri.parse('file:///data/User/profiles/profile-id/globalStorage/visualizer');
    const api = activate(ctx);
    await api.open();
    expect(api.getSnapshot().file).toBe('file:///data/User/keybindings.json');
    mocks.close.fire();
  });

  it('recovers missed notifications without refreshing unchanged content', async () => {
    const api = activate(context());
    await api.open();
    const updated = api.getSnapshot().updatedAt;
    await vi.advanceTimersByTimeAsync(2200);
    expect(api.getSnapshot().updatedAt).toBe(updated);
    mocks.files.set('file:///data/User/keybindings.json', '[{"key":"ctrl+x","command":"missed.change"}]');
    await vi.advanceTimersByTimeAsync(2200);
    expect(api.getSnapshot().bindings.some(b => b.command === 'missed.change')).toBe(true);
    mocks.close.fire();
    const reads = mocks.api.workspace.fs.readFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(mocks.api.workspace.fs.readFile.mock.calls).toHaveLength(reads);
  });

  it('rebinds the watcher when another file is chosen', async () => {
    const api = activate(context());
    await api.open();
    const original = mocks.watchers[0]!;
    mocks.api.window.showOpenDialog.mockResolvedValueOnce([mocks.Uri.parse('file:///elsewhere/custom.json')]);
    mocks.message.fire({ type: 'chooseFile' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getSnapshot().file).toBe('file:///elsewhere/custom.json');
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(mocks.watchers[2]!.pattern.base.toString()).toBe('file:///elsewhere');
    expect(mocks.watchers[2]!.pattern.pattern).toBe('custom.json');
    mocks.close.fire();
  });
});
