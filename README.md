# MF Dashboard

Sidebar for the Module Federation microfrontends in the open workspace. The extension reads `module-federation`, `webpack`, `rspack`, `rsbuild`, and `vite` configs, checks the local port, the manifest, and the types zip, and draws one status per row.

`pluginModuleFederation`, `ModuleFederationPlugin`, or `createModuleFederationConfig` may live in a function that the config imports from the same package.

The row icon and the gray description show the same status. Extra detail goes in the hover tooltip, and the icon stays as it is. A narrow sidebar clips the gray description. The full reason stays in the tooltip.

## Features

`mf-dashboard.structure` is `tree` or `flat`. In `tree`, each remote sits under the microfrontend that uses it. In `flat`, every known microfrontend has its own row. The buttons in the view title write this setting.

Each row has one status. A local app is `listening` or `stopped`. A link can also be stale types, a bad URL, or a URL that does not match the local port. An address with no local port is `reachable` or `unreachable`.

**Start** runs that app's `package.json` script in a terminal named `MF <name>`.

**Rebuild types** regenerates dts for a stale producer, starting at the leaves, then refreshes each consumer's `@mf-types` from the dependency zips.

**Fetch @mf-types** downloads one link's zip into the consumer's `@mf-types/<alias>` directory.

When the workspace has Module Federation configs and `mf-dashboard.apps` is not saved yet, the first open fills in the missing apps. Later opens reload what is already saved.

Tree labels follow `mf-dashboard.language`. Command titles and the empty state follow the VS Code language. An empty workspace, and a workspace with no Module Federation configs, stay empty and leave `.vscode/settings.json` unwritten.

## Statuses

The first matching rule wins.

An application root looks only at the local port: open on `127.0.0.1` is `listening`; closed or undeclared is `stopped`. A declared port is written in the gray description.

A link to a local application that has a port:

1. Closed port: `stopped`.
2. Producer sources are newer than the zip, and `mf-dashboard.typesSettleMs` has elapsed since the save: `types not rebuilt`.
3. The types directory is missing while the zip is reachable, or the installed types do not match this link's zip: `types not updated`.
4. The URL is empty, unsubstituted, or not HTTP(S): `URL error`. No request is sent.
5. The port is open and the host is neither `localhost` nor `127.0.0.1`: `non-local URL`.
6. The host is local and the port differs: `different port`. A missing port means `80` for `http` and `443` for `https`.
7. Otherwise: `listening`. When the manifest is enabled and contains `metaData.buildInfo.buildVersion`, that version is appended to the gray description.

An external address is a remote, or a URL from `mf-dashboard.extraManifestUrls`, with no port of its own in this workspace:

1. Empty or non-HTTP(S) URL: `URL error`. No request.
2. The manifest answered: `reachable`.
3. A valid HTTP(S) URL did not answer: `unreachable`.

`localhost` and `127.0.0.1` are one local host. Ports `80` and `443` stay off the gray description. An external address shows the host and the status, for example `static.example · reachable`.

| Status              | Icon             | Gray description                                                      | Russian label       |
| ------------------- | ---------------- | --------------------------------------------------------------------- | ------------------- |
| `listening`         | `pass`           | `:3001 · listening`, plus `buildVersion` when the manifest is enabled | работает            |
| `stopped`           | `error`          | `:3001 · stopped`                                                     | остановлен          |
| `types not rebuilt` | `clock`          | `:3001 · types not rebuilt`                                           | типы не пересобраны |
| `types not updated` | `cloud-download` | `:3001 · types not updated`                                           | типы не обновлены   |
| `URL error`         | `warning`        | `:3001 · URL error`, or `URL error` alone for an external address     | ошибка URL          |
| `non-local URL`     | `warning`        | `:3001 · non-local URL`                                               | URL не локальный    |
| `different port`    | `warning`        | `:3001 · different port`                                              | URL на другой порт  |
| `reachable`         | `globe`          | `static.example · reachable`                                          | доступен            |
| `unreachable`       | `circle-slash`   | `static.example · unreachable`                                        | недоступен          |

The same name can be `listening` as a root and, for example, `non-local URL` as a child: the local port is open, and that link's URL points somewhere else. Each URL is probed on its own. A link id is the consumer, the alias, and the remote name.

Tooltip notes do not change the icon:

- `types freshness unknown`: freshness is not proven. The first probe time and the directory mtime are not evidence.
- `type consumption disabled`: the consumer has `consumeTypes: false`. That link has no types button.
- `waiting for types download`: an `@mf-types` download is in progress.
- `types download failed`: the download failed.
- `script not found`: **Start** has no such script key in `package.json`.
- `folder: not in workspace`: an external address has no directory in this workspace.
- `exposes` and `shared`: names from the manifest JSON for this row. An app row uses its own manifest. A link uses the manifest at that link's URL. A list of more than eight names shows the count, the first eight names, and an ellipsis. The icon and the gray description stay the status.

A failed manifest request adds the HTTP status (`HTTP 404`, `HTTP 503`), a timeout, or a network error. The note disappears after the next successful request. An external URL stays `unreachable`. A local application's status still comes from its port.

While `consumeTypes: false`, a link does not become `types not rebuilt` or `types not updated`.

## Problems

The same failed statuses are written to the Problems panel, source `MF Dashboard`.

`URL error`, `non-local URL`, `different port`, and `unreachable` are warnings. `types not rebuilt` and `types not updated` are information. `listening`, `stopped`, and `reachable` are not written.

A link is attached to the consumer config. The message is the consumer name, the alias, and the status, for example `shell → widget: types not updated`. An extra manifest URL is attached to the workspace value of `mf-dashboard.extraManifestUrls`. When the window has a saved `.code-workspace` file, the diagnostic uses that file, including a workspace with one folder. A single folder opened without a workspace file uses its `.vscode/settings.json`. An extra URL in an unsaved workspace or with no workspace value stays in the tree only.

The list is replaced when a probe finishes and when the tree redraws. It is left in place while a probe request is still running. Flat mode still reports link problems.

## Layout

`mf-dashboard.structure` chooses the view. The default is `tree`.

`tree` keeps, at the root, every microfrontend that no other loaded app consumes, and nests its `remotes` underneath. A `shell` that consumes five widgets is one `shell` row with five children. A widget that consumes something else expands further. A cycle that would otherwise disappear gets an extra root so those apps stay visible.

`flat` shows every microfrontend from `mf-dashboard.apps` once, with no children. URLs from `mf-dashboard.extraManifestUrls` stay sibling rows in both modes. Changing the setting redraws the list without scanning again.

## First open

When the workspace has Module Federation configs and `mf-dashboard.apps` is not written yet, the first open scans the workspace and appends the names it finds. Only missing keys are written to `.vscode/settings.json`. Saved values stay as they are.

A multi-root workspace is scanned folder by folder. Adding or removing a folder updates the list. Entries saved for a removed folder stay in settings and show up again when that folder returns. Federation names must be unique across the whole workspace, as must workspace-folder names.

Once `mf-dashboard.apps` exists, including as an empty object, opening the window reloads known entries and `mf-dashboard.extraManifestUrls`. It leaves new configs on disk alone until you search again.

A new entry gets `path` relative to the workspace root, `manifestPath` from the config, and `scripts.start` set to `dev`. Later edits stick: another search leaves an existing entry as it is.

## Refresh and discover

**Refresh** re-reads settings and the configs of apps already in `mf-dashboard.apps`, then checks ports, manifests, and zips again. Configs that are not saved yet stay out of this pass. Changing `mf-dashboard.envMode`, `mf-dashboard.ignorePaths`, `mf-dashboard.extraManifestUrls`, `mf-dashboard.typesSettleMs`, or `mf-dashboard.apps` runs the same refresh.

Saving a known producer's `.ts` or `.tsx` file in VS Code refreshes the local types estimate immediately and again after `typesSettleMs`. That save sends no network requests. Saving its config or the active `.env.<mode>` file re-reads the app and repeats the checks. The timer still covers edits made outside the editor, and the state of ports, manifests, and zips.

**Find microfrontends** scans the workspace again and adds only names that are missing from `mf-dashboard.apps`. Saved `path`, `manifestPath`, and `scripts` stay as they are. Names the scan no longer sees stay in the list. If you remove a name and the config is still on disk, the next search adds it back.

The scan always skips `node_modules`, `.git`, and `dist`.

## Row actions

**Start** is shown on `stopped`. The script key comes from `scripts.start` on that app, or from `mf-dashboard.scripts.start` when the app has none. The default is `dev`. The extension runs `<package manager> run <key>` in the app directory, for example `pnpm run dev`. The script body in `package.json` is checked only to confirm the key exists and is a string. A key may contain letters, digits, `_`, `.`, `:`, and `-`. Anything else is not passed to the terminal shell. A missing key, or a key with other characters, starts no process, adds `script not found` to the tooltip, and leaves the row `stopped`. The terminal is named `MF <name>` and is revealed when `mf-dashboard.terminal.reveal` is `true`. A port that is already listening, and an external address with no port of its own, have no Start button.

**Rebuild types** is shown on `types not rebuilt`. The plan walks from the selected microfrontend to local dependencies that have `generateTypes`, starting at the leaves. Consumers of the selected node are left out of the plan. A node is skipped when its zip is reachable, its own sources are not newer than that zip, and every dependency skipped in this pass is also unchanged relative to the node's zip. While `mf-dashboard.commands.rebuildTypes` is empty, the step calls the Module Federation plugin with that app's `compilerInstance`, `tsConfigPath`, and `afterGenerate`. A non-empty command runs instead of the plugin. Before a dependent app is built, its `@mf-types` are refreshed from dependency zips. An error is written to the tooltip, that node's zip is left unchanged, and later steps in the chain do not run. A dependency cycle is reported before any process starts. External dependencies are not generated locally.

**Fetch @mf-types** appears on a link whose status is `types not updated`. While `mf-dashboard.commands.refetchTypes` is empty, the extension downloads the zip for the link URL, checks the unpacked files, and replaces the consumer's `@mf-types/<alias>` directory. Files from the previous install stay if the download fails. The consumer port must be listening. The download proceeds even if the dev server never notices that the directory was removed. A non-empty command replaces the built-in download and still has to pass the same check. Until the operation finishes, the row stays `types not updated`, the tooltip says `waiting for types download`, and another fetch is disabled. An error or the 60 second timeout clears the wait and allows a retry. The row stays `types not updated` until the directory matches this link's zip hash and the file fingerprint. `consumeTypes: false` does not offer a download.

## Example

The port comes from `server.port` or `devServer.port` in the config. It is not a setting. The federation name and the directory may differ: a federation named `widget` may live in `apps/widget`. The default manifest path is `/mf-manifest.json`. `manifest.fileName`, `server.base`, or `import.meta.env.ASSET_PREFIX` can set another path.

This is the file after the first open of a workspace that contains two apps.

```json
{
  "mf-dashboard.envMode": "development",
  "mf-dashboard.language": "auto",
  "mf-dashboard.structure": "tree",
  "mf-dashboard.ignorePaths": [],
  "mf-dashboard.extraManifestUrls": [],
  "mf-dashboard.packageManager": "auto",
  "mf-dashboard.probeIntervalMs": 5000,
  "mf-dashboard.typesSettleMs": 15000,
  "mf-dashboard.terminal.reveal": true,
  "mf-dashboard.scripts.start": "dev",
  "mf-dashboard.commands.rebuildTypes": "",
  "mf-dashboard.commands.refetchTypes": "",
  "mf-dashboard.apps": {
    "shell": {
      "path": "apps/shell",
      "manifestPath": "/mf-manifest.json",
      "scripts": { "start": "dev" }
    },
    "widget": {
      "path": "apps/widget",
      "manifestPath": "/mf-manifest.json",
      "scripts": { "start": "dev" }
    }
  }
}
```

In this example `shell` consumes `widget` at the URL from its config. A string URL stays the same when `mf-dashboard.envMode` changes. A URL built from `process.env` or `import.meta.env` comes from `.env.<mode>` and `.env.<mode>.local` in the app directory. The `.local` file overrides the other one.

`auto` for `mf-dashboard.packageManager` reads `packageManager` in the root `package.json`. The name is the text before `@`. `npm`, `pnpm`, `yarn`, and `bun` are recognized. Any other name is ignored. If that field is missing or ignored, detection looks for `pnpm-lock.yaml`, then `yarn.lock`, then `bun.lock` or `bun.lockb`, then `package-lock.json`, and otherwise stays on `npm`.

## Settings

| Setting                              | Default       | Description                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mf-dashboard.envMode`               | `development` | Which `.env.<mode>` and `.env.<mode>.local` supply remote URLs and the port. The mode may contain letters, digits, `_`, and `-`. A value with a path separator is ignored. Changing it re-reads known apps and does not add new ones. String URLs in the config do not depend on the mode.                                                                                                                                           |
| `mf-dashboard.structure`             | `tree`        | `tree` or `flat`. See [Layout](#layout). The title-bar button writes the same value.                                                                                                                                                                                                                                                                                                                                                 |
| `mf-dashboard.language`              | `auto`        | Language of tree labels and tooltips. `auto` follows VS Code, `en` keeps the English source, `ru` uses the bundled translation. Command titles and the empty state still follow VS Code. The English empty state is `No Module Federation configs found`.                                                                                                                                                                            |
| `mf-dashboard.ignorePaths`           | `[]`          | Extra directories the scan skips. A name without a slash matches that directory name at any depth. A path with a slash, such as `apps/widget`, skips that directory and everything inside it. `node_modules`, `.git`, and `dist` are always skipped. An app that is already saved is still read from its `path`. A new app inside a skipped directory is not added until the path is removed and **Find microfrontends** runs again. |
| `mf-dashboard.extraManifestUrls`     | `[]`          | Manifest URLs with no application in this workspace. Each URL is a root row. A valid HTTP(S) URL shows the host and `reachable` or `unreachable`. An empty or invalid URL shows `URL error` and is not requested. The row has no **Start** button.                                                                                                                                                                                   |
| `mf-dashboard.packageManager`        | `auto`        | What **Start** uses to run the script: `auto`, `npm`, `pnpm`, `yarn`, or `bun`. `auto` reads the root `packageManager` field, then `pnpm-lock.yaml`, then `yarn.lock`, then `bun.lock` or `bun.lockb`, then `package-lock.json`, then `npm`. An explicit name ignores the field and the lockfile. The terminal command becomes `<manager> run <key>`.                                                                                |
| `mf-dashboard.probeIntervalMs`       | `5000`        | Milliseconds between port, manifest, and zip checks. The minimum is `1000`. Changing it restarts the timer.                                                                                                                                                                                                                                                                                                                          |
| `mf-dashboard.typesSettleMs`         | `15000`       | Milliseconds after a source save before a zip counts as stale. A save in VS Code checks immediately and again when the pause ends. The row does not become `types not rebuilt` during the pause.                                                                                                                                                                                                                                     |
| `mf-dashboard.terminal.reveal`       | `true`        | Show the terminal when **Start** runs a script. `false` still creates the terminal.                                                                                                                                                                                                                                                                                                                                                  |
| `mf-dashboard.scripts.start`         | `dev`         | `package.json` script key for **Start** when the app entry has no `scripts.start`. A missing key does not start a process and adds `script not found`.                                                                                                                                                                                                                                                                               |
| `mf-dashboard.commands.rebuildTypes` | `""`          | Command that replaces dts generation. Empty runs the plugin. Placeholders: `{folder}`, `{name}`, `{port}`, `{tsconfig}`. `{typesFolder}` is left as text.                                                                                                                                                                                                                                                                            |
| `mf-dashboard.commands.refetchTypes` | `""`          | Command that replaces the types download. Empty downloads the zip. The 60 second timeout and the directory check still apply. Placeholders: `{folder}`, `{name}`, `{port}`, `{tsconfig}`, `{typesFolder}`.                                                                                                                                                                                                                           |
| `mf-dashboard.apps`                  | absent        | Known microfrontends. There is no default: the first open fills the key when it is missing. An empty object leaves the tree empty and does not scan. Discovery adds missing names and does not rewrite existing entries.                                                                                                                                                                                                             |

An app entry has:

- `path`: app directory relative to the workspace folder, such as `apps/shell`. An absolute path or a path that leaves that folder is ignored.
- `workspaceFolder`: workspace-folder name in a multi-root workspace. Discovery writes it. Without it, a known app is looked up by name in every open folder.
- `manifestPath`: manifest path on the dev server. Empty or missing means `/mf-manifest.json`.
- `scripts.start`: script key for this app only. When the field is missing, **Start** uses `mf-dashboard.scripts.start`. Discovery sets `dev` on a new entry.

**Refresh** shows these names plus the URLs in `mf-dashboard.extraManifestUrls`. A custom `path` or `scripts.start` survives the next search.

## Placeholders

Brace tokens are replaced before the command runs. Each value is inserted as one quoted shell word, so a name or path cannot start another command. An unknown name stays in the string, braces included. A token that command does not receive also stays. An empty port becomes an empty quoted word.

| Token           | Value                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{folder}`      | Absolute app directory.                                                                                                                                                              |
| `{name}`        | Federation name. For a download, the consumer name.                                                                                                                                  |
| `{port}`        | Local port as a decimal string, or an empty string when there is no port.                                                                                                            |
| `{tsconfig}`    | `tsConfigPath` from the config, or an empty string.                                                                                                                                  |
| `{typesFolder}` | Absolute types directory for this link: `<consumer>/<typesFolder>/<alias>`. For `shell`, alias `widget`, and types folder `@mf-types`, that is `<root>/apps/shell/@mf-types/widget`. |

`mf-dashboard.commands.rebuildTypes` receives `{folder}`, `{name}`, `{port}`, and `{tsconfig}`. `mf-dashboard.commands.refetchTypes` receives all five. The command runs in the app directory.

## Limits

**Start** runs the script of one stopped app from `mf-dashboard.apps`. Apps outside that list are left alone.

The extension does not open a browser tab or the VS Code simple browser. A script that passes a flag such as `--open` may still open one itself.
