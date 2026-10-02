import { describe, expect, it } from 'vitest';
import { BindingStore, defaultsUri, discoverProfiles, type HostIO } from '../src/host/store';

function fixture() {
  const files = new Map<string, string>();
  const documents = new Map<string, { text: string; dirty: boolean }>();
  const directories = new Map<string, string[]>();
  const errors = new Set<string>();
  const io: HostIO = {
    read: async uri => { if (errors.has(uri)) throw new Error('Access denied'); return files.get(uri); },
    directories: async uri => directories.get(uri) ?? [],
    join: (uri, ...parts) => `${uri.replace(/\/$/, '')}/${parts.join('/')}`,
    document: uri => documents.get(uri),
    labels: () => ({ 'editor.action.test': 'Test Command' }),
  };
  const user = 'file:///User';
  const custom = `${user}/keybindings.json`;
  files.set(defaultsUri, '[{"key":"ctrl+w","command":"workbench.action.closeActiveEditor"}]');
  return { files, documents, directories, errors, io, user, custom, store: new BindingStore(io, user, 'linux') };
}

describe('binding source store', () => {
  it('loads defaults and missing custom files without opening a document', async () => {
    const f = fixture();
    const snapshot = await f.store.refresh();
    expect(snapshot.defaultsAvailable).toBe(true);
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.file).toBe(f.custom);
    expect(snapshot.errors).toEqual([]);
  });

  it('reloads edits, replacement and deletion, preserving valid data on malformed JSON', async () => {
    const f = fixture();
    f.files.set(f.custom, '[{"key":"ctrl+t","command":"editor.action.test"}]');
    expect((await f.store.refresh()).bindings.find(binding => binding.source === 'custom')?.label).toBe('Test Command');
    f.files.set(f.custom, '[{"key":');
    const invalid = await f.store.refresh();
    expect(invalid.errors[0]).toContain('Custom keybindings');
    expect(invalid.bindings.some(binding => binding.command === 'editor.action.test')).toBe(true);
    f.files.set(f.custom, '[{"key":"alt+a","command":"replacement"}]');
    expect((await f.store.refresh()).bindings.some(binding => binding.command === 'replacement')).toBe(true);
    f.files.delete(f.custom);
    expect((await f.store.refresh()).bindings.every(binding => binding.source === 'default')).toBe(true);
  });

  it('previews dirty documents and returns to disk when discarded', async () => {
    const f = fixture();
    f.documents.set(f.custom, { text: '[{"key":"ctrl+a","command":"unsaved"}]', dirty: true });
    const preview = await f.store.refresh();
    expect(preview.preview).toBe(true);
    expect(preview.bindings.some(binding => binding.command === 'unsaved')).toBe(true);
    f.documents.delete(f.custom);
    const disk = await f.store.refresh();
    expect(disk.preview).toBe(false);
    expect(disk.bindings.some(binding => binding.command === 'unsaved')).toBe(false);
  });

  it('retains previous defaults with an error and retries unavailable defaults', async () => {
    const f = fixture();
    await f.store.refresh();
    f.errors.add(defaultsUri);
    const stale = await f.store.refresh();
    expect(stale.bindings).toHaveLength(1);
    expect(stale.errors[0]).toContain('last valid defaults');
    f.errors.delete(defaultsUri);
    expect((await f.store.refresh()).errors).toEqual([]);
    const other = fixture();
    other.files.delete(defaultsUri);
    const unavailable = await other.store.refresh();
    expect(unavailable.defaultsAvailable).toBe(false);
    expect(unavailable.errors[0]).toContain('Default keybindings');
  });

  it('switches profiles and chosen files without leaking another file’s last valid content', async () => {
    const f = fixture();
    f.files.set(f.custom, '[{"key":"ctrl+a","command":"default.custom"}]');
    await f.store.refresh();
    f.store.chooseFile('file:///other/keybindings.json');
    f.files.set('file:///other/keybindings.json', '[invalid');
    const snapshot = await f.store.refresh();
    expect(snapshot.selectedProfile).toBe('chosen');
    expect(snapshot.bindings.some(binding => binding.command === 'default.custom')).toBe(false);
    expect(snapshot.warnings[0]).toContain('current VS Code window');
    f.store.selectProfile('default');
    expect((await f.store.refresh()).bindings.some(binding => binding.command === 'default.custom')).toBe(true);
  });

  it('uses a configured file until the configuration override is removed', async () => {
    const f = fixture();
    f.files.set('file:///configured.json', '[]');
    const configured = await f.store.refresh('file:///configured.json');
    expect(configured.selectedProfile).toBe('configured');
    expect(configured.file).toBe('file:///configured.json');
    expect((await f.store.refresh()).selectedProfile).toBe('default');
    f.store.chooseFile('file:///chosen.json');
    expect((await f.store.refresh('file:///configured.json')).selectedProfile).toBe('chosen');
    f.store.selectProfile('default');
    expect((await f.store.refresh('file:///configured.json')).selectedProfile).toBe('default');
    f.store.selectProfile('configured');
    expect((await f.store.refresh('file:///new-configured.json')).file).toBe('file:///new-configured.json');
  });
});

describe('profile discovery', () => {
  it('reads names, inheritance and directories absent from metadata', async () => {
    const f = fixture();
    f.files.set('file:///User/globalStorage/storage.json', JSON.stringify({ userDataProfiles: [
      { name: 'Work', location: 'abc' },
      { name: 'Inherited', location: { scheme: 'file', path: '/User/profiles/inherit' }, useDefaultFlags: { keybindings: true } },
    ] }));
    f.directories.set('file:///User/profiles', ['abc', 'inherit', 'unknown']);
    f.files.set('file:///User/profiles/unknown/profile.json', '{"name":"Discovered"}');
    const profiles = await discoverProfiles(f.io, f.user);
    expect(profiles.find(p => p.name === 'Work')?.uri).toBe('file:///User/profiles/abc/keybindings.json');
    expect(profiles.find(p => p.name === 'Inherited')?.uri).toBe(f.custom);
    expect(profiles.find(p => p.name === 'Discovered')).toBeDefined();
    expect(profiles.filter(p => p.name === 'Work')).toHaveLength(1);
  });

  it('falls back to directory discovery for missing or malformed metadata', async () => {
    const f = fixture();
    f.files.set('file:///User/globalStorage/storage.json', 'null');
    f.directories.set('file:///User/profiles', ['one']);
    expect((await discoverProfiles(f.io, f.user)).map(p => p.name)).toEqual(['Default', 'one']);
  });
});
