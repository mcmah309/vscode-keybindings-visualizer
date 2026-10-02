import { parse, type ParseError } from 'jsonc-parser';
import { mergeBindings, parseBindings, type RemovalMode } from '../model/bindings';
import type { Binding, Platform, Profile, Snapshot } from '../model/types';

export interface HostIO {
  /** Missing files return undefined; other failures reject. */
  read(uri: string): Promise<string | undefined>;
  directories(uri: string): Promise<string[]>;
  join(uri: string, ...segments: string[]): string;
  document(uri: string): { text: string; dirty: boolean } | undefined;
  labels(): Record<string, string> | Promise<Record<string, string>>;
}

export const defaultsUri = 'vscode://defaultsettings/keybindings.json';

function metadataLocation(value: unknown, user: string, io: HostIO): string | undefined {
  if (typeof value === 'string') {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
    return io.join(user, 'profiles', value);
  }
  if (value && typeof value === 'object') {
    const uri = value as { scheme?: string; authority?: string; path?: string };
    if (uri.scheme && uri.path) {
      const url = new URL(`${uri.scheme}://${uri.authority ?? ''}/`);
      url.pathname = uri.path;
      return url.toString();
    }
  }
  return undefined;
}

export async function discoverProfiles(io: HostIO, user: string): Promise<Profile[]> {
  const profiles: Profile[] = [{ id: 'default', name: 'Default', uri: io.join(user, 'keybindings.json') }];
  let metadata: unknown;
  try {
    const text = await io.read(io.join(user, 'globalStorage', 'storage.json'));
    if (text) {
      const storage = parse(text) as Record<string, unknown>;
      metadata = storage?.userDataProfiles;
      if (typeof metadata === 'string') metadata = parse(metadata);
    }
  } catch { /* Directory discovery remains available if metadata is unreadable. */ }
  if (Array.isArray(metadata)) {
    for (const raw of metadata) {
      if (!raw || typeof raw !== 'object') continue;
      const profile = raw as { name?: string; location?: unknown; useDefaultFlags?: { keybindings?: boolean }; id?: string };
      const location = metadataLocation(profile.location, user, io);
      if (!location) continue;
      const inherited = profile.useDefaultFlags?.keybindings === true;
      profiles.push({ id: profile.id ?? location, name: profile.name ?? 'Profile', uri: inherited ? profiles[0]!.uri : io.join(location, 'keybindings.json'), inherited });
    }
  }
  try {
    for (const name of await io.directories(io.join(user, 'profiles'))) {
      const location = io.join(user, 'profiles', name);
      const uri = io.join(location, 'keybindings.json');
      if (profiles.some(p => p.id === location || p.uri === uri)) continue;
      const profileJson = await io.read(io.join(location, 'profile.json')).catch(() => undefined);
      let displayName = name;
      if (profileJson) {
        const errors: ParseError[] = [];
        const data = parse(profileJson, errors) as { name?: string };
        if (!errors.length && typeof data?.name === 'string') displayName = data.name;
      }
      // Include profiles without a custom file: VS Code may create it on the first edit.
      profiles.push({ id: location, name: displayName, uri });
    }
  } catch { /* No named profiles is a normal first-run state. */ }
  return profiles;
}

export class BindingStore {
  private defaultBindings: Binding[] = [];
  private defaultsAvailable = false;
  private customCache = new Map<string, Binding[]>();
  private selected = 'default';
  private explicitlySelected = false;
  private chosenFile: string | undefined;
  private revision = 0;
  private snapshot: Snapshot;

  constructor(private io: HostIO, private user: string, private platform: Platform, private removalMode: RemovalMode = 'implication') {
    this.snapshot = { bindings: [], profiles: [], selectedProfile: 'default', file: io.join(user, 'keybindings.json'), platform, errors: [], warnings: [], preview: false, defaultsAvailable: false, updatedAt: '' };
  }

  getSnapshot(): Snapshot { return this.snapshot; }
  selectProfile(id: string): void { this.selected = id; this.chosenFile = undefined; this.explicitlySelected = true; }
  chooseFile(uri: string): void { this.chosenFile = uri; this.selected = 'chosen'; this.explicitlySelected = true; }

  async refresh(configuredFile?: string): Promise<Snapshot> {
    const revision = ++this.revision;
    const selected = this.selected;
    const chosenFile = this.chosenFile;
    const errors: string[] = [];
    const warnings: string[] = [];
    const labels = await this.io.labels();
    const profiles = await discoverProfiles(this.io, this.user);
    if (configuredFile) profiles.push({ id: 'configured', name: 'Configured file', uri: configuredFile });
    if (chosenFile) profiles.push({ id: 'chosen', name: 'Chosen file', uri: chosenFile });
    const selectedProfile = configuredFile && (!this.explicitlySelected || selected === 'configured') ? 'configured' : profiles.some(p => p.id === selected) ? selected : 'default';
    const profile = profiles.find(p => p.id === selectedProfile)!;
    if (selectedProfile !== 'default') warnings.push('This file is previewed against the current VS Code window’s defaults. Another profile may enable different extensions.');
    if (profile.inherited) warnings.push('This profile inherits the Default profile’s custom keybindings.');

    let defaults = this.defaultBindings;
    let defaultsAvailable = this.defaultsAvailable;
    try {
      const text = await this.io.read(defaultsUri);
      if (text === undefined) throw new Error('VS Code did not provide generated default keybindings.');
      defaults = parseBindings(text, 'default', this.platform, labels);
      defaultsAvailable = true;
    } catch (error) {
      errors.push(`Default keybindings could not be loaded: ${message(error)}${defaultsAvailable ? ' Showing the last valid defaults.' : ''}`);
    }

    let custom = this.customCache.get(profile.uri) ?? [];
    let preview = false;
    try {
      const document = this.io.document(profile.uri);
      preview = document?.dirty ?? false;
      const text = document?.dirty ? document.text : await this.io.read(profile.uri);
      custom = text === undefined ? [] : parseBindings(text, 'custom', this.platform, labels);
    } catch (error) {
      errors.push(`Custom keybindings could not be loaded: ${message(error)} Showing the last valid bindings for this file.`);
    }
    const snapshot: Snapshot = { bindings: mergeBindings(defaults, custom, this.platform, this.removalMode), profiles, selectedProfile, file: profile.uri, platform: this.platform, errors, warnings, preview, defaultsAvailable, updatedAt: new Date().toISOString() };
    if (revision === this.revision) {
      this.defaultBindings = defaults;
      this.defaultsAvailable = defaultsAvailable;
      this.customCache.set(profile.uri, custom);
      this.snapshot = snapshot;
    }
    return this.snapshot;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
