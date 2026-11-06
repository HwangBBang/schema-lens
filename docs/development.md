# Development

This page is for people who build, test, or release schema-lens. To install the app, see
the [README](../README.md#install).

Every npm script except `npm run typecheck` builds the source first, so it always runs the
current code. `typecheck` reads the TypeScript source directly and needs no build.

## Commands

| Command | What it does |
|---|---|
| `npm start [file]` | Builds and opens the app. Without a file, it restores the last opened file. |
| `npm run typecheck` | Runs `tsc --noEmit`. |
| `npm test` | Runs the parser and semantics tests against `assets/example.dbml` and inline regression fixtures. |
| `npm run test:contrast` | Reads the color tokens in `renderer/style.css` and checks the color pairs listed in `scripts/check-contrast.ts` against WCAG AA in both themes. Run it after changing a color token. |
| `npm run pack` | Builds an unpacked macOS app into `dist/` for a quick check. |
| `npm run dist` | Builds the macOS DMG and ZIP (universal) into `dist/` with electron-builder. |

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow stops if the tag does
not match the `version` in `package.json`. Otherwise it runs the tests, builds the DMG and
ZIP, and uploads them to a draft GitHub release.

Publish the draft that the workflow created. If you create a new release from the tag
instead, the published release has no assets.

The app is not code-signed (`"identity": null` in `package.json`), so the workflow has no
signing or notarization step. The [install guide](INSTALL.md) explains what this means
for users.

## npm package

The npm package has not been published to the registry yet. Once it is, `npx schema-lens
[file]` will download Electron (about 130 MB) on first run and open the app.

`npm run npm:build` assembles the package into `dist-npm/`, and `npm run npm:publish`
builds and publishes it. The package is staged in a separate directory, rather than
published from the repository root, for two reasons:

- electron-builder refuses to build when `electron` is a production dependency, but the
  npm package needs `electron` as exactly that.
- Without an `.npmignore`, npm falls back to `.gitignore`. It would then drop build output
  that the app needs (`renderer/bundle.js`) and ship screenshots that it does not.

The list of files in the package is at the top of `scripts/build-npm.mjs`.

An app started from the npm package runs inside Electron's own bundle, so macOS shows
"Electron" as the app name in the menu bar. The DMG build shows "schema-lens".

## Screenshot CLI

The app can render a schema, save a screenshot, and exit without any interaction. This is
useful for visual regression checks.

`npx electron .` starts the built files in `out/` and does not build them. Run
`npm run build` after every source change. Otherwise the screenshot comes from the old
build, and nothing warns you about it.

Without `--focus`, `--diff`, or `--view`, the screenshot shows the full ERD view.

```bash
npx electron . <file> --screenshot out.png [--focus TABLE] [--theme light|dark] \
  [--side open|closed] [--layout group|lr|tb|grid] [--cols keys|all] [--impact] \
  [--peek TABLE] [--diff] [--view library|extract] [--tip TABLE.COLUMN] [--tip-hub TABLE:HUB]
```

If the schema fails to parse, the app captures the error screen and exits with code 2.

| Option | Effect |
|---|---|
| `--focus TABLE` | Opens focus mode on `TABLE`. |
| `--theme`, `--side` | Set the theme and the sidebar state for this run only. |
| `--layout` | Works like clicking the arrangement bar, so the chosen layout is saved for that file. |
| `--cols keys\|all` | Overrides the column display toggle (keys only or all columns) for this run, in both the full ERD view and focus mode. |
| `--impact` | Opens the delete impact view. |
| `--peek TABLE` | Expands the preview panel of the neighbor card `TABLE`. |
| `--diff` | Opens the compare view (last commit and working copy). Does not need `--focus`. |
| `--view library\|extract` | Opens the schema library or the SQL extraction screen. |
| `--tip TABLE.COLUMN` | Captures with the tooltip of that column open. |
| `--tip-hub TABLE:HUB` | Captures with the tooltip of that folded-hub chip open. |

The checks below make a broken target fail the run instead of producing a misleading image:

- `--impact` or `--peek` without `--focus` exits with code 1.
- `--peek` exits with code 2 if `TABLE` is not a neighbor of the focused table. If the
  target is hidden behind a collapsed "+N more" fold, the app expands the fold first.
- `--diff` exits with code 2 if there is no committed version to compare with (the file is
  outside a repository or was never committed).
- `--tip` and `--tip-hub` cannot be used together (exit code 1), and both work only in the
  full ERD view.
- `--tip` splits the table and column at the last dot, because table names can contain dots.
  If the column is hidden by the keys-only display, the run exits with code 2, so pass
  `--cols all` with it.

```bash
npx electron . assets/example.dbml --screenshot impact.png --focus repos --impact
npx electron . assets/example.dbml --screenshot peek.png --focus issues --peek comments
npx electron . path/to/schema.dbml --screenshot diff.png --diff
```
