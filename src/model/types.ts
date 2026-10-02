export type Platform = 'win32' | 'linux' | 'darwin';
export type Modifier = 'ctrl' | 'alt' | 'shift' | 'cmd';
export type Source = 'default' | 'custom';
export type Status = 'active' | 'removed' | 'superseded' | 'inactive' | 'removal';

export interface Stroke {
  modifiers: Modifier[];
  key: string;
  canonical: string;
  /** A physical US key, if it can be shown on the diagram. */
  physical?: string;
}

export interface Binding {
  id: string;
  key: string;
  strokes: Stroke[];
  command: string;
  label: string;
  when?: string;
  args?: unknown;
  source: Source;
  order: number;
  line: number;
  status: Status;
  reason?: string;
}

export interface Profile {
  id: string;
  name: string;
  uri: string;
  inherited?: boolean;
}

export interface Snapshot {
  bindings: Binding[];
  profiles: Profile[];
  selectedProfile: string;
  file: string;
  platform: Platform;
  errors: string[];
  warnings: string[];
  preview: boolean;
  defaultsAvailable: boolean;
  updatedAt: string;
}

export type ToHost =
  | { type: 'ready' | 'refresh' | 'chooseFile' }
  | { type: 'profile'; id: string };
export type ToWebview = { type: 'snapshot'; snapshot: Snapshot } | { type: 'loading' };
