import * as vscode from 'vscode';
import { BindingStore, type HostIO } from './host/store';
import { removalModeForVersion } from './model/bindings';
import type { Platform, Snapshot, ToHost, ToWebview } from './model/types';
import { randomBytes } from 'node:crypto';

export interface VisualizerAPI {
  open(): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  getSnapshot(): Snapshot;
}

export function activate(context: vscode.ExtensionContext): VisualizerAPI {
  // globalStorageUri is <user-data>/User/globalStorage/<extension-id>, including portable/custom user-data directories.
  const storageParent = vscode.Uri.joinPath(context.globalStorageUri, '..', '..');
  const profileMarker = storageParent.path.lastIndexOf('/profiles/');
  const user = profileMarker >= 0 ? storageParent.with({ path: storageParent.path.slice(0, profileMarker) }) : storageParent;
  const platform: Platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const observed = new Map<string, string | undefined>();
  const readResource = async (uri: string): Promise<string | undefined> => {
    try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))).toString('utf8'); }
    catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return undefined;
      throw error;
    }
  };
  const io: HostIO = {
    read: async uri => {
      const text = await readResource(uri);
      observed.set(uri, text);
      return text;
    },
    directories: async uri => (await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri))).filter(([, type]) => (type & vscode.FileType.Directory) !== 0).map(([name]) => name),
    join: (uri, ...parts) => vscode.Uri.joinPath(vscode.Uri.parse(uri), ...parts).toString(),
    document: uri => {
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri);
      return document ? { text: document.getText(), dirty: document.isDirty } : undefined;
    },
    labels: commandLabels,
  };
  const store = new BindingStore(io, user.toString(), platform, removalModeForVersion(vscode.version));
  let panel: vscode.WebviewPanel | undefined;
  let panelListeners: vscode.Disposable[] = [];
  let fileWatchers: vscode.Disposable[] = [];
  let watchedFile = '';
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let disposed = false;
  let refreshRevision = 0;

  const configuredFile = (): string | undefined => {
    const value = vscode.workspace.getConfiguration('keybindingsVisualizer').get<string>('keybindingsFile', '').trim();
    const isUri = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
    return value ? (isUri ? vscode.Uri.parse(value) : vscode.Uri.file(value)).toString() : undefined;
  };
  const post = (message: ToWebview) => { if (panel) void panel.webview.postMessage(message); };
  const clearWatchers = () => { fileWatchers.forEach(w => w.dispose()); fileWatchers = []; watchedFile = ''; };
  const watch = (file: string) => {
    if (!panel || watchedFile === file) return;
    clearWatchers();
    watchedFile = file;
    const uri = vscode.Uri.parse(file);
    const parent = vscode.Uri.joinPath(uri, '..');
    const filename = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    // Watching the parent catches replacement saves and first-time file creation.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, filename));
    fileWatchers.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    const metadataWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(user, '{globalStorage/storage.json,profiles/*/keybindings.json,profiles/*/profile.json}'));
    fileWatchers.push(metadataWatcher, metadataWatcher.onDidChange(schedule), metadataWatcher.onDidCreate(schedule), metadataWatcher.onDidDelete(schedule));
  };
  const refresh = async (): Promise<Snapshot> => {
    const revision = ++refreshRevision;
    post({ type: 'loading' });
    const snapshot = await store.refresh(configuredFile());
    if (!disposed && revision === refreshRevision) { watch(snapshot.file); post({ type: 'snapshot', snapshot }); }
    return snapshot;
  };
  function schedule(): void {
    if (!panel || disposed) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadTimer = undefined; void refresh().catch(reportError); }, 200);
  }
  async function poll(): Promise<void> {
    if (!panel?.visible || polling || disposed) return;
    const file = store.getSnapshot().file;
    if (!observed.has(file)) return;
    polling = true;
    try {
      const text = await readResource(file);
      if (text !== observed.get(file)) {
        observed.set(file, text);
        schedule();
      }
    } catch { schedule(); }
    finally { polling = false; }
  }
  const reportError = (error: unknown) => { void vscode.window.showErrorMessage(`Keybindings Visualizer: ${error instanceof Error ? error.message : String(error)}`); };
  const receive = async (message: ToHost) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' || message.type === 'refresh') await refresh();
    else if (message.type === 'profile' && typeof message.id === 'string') {
      if (store.getSnapshot().profiles.some(profile => profile.id === message.id)) { store.selectProfile(message.id); await refresh(); }
    } else if (message.type === 'chooseFile') {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: 'Visualize keybindings', filters: { 'JSON keybindings': ['json', 'jsonc'] } });
      if (files?.[0]) { store.chooseFile(files[0].toString()); await refresh(); }
    }
  };
  const open = async () => {
    if (panel) { panel.reveal(); return refresh(); }
    panel = vscode.window.createWebviewPanel('keybindingsVisualizer', 'Keybindings Visualizer', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] });
    panel.webview.html = html(panel.webview, context.extensionUri);
    // File providers offer no watcher-ready signal. A cheap content check recovers
    // early writes or missed notifications without rebuilding an unchanged view.
    pollTimer = setInterval(() => { void poll(); }, 2000);
    panelListeners = [
      panel.webview.onDidReceiveMessage(message => { void receive(message as ToHost).catch(reportError); }),
      panel.onDidChangeViewState(event => { if (event.webviewPanel.visible) schedule(); }),
      panel.onDidDispose(() => {
        ++refreshRevision;
        panel = undefined;
        clearWatchers();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
        if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = undefined; }
        const listeners = panelListeners; panelListeners = []; listeners.forEach(listener => listener.dispose());
      }),
    ];
    return refresh();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('keybindingsVisualizer.open', open),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === store.getSnapshot().file) schedule(); }),
    vscode.workspace.onDidSaveTextDocument(document => { if (document.uri.toString() === store.getSnapshot().file) schedule(); }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.toString() === store.getSnapshot().file) schedule(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('keybindingsVisualizer')) schedule(); }),
    vscode.extensions.onDidChange(schedule),
    { dispose: () => { disposed = true; if (reloadTimer) clearTimeout(reloadTimer); if (pollTimer) clearInterval(pollTimer); clearWatchers(); panel?.dispose(); } },
  );
  return { open, refresh, getSnapshot: () => store.getSnapshot() };
}

async function commandLabels(): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const extension of vscode.extensions.all) {
    const commands = extension.packageJSON?.contributes?.commands;
    if (!Array.isArray(commands)) continue;
    for (const command of commands) {
      if (typeof command?.command !== 'string') continue;
      const title = typeof command.title === 'string' ? command.title : command.title?.value;
      const category = typeof command.category === 'string' ? command.category : command.category?.value;
      if (typeof title === 'string' && !/^%.*%$/.test(title)) labels[command.command] = category && !/^%.*%$/.test(category) ? `${category}: ${title}` : title;
    }
  }
  // The public API exposes command IDs but no titles. Keep internal title discovery
  // best-effort and independent of binding discovery; some VS Code versions omit it.
  try {
    const all = await vscode.commands.executeCommand<unknown>('_getAllCommands');
    const values = Array.isArray(all) ? all : all && typeof all === 'object' ? Object.entries(all).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) })) : [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const command = value as { id?: string; command?: string; label?: unknown; title?: unknown; category?: unknown };
      const id = command.id ?? command.command;
      const title = typeof command.title === 'string' ? command.title : typeof command.label === 'string' ? command.label : command.title && typeof command.title === 'object' && 'value' in command.title ? (command.title as { value: unknown }).value : undefined;
      if (id && typeof title === 'string' && !/^%.*%$/.test(title)) labels[id] = typeof command.category === 'string' && !/^%.*%$/.test(command.category) ? `${command.category}: ${title}` : title;
    }
  } catch { /* Contribution labels and command IDs remain available. */ }
  return labels;
}

function html(webview: vscode.Webview, extension: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', 'style.css'));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><title>Keybindings Visualizer</title><link rel="stylesheet" href="${style}"></head><body><main id="app" aria-label="Keybindings Visualizer"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
