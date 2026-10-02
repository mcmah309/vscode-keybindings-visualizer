# Keybindings Visualizer

Explore VS Code's default and custom keyboard shortcuts on an interactive US QWERTY keyboard. Select modifier layers, inspect commands and conditions, and find your custom shortcuts without opening JSON editor tabs.

## Install and open

Requires desktop VS Code 1.96 or later.

1. Build the local VSIX with the development commands below.
2. Run **Extensions: Install from VSIX…** in VS Code and select `artifacts/keybindings-visualizer.vsix`.
3. Run **Keybindings Visualizer: Open** from the Command Palette.

The extension runs on the desktop UI side, including when connected to a remote workspace. Browser-based VS Code is not supported. The package is local; these instructions do not publish it to the Marketplace.

## Explore shortcuts

- Toggle Ctrl, Alt/Option, Shift, and Win/Cmd to select a layer, or choose a populated layer from the **Layers** dropdown.
- Click a key to highlight its shortcut and inspect command IDs, available titles, arguments, sources, and `when` conditions in the right-hand details pane. The compact keyboard stays visible at normal editor sizes; longer details scroll inside the sidebar. Small panes adapt the layout. Custom bindings have an amber accent; numbers indicate multiple candidates.
- Switch between **All bindings** and **Custom only**, or use **Find a shortcut** to search by command ID, title, or shortcut, such as `ctrl+w`. Results appear in a dropdown while searching; selecting a result, pressing Escape, or moving focus outside search dismisses it.
- Select a search result to highlight its keys and modifier layer. For chords such as `ctrl+k ctrl+c`, select the first stroke and then a continuation, select the complete chord in search, or press the strokes on your keyboard.
- With the visualizer focused, press a shortcut to select it. The visualizer consumes shortcuts, including chords, instead of running their usual VS Code commands. Search fields retain normal typing and text editing, and Tab remains available for navigating controls.
- Use **Profile** to select Default or a discovered named profile. Use **Choose file…** for another `keybindings.json` or a profile that was not discovered.

Selection previews bindings; it never runs their commands. Candidate commands appear in precedence order. VS Code's editor context determines which conditional binding actually runs, so the visualizer does not claim a winner when context-dependent alternatives remain.

Keyboard capture works for events delivered to VS Code. Shortcuts reserved by the operating system cannot be captured when the operating system does not deliver them to the application.

The diagram always uses US QWERTY. Scan-code bindings map to physical positions on that diagram; character bindings may refer to different positions on a non-US keyboard. Bindings that cannot map to the diagram remain searchable.

## Files, profiles, and live updates

The initial selection is **Default**, even if the current VS Code window uses a named profile. Profile discovery uses local VS Code profile metadata and directories; profiles that inherit Default's custom keybindings are identified. Every selected file is combined with the **current window's defaults**, which can include extension contributions. Selecting a different profile does not activate its extensions, so the preview may differ from running that profile.

The selected custom file is watched for changes, creation, deletion, and replacement saves. Updates are debounced by 200 ms and preserve selection, modifiers, filters, and search. While the panel is visible, a lightweight content check every two seconds recovers missed watcher notifications. Unsaved edits in an already-open keybindings document appear as an **Unsaved preview**. JSONC comments and trailing commas are supported. A malformed file shows an error and retains its last valid bindings; a missing custom file is treated as empty.

To initially load a particular file, set `keybindingsVisualizer.keybindingsFile` to an absolute path or URI. It appears as **Configured file** in the profile selector. You can still select another profile or use **Choose file…**. For example:

```json
{
  "keybindingsVisualizer.keybindingsFile": "/absolute/path/keybindings.json"
}
```

VS Code has no public extension API that supplies its complete resolved keybinding rules or evaluates the full current context for this view. Generated defaults are read in the background from the internal `vscode://defaultsettings/keybindings.json` resource. This resource and profile metadata can change between VS Code versions. If defaults are unavailable, the panel reports the failure, keeps available custom bindings, and offers **Retry**. **Refresh** reloads both sources; defaults also refresh when extensions change or the panel becomes visible.

## Development

Use a supported Node.js LTS release and npm.

```sh
npm ci
npm run check
npm test
npm run build
npm run package
```

Packaging creates `artifacts/keybindings-visualizer.vsix`. Press F5 in this repository to launch an Extension Development Host, then run **Keybindings Visualizer: Open**. Use `npm run watch` when iterating on the extension or webview.

Run the Electron integration checks with:

```sh
npm run test:integration
```

On Linux without a display, install Xvfb and run:

```sh
xvfb-run -a npm run test:integration
```

The integration runner downloads VS Code when needed and requires network access on its first run. Unit tests cover rule parsing and merging, host loading, and webview behavior; integration checks exercise the extension inside VS Code.

Validated on Linux with VS Code 1.96.0 and 1.140.0, including background defaults, external saves, invalid JSON recovery, unsaved previews, profile switching, real keyboard interactions, and watcher disposal. To select a test version, set `VSCODE_TEST_VERSION` (for example, `VSCODE_TEST_VERSION=1.96.0 xvfb-run -a npm run test:integration`). Windows, macOS, and desktop remote windows still require the manual checks below.

### Manual platform checks

Before release, check Windows, Linux, macOS, and a desktop remote workspace:

- Open the panel and confirm defaults load without opening a JSON tab.
- Select modifier combinations and a chord; verify highlighting, candidate details, search, and Custom only.
- With the visualizer focused, press Ctrl+W, Ctrl+P, Ctrl+Shift+P, F5, and Ctrl+K Ctrl+C (using Cmd alternatives where appropriate). Verify selection without closing the panel, opening palettes, starting debugging, or executing the chord's command.
- Type and edit a query, select a search result, and dismiss results with Escape or outside focus. Confirm Tab navigation and that only details need scrolling in a full-size view.
- Switch between Default, a named profile, and a chosen file; verify inherited-profile labels and preview warnings.
- Change, replace, delete, and recreate the selected custom file; confirm updates preserve UI state.
- Edit without saving, enter invalid JSON, then fix it; verify preview status, last-valid data, and recovery.
- Check theme contrast, keyboard navigation, platform modifier labels, and non-US layout limitations.
- Close and reopen the panel and verify updates still work.
