# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript VS Code extension. Source files live in `src/` and compile to `out/`; treat `out/` as generated output. The entry point is `src/extension.ts`. Domain models are in `src/domain/`, command orchestration in `src/application/`, UI providers and panels in `src/presentation/`, and persistence/API/auth code in `src/infrastructure/`. Tests live in `src/test/`; extension assets live in `resources/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run compile`: run `tsc -p ./` and emit JavaScript into `out/`.
- `npm run watch`: run TypeScript in watch mode.
- `npm run lint`: lint `src/**/*.ts` with ESLint.
- `npm test`: compile, lint, then run VS Code extension tests through `vscode-test`.
- `npx @vscode/vsce package`: create a `.vsix` package for local distribution.

For manual testing, press `F5` in VS Code to launch the Extension Development Host.

## Coding Style & Naming Conventions

Use strict TypeScript with ES2022 and Node16 module semantics. Prefer explicit return types on exported functions. Follow existing indentation, keep semicolons, and use single-quoted strings in TypeScript. Classes and tree items use `PascalCase`, variables/functions use `camelCase`, command IDs use `surf-account-manager.*`, and settings use `surfAccountManager.*`. Run `npm run lint` before submitting changes.

## Testing Guidelines

Tests use Mocha-style `suite` and `test` blocks through `@vscode/test-cli`. Add tests under `src/test/` with the `*.test.ts` suffix so they compile to `out/test/**/*.test.js`. Prefer focused tests for store logic, command argument handling, and UI provider behavior.

## Commit & Pull Request Guidelines

There are no commits on `main` yet, so use a simple Conventional Commits style going forward, such as `feat: add account grouping` or `fix: handle proxy refresh failure`. Keep commit messages imperative and scoped to one change.

Pull requests should include a short description, linked issue if available, commands run, and screenshots or GIFs for visible Tree View, status bar, or webview changes. Note any proxy behavior reviewers must reproduce.

## Security & Configuration Tips

Do not commit account credentials, tokens, generated `.vsix` files, or local VS Code state. Proxy configuration belongs in the `surfAccountManager.proxy` setting or `HTTPS_PROXY` environment variable.
