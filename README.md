# schema-lens

A desktop ERD explorer for [DBML](https://dbml.dbdiagram.io/) schemas, built with Electron.

schema-lens renders your whole schema as one readable diagram — relationships are
classified by meaning, person-reference edges fold away instead of turning the graph
into spaghetti, and a dedicated focus mode lets you walk the schema one table at a time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/erd-dark.png">
  <img alt="Full ERD view: clustered table groups, semantic edge colors, hub folding, minimap" src="docs/erd-light.png">
</picture>

## Why

Auto-generated ERDs stop being useful at around 20 tables: every table references
`users`, every edge crosses every other edge, and the actual structure drowns.
schema-lens addresses this in three ways:

- **Semantic edge classification** — every foreign key is typed as one of eight
  relationship kinds (composition, ownership, request, authorship, sharing, mention,
  hierarchy, reference), inferred from column-name patterns, `ON DELETE` rules, and
  PK membership. Each type gets its own color and a one-sentence explanation on hover.
- **Hub folding** — when most inbound edges of a high-degree table are
  person-references (the `users` table in almost every schema), those edges are
  hidden by default and summarized as compact chips on each card. What remains
  visible is the structural skeleton. Folded hubs can be toggled back per hub.
- **Obstacle-aware edge routing** — every edge is routed on a grid through the
  corridors between tables (rounded orthogonal paths), never through them, and a
  minimap keeps you oriented.

## Features

**Full ERD view**
- Automatic layout clustered by `TableGroup` (elkjs layered algorithm)
- Solid lines for enforced FK constraints, dashed for logical (application-level) FKs
- Cardinality (`1:1` / `N:1` / `N:M`) shown on edge hover and in tooltips; junction tables detected and badged `N:M`
- Click = 1-hop highlight · double-click = focus mode · `0` = fit to screen · `Esc` = deselect
- Wheel = pan, `⌘`/`Ctrl` + wheel = zoom · drag tables, or drag a group hull to move the whole cluster
- Layout edits persist per file (`View > Reset Layout` to discard)
- Minimap with viewport indicator — click or drag it to jump

**Focus mode**
- Three-column view of a single table: referencing tables on the left (the N side),
  the focused table in the middle, referenced parents on the right (the 1 side)
- Click any neighbor to refocus; navigation history with back button

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/focus-dark.png">
  <img alt="Focus mode: three-column navigation around a single table" src="docs/focus-light.png">
</picture>

**Editing workflow**
- Open via `⌘`/`Ctrl`+`O`, drag & drop, or CLI argument; the last file is restored on launch
- The open file is watched — edits re-parse and re-render automatically
  (survives editors that replace the file on save)
- Light and dark themes; the full palette is contrast-checked (WCAG AA) in both

## Getting started

```bash
npm install
npm start                       # restores the last opened file
npm start assets/example.dbml   # bundled example: a fictional code-collaboration platform
```

`npm test` runs the parser/semantics test suite against the bundled example schema
plus inline regression fixtures. `npm run test:contrast` re-verifies palette contrast.

## DBML conventions (optional)

Standard DBML works out of the box. A few conventions make the diagram more precise:

- **Logical FKs** — a trailing `// logical` comment on the line that declares a `Ref`
  marks it as an application-enforced relationship with no database constraint; it
  renders dashed. Works with inline refs (`[ref: > users.id] // logical`), composite
  refs (`a.(x, y) > b.(x, y)`), table aliases, quoted identifiers, and `public.`
  prefixes. Commented-out refs, block comments, and ref-shaped text inside `note`
  strings are ignored.
- **Edge labels** — a short leading phrase in a column note
  (e.g. `note: 'assignee → users.id'`) is extracted as the relationship label shown
  in tooltips and focus mode. Version/constraint meta tokens are stripped automatically.
- **Clustering** — `TableGroup` drives ERD clusters, group colors, and the sidebar.

## Screenshot CLI

Renders, captures, and exits without interaction — useful for visual regression checks:

```bash
npx electron . <file> --screenshot out.png [--focus TABLE] [--theme light|dark]
```

On parse failure it captures the error screen and exits with code 2. `--focus` and
`--theme` apply to that run only; they don't touch saved preferences.

## Architecture

| Path | Role |
| --- | --- |
| `src/parse.js` | `@dbml/core` parsing plus a raw-text prepass that collects `// logical` markers (the parser itself discards comments). Emits a plain JSON model. |
| `src/semantics.js` | Dependency-free UMD module: relationship typing, cardinality, junction and hub heuristics. Shared by the Node test suite and the renderer. |
| `renderer/erd.js` | elkjs layout, SVG rendering, viewport, obstacle-aware edge routing, minimap. |
| `renderer/focus.js` | Three-column focus navigation. |
| `renderer/app.js` | App state, shell, theming. |
| `renderer/style.css` | Design tokens (single source of truth for both themes). |

## Notes

- UI copy is currently in Korean.
