import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type CDPSession } from 'playwright-core';
import type { VisualizerAPI } from '../src/extension';

async function eventually(assertion: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const contents = (command: string) => JSON.stringify([{ key: 'ctrl+alt+w', command }]);

/** Electron's webview targets aren't always exposed as Playwright frames. */
async function attachWebview(browserSession: CDPSession, targetId: string) {
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: false });
  let nextId = 0;
  const contexts = new Set<number>();
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault) contexts.add(message.params.context.id);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    }
  };
  browserSession.on('Target.receivedMessageFromTarget', receive);
  const send = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
    await browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    return response;
  };
  await send('Runtime.enable');
  return {
    send,
    contexts,
    evaluate: async (expression: string, contextId: number): Promise<any> => {
      const response = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    },
    close: async () => {
      browserSession.off('Target.receivedMessageFromTarget', receive);
      await browserSession.send('Target.detachFromTarget', { sessionId });
    },
  };
}

export async function run(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'vkv-integration-'));
  const file = join(directory, 'keybindings.json');
  const config = vscode.workspace.getConfiguration('keybindingsVisualizer');
  const previous = config.get('keybindingsFile');
  const cleanup: (() => PromiseLike<unknown>)[] = [];
  try {
    await writeFile(file, contents('vkv.test.first'));
    await config.update('keybindingsFile', file, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<VisualizerAPI>('keybindings-visualizer.vscode-keybindings-visualizer');
    assert.ok(extension, 'Development extension must be installed');
    const api = await extension.activate();
    const tabsBefore = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
    await vscode.commands.executeCommand('keybindingsVisualizer.open');
    // The webview ready handshake can supersede the initial load.
    await eventually(() => api.getSnapshot().updatedAt !== '', 'initial binding load');
    let snapshot = api.getSnapshot();
    assert.ok(snapshot.defaultsAvailable, snapshot.errors.join('\n'));
    assert.ok(snapshot.bindings.filter(b => b.source === 'default').length > 100, 'Full defaults must be present');
    assert.ok(snapshot.bindings.some(b => b.command === 'vkv.test.first'));
    const newTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !tabsBefore.has(tab));
    assert.equal(newTabs.length, 1, 'Only the visualizer tab should open');
    assert.ok(newTabs[0]!.input instanceof vscode.TabInputWebview);
    console.log(`PASS: ${snapshot.bindings.filter(b => b.source === 'default').length} defaults loaded without JSON tabs`);

    await writeFile(file, contents('vkv.test.changed'));
    await eventually(() => api.getSnapshot().bindings.some(b => b.command === 'vkv.test.changed'), 'external file change');
    await writeFile(join(directory, 'replacement.json'), contents('vkv.test.replaced'));
    await rename(join(directory, 'replacement.json'), file);
    await eventually(() => api.getSnapshot().bindings.some(b => b.command === 'vkv.test.replaced'), 'atomic replacement');
    await writeFile(file, '[invalid');
    await eventually(() => api.getSnapshot().errors.some(e => e.startsWith('Custom')), 'invalid JSON error');
    assert.ok(api.getSnapshot().bindings.some(b => b.command === 'vkv.test.replaced'), 'Retain last valid data');
    await rm(file);
    await eventually(() => !api.getSnapshot().bindings.some(b => b.source === 'custom') && !api.getSnapshot().errors.some(e => e.startsWith('Custom')), 'file deletion');
    await writeFile(file, contents('vkv.test.recreated'));
    await eventually(() => api.getSnapshot().bindings.some(b => b.command === 'vkv.test.recreated'), 'file recreation');
    console.log('PASS: external changes, atomic replacement, invalid JSON recovery, deletion and creation');

    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), contents('vkv.test.unsaved'));
    await vscode.workspace.applyEdit(edit);
    await eventually(() => api.getSnapshot().preview && api.getSnapshot().bindings.some(b => b.command === 'vkv.test.unsaved'), 'unsaved document preview');
    await document.save();
    await eventually(() => !api.getSnapshot().preview, 'saved document preview clears');
    console.log('PASS: unsaved edit previews and saving clears preview');

    // Verify actual Chromium webview rendering and record a shareable screenshot.
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VKV_CDP_PORT}`);
    try {
      const debugging = await browser.newBrowserCDPSession();
      const page = browser.contexts()[0]!.pages().find(p => p.url().includes('workbench'));
      assert.ok(page, 'VS Code workbench page');
      const { targetInfos } = await debugging.send('Target.getTargets');
      const target = targetInfos.find(t => t.url.startsWith('vscode-webview:') && t.url.includes('index.html'));
      assert.ok(target, 'Webview Chromium target');
      const webview = await attachWebview(debugging, target.targetId);
      let contextId: number | undefined;
      for (const id of webview.contexts) {
        if (await webview.evaluate("!!document.getElementById('app')", id)) { contextId = id; break; }
      }
      assert.ok(contextId, 'Webview document execution context');
      const evaluate = (expression: string) => webview.evaluate(expression, contextId!);
      assert.ok(await evaluate("document.querySelectorAll('button').length") > 60);
      const [spaceWidth, letterWidth] = await evaluate("[document.querySelector('#key-space').getBoundingClientRect().width, document.querySelector('#key-w').getBoundingClientRect().width]");
      assert.ok(spaceWidth > letterWidth * 3, 'Keyboard stylesheet and wide keys must render');
      await evaluate("document.querySelector('#shortcut-search').focus(); document.querySelector('#shortcut-search').value = 'vkv.test.unsaved'; document.querySelector('#shortcut-search').dispatchEvent(new Event('input'));");
      await evaluate("document.querySelector('.search-result').click()");
      assert.equal(await evaluate("document.querySelector('#key-w').getAttribute('aria-pressed')"), 'true');
      assert.equal(await evaluate("document.querySelector('#modifier-ctrl').getAttribute('aria-pressed')"), 'true');
      assert.equal(await evaluate("document.querySelector('#modifier-alt').getAttribute('aria-pressed')"), 'true');
      assert.ok(await evaluate("document.querySelector('.details-panel').textContent.includes('vkv.test.unsaved')"));
      await evaluate("document.querySelector('#source-custom').click()");

      const defaultFile = vscode.Uri.parse(api.getSnapshot().profiles.find(p => p.id === 'default')!.uri);
      let backup: Uint8Array | undefined;
      try { backup = await vscode.workspace.fs.readFile(defaultFile); } catch { /* Isolated test profile may have no file. */ }
      cleanup.push(() => backup ? vscode.workspace.fs.writeFile(defaultFile, backup) : vscode.workspace.fs.delete(defaultFile));
      await vscode.workspace.fs.writeFile(defaultFile, Buffer.from(contents('vkv.test.defaultProfile')));
      await evaluate("document.querySelector('#profile').value = 'default'; document.querySelector('#profile').dispatchEvent(new Event('change'))");
      await eventually(() => api.getSnapshot().selectedProfile === 'default' && api.getSnapshot().bindings.some(b => b.command === 'vkv.test.defaultProfile'), 'default profile selection');
      // The launcher registers this profile before VS Code startup. A directory
      // created without native registration can be removed by background cleanup.
      const namedDirectory = vscode.Uri.joinPath(defaultFile, '..', 'profiles', 'integration-fixture');
      assert.ok(api.getSnapshot().profiles.some(profile => profile.name === 'Integration profile'), 'Registered named profile fixture');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(namedDirectory, 'keybindings.json'), Buffer.from(contents('vkv.test.namedProfile')));
      await api.refresh();
      const namedProfile = api.getSnapshot().profiles.find(p => p.name === 'Integration profile');
      assert.ok(namedProfile, 'Discover a named profile directory');
      // Let the webview receive the refreshed profile options before selecting it.
      await new Promise(resolve => setTimeout(resolve, 200));
      await evaluate(`document.querySelector('#profile').value = ${JSON.stringify(namedProfile.id)}; document.querySelector('#profile').dispatchEvent(new Event('change'))`);
      await eventually(() => api.getSnapshot().selectedProfile === namedProfile.id && api.getSnapshot().bindings.some(b => b.command === 'vkv.test.namedProfile'), 'named profile selection');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(namedDirectory, 'keybindings.json'), Buffer.from(contents('vkv.test.namedChanged')));
      await eventually(() => api.getSnapshot().bindings.some(b => b.command === 'vkv.test.namedChanged'), 'named profile watcher');
      console.log('PASS: default and named profile selection, discovery and watcher rebinding');

      // Return to the representative custom-file view for the screenshot.
      await evaluate("document.querySelector('#profile').value = 'configured'; document.querySelector('#profile').dispatchEvent(new Event('change'))");
      await eventually(() => api.getSnapshot().selectedProfile === 'configured', 'configured file selection');
      await new Promise(resolve => setTimeout(resolve, 200));
      await evaluate("document.querySelector('#shortcut-search').focus(); document.querySelector('#shortcut-search').value = 'vkv.test.unsaved'; document.querySelector('#shortcut-search').dispatchEvent(new Event('input')); document.querySelector('.search-result').click()");
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await page.setViewportSize({ width: 1200, height: 800 });
      await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
      const layout = await evaluate(`(() => {
        const keyboard = document.querySelector('.keyboard-card');
        const details = document.querySelector('.details-panel');
        return { pageHeight: document.documentElement.scrollHeight, height: window.innerHeight,
          keyboardWidth: keyboard.clientWidth, keyboardScroll: keyboard.scrollWidth,
          keyboardRight: keyboard.getBoundingClientRect().right, detailsLeft: details.getBoundingClientRect().left,
          keyboardTop: keyboard.getBoundingClientRect().top, detailsTop: details.getBoundingClientRect().top,
          resultsVisible: !!document.querySelector('.search-result') };
      })()`);
      assert.ok(layout.pageHeight <= layout.height + 1, `Full view must not scroll: ${JSON.stringify(layout)}`);
      assert.ok(layout.keyboardScroll <= layout.keyboardWidth + 1, 'Keyboard must fit its panel');
      assert.ok(layout.detailsLeft >= layout.keyboardRight - 1, 'Details must be beside the keyboard');
      assert.ok(Math.abs(layout.keyboardTop - layout.detailsTop) < 40, 'Details must start alongside the keyboard');
      assert.equal(layout.resultsVisible, false, 'Search results close after choosing a shortcut');

      await evaluate("document.querySelector('#source-all').click(); document.querySelector('#app').focus(); window.__forwardedKeys = 0; window.addEventListener('keydown', () => window.__forwardedKeys++)");
      await new Promise(resolve => setTimeout(resolve, 350));
      const physicalKey = async (key: string, code: string, virtualKey: number, modifiers = 0): Promise<void> => {
        await webview.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers });
        await webview.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers });
      };
      await physicalKey('w', 'KeyW', 87, 2);
      assert.equal(await evaluate("document.querySelector('.selected-shortcut').textContent"), 'Ctrl+W');
      assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.label === 'Keybindings Visualizer'), 'Ctrl+W must not close the visualizer');
      await physicalKey('p', 'KeyP', 80, 2);
      assert.equal(await evaluate("document.querySelector('.selected-shortcut').textContent"), 'Ctrl+P');
      await physicalKey('P', 'KeyP', 80, 10);
      assert.equal(await evaluate("document.querySelector('.selected-shortcut').textContent"), 'Ctrl+Shift+P');
      await physicalKey('F5', 'F5', 116);
      assert.equal(await evaluate("document.querySelector('.selected-shortcut').textContent"), 'F5');
      await physicalKey('k', 'KeyK', 75, 2);
      await page.setViewportSize({ width: 1200, height: 700 });
      await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
      const compactLayout = await evaluate(`(() => {
        const keyboard = document.querySelector('.keyboard-scroll');
        const lastKey = document.querySelector('#key-right');
        const details = document.querySelector('.details-scroll');
        return { height: window.innerHeight, pageHeight: document.documentElement.scrollHeight,
          keyboardBottom: keyboard.getBoundingClientRect().bottom, lastKeyBottom: lastKey.getBoundingClientRect().bottom,
          detailsHeight: details.clientHeight, detailsContentHeight: details.scrollHeight };
      })()`);
      assert.ok(compactLayout.pageHeight <= compactLayout.height + 1, 'A shorter full view must not scroll');
      assert.ok(compactLayout.lastKeyBottom <= compactLayout.keyboardBottom + 1, 'All keyboard rows must remain visible');
      assert.ok(compactLayout.detailsContentHeight > compactLayout.detailsHeight, 'Long chord details must scroll within the sidebar');
      await evaluate("document.querySelector('.details-scroll').scrollTop = 80");
      await api.refresh();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await evaluate("document.querySelector('.details-scroll').scrollTop"), 80, 'Live updates must preserve sidebar position');
      await physicalKey('c', 'KeyC', 67, 2);
      assert.equal(await evaluate("document.querySelector('.selected-shortcut').textContent"), 'Ctrl+K → Ctrl+C');
      assert.equal(await evaluate('window.__forwardedKeys'), 0, 'Captured native events must not reach the VS Code key bridge');
      console.log('PASS: compact layout, search dropdown, and native Ctrl+W/P/Shift+P, F5 and chord capture');

      // Capture representative default/custom command details at a normal window size.
      await page.setViewportSize({ width: 1200, height: 800 });
      await physicalKey('w', 'KeyW', 87, 3);
      await page.screenshot({ path: join(process.env.VKV_ARTIFACTS!, 'visualizer.png') });
      await webview.close();
      console.log('PASS: keyboard webview renders in Chromium; artifacts/visualizer.png captured');
    } finally { await browser.close(); }

    const visualizer = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Keybindings Visualizer');
    assert.ok(visualizer);
    await vscode.window.tabGroups.close(visualizer);
    const lastUpdate = api.getSnapshot().updatedAt;
    await writeFile(file, contents('vkv.test.afterClose'));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(api.getSnapshot().updatedAt, lastUpdate, 'Closing panel must stop watching');
    console.log('PASS: closing the panel disposes live watchers');
    snapshot = await api.refresh();
    assert.ok(snapshot.bindings.some(b => b.command === 'vkv.test.afterClose'));
  } finally {
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); }
      catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') console.warn('Integration cleanup:', error); }
    }
    await config.update('keybindingsFile', previous, vscode.ConfigurationTarget.Global);
    await rm(directory, { recursive: true, force: true });
  }
}
