# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Surf Account Manager is a VS Code extension for managing Surf / Windsurf accounts. It supports batch account import, account login/activation, quota refresh, account sorting, account export, and account deletion from the Activity Bar webview tab.

The extension is written in TypeScript, compiled from `src/` to `out/`, and VS Code loads `./out/extension.js` as configured in `package.json`.

## Common Commands

- Install dependencies: `npm install`
- Compile once: `npm run compile`
- Compile in watch mode: `npm run watch`
- Lint source: `npm run lint`
- Package `.vsix`: `npm run package`
- Debug extension manually: open the repo in VS Code and press `F5` to launch the Extension Development Host. The launch config runs the default build task, which is `npm run watch`.

There is currently no `npm test` script or single-test command configured in `package.json`. Do not claim automated tests were run unless a test runner/script has been added or invoked through VS Code extension testing.

## Release Workflow

`.github/workflows/release.yml` runs on pushes to `main` unless the commit message contains `[skip release]`. It installs with `npm ci`, runs `npm run compile` and `npm run lint`, bumps the version, packages the extension, commits the version bump, tags it, and creates a GitHub release.

Release bump selection is based on commit messages:

- `[release:major]`, `[release:minor]`, or `[release:patch]` explicitly selects the bump.
- `BREAKING CHANGE` or a conventional commit with `!` triggers major.
- `feat:` triggers minor.
- `fix:` or `perf:` triggers patch.

## Architecture

### Activation and Wiring

`src/extension.ts` is the activation entrypoint. It creates the `Surf Account Manager` output channel, wires API/auth loggers, syncs proxy settings, creates the shared `AccountStore`, registers the `surfAccounts` webview provider, starts auto-refresh, and delegates internal command registration to `registerCommands`.

Configuration contributed by `package.json`:

- `surfAccountManager.proxy`: explicit HTTP/HTTPS proxy. If empty, the API layer can still use `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, or `http_proxy` environment variables.
- `surfAccountManager.autoRefreshIntervalMinutes`: periodic quota refresh interval. `0` disables auto-refresh.

### Domain and Persistence

`src/domain/account.ts` defines the main `ManagedAccount` model and batch-add result/input types.

`src/infrastructure/accountStore.ts` owns account state and persistence. It stores accounts and the current account ID in VS Code `globalState` under:

- `surf-account-manager.accounts`
- `surf-account-manager.currentAccountId`

The store is the central mutation point for adding accounts, batch import, switching, deleting, and quota refresh. It emits `onDidChange` after saves; presentation components subscribe to that event and re-render from the store.

### Windsurf API and Login Activation

`src/infrastructure/windsurfApi.ts` handles remote login and quota/status requests. It implements direct and proxied HTTP(S) requests, including CONNECT tunneling for HTTPS over proxy. Main flows:

1. `loginWithPassword(email, password)` authenticates with Windsurf endpoints and builds a `ManagedAccount`.
2. `refreshAccountQuota(account)` refreshes quota/status data for an existing account.
3. Response normalization fills plan, quota, usage, reset, and error-related fields on `ManagedAccount`.

`src/infrastructure/windsurfAuth.ts` activates a selected account locally by writing Windsurf auth files into the platform-specific Windsurf `globalStorage` path and by trying relevant Windsurf/Cascade VS Code auth/token commands.

### Commands and User Actions

`src/application/registerCommands.ts` registers internal commands used by the webview. These commands are intentionally not contributed to `package.json`, so user-facing operations happen from the `账号列表` tab rather than the Command Palette, view title actions, context menus, or status bar.

Internal command IDs currently used by the webview:

- `surf-account-manager.batchAdd`
- `surf-account-manager.loginAccount`
- `surf-account-manager.refreshAccount`
- `surf-account-manager.refreshAll`
- `surf-account-manager.deleteAccount`
- `surf-account-manager.deleteAll`
- `surf-account-manager.exportAll`

Single-account internal commands expect the webview to pass an account ID. Do not add `showQuickPick` fallbacks unless command-palette or context-menu entry points are reintroduced.

### Presentation Layer

`src/presentation/accountListViewProvider.ts` provides the `surfAccounts` webview view. It renders the account tab, top toolbar actions, account cards, quota progress rows, plan expiry warnings, and forwards webview messages to internal VS Code commands. Keep webview data derived from `ManagedAccount` compact and serializable.

`src/presentation/batchAddPanel.ts` provides the add-account webview panel for single-account and batch imports. It parses pasted JSON or delimited text and calls the store’s add/batch-add methods.

There is no separate account tree provider or current-account status bar. Account display and operations are centralized in the webview tab.

## Development Notes

- Prefer changing source under `src/`; `out/` is compiled output.
- If UI behavior changes, verify it in the Extension Development Host rather than relying only on TypeScript compilation.
- Keep internal command IDs and webview message command names in sync between `registerCommands.ts` and `accountListViewProvider.ts`.
- Package contributions in `package.json` should stay limited to the Activity Bar container, `surfAccounts` webview, and configuration unless user-facing shortcuts are intentionally reintroduced.
- The extension stores account passwords and auth tokens in VS Code global state and writes auth files for Windsurf login activation, so avoid expanding export/logging behavior to include more credential material than existing flows require.
