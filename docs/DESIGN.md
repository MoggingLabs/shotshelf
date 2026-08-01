# Shotshelf design system

The standard every visual value in the app comes from. `src/styles.css` is the
single stylesheet; `scripts/check-design.mjs` holds it to the scales below on
every gate run, so a value that is not on a scale fails the build rather than
shipping as drift. Change a scale here and the stylesheet in the same commit,
on purpose — that is the entire process.

## Principles

1. **The picture is the interface.** A capture's pixels are why the shelf
   exists; chrome earns its place on hover or not at all. Nothing decorates a
   card at rest except identity (a recording's badge) and safety (the
   credential marker).
2. **Quiet by default, loud when it matters.** The peek never takes focus, the
   alert strip exists only while something needs saying, warnings inform and
   never block.
3. **Native, not webby.** Arrow cursor on controls, no pointer hands, panel
   radius agreeing with the OS (DWM's fixed 8px on Windows, 14px under macOS
   vibrancy), system font stack, tray-first lifecycle.
4. **One owner per decision.** Whether a message shows is `status.ts`'s
   decision, expressed once; the stylesheet never restates it. The same rule
   produced the design gate: consistency owned by a script, not by memory.

## Type scale

Four whole-pixel steps. Fractional sizes (the file used to carry 9.5px and
10.5px) rasterise differently across the 100%–200% DPI factors this app runs
at. Roles pick the step, never taste:

| Token | Size | Role |
| :-- | :-- | :-- |
| `--font-xs` | 10px | Micro badges: duration pill, credential marker, day labels (uppercase + tracking carry the hierarchy) |
| `--font-sm` | 11px | Captions and compact controls: tile label, hints, alert strip, editor toolbar, Edit/Compare |
| `--font-md` | 12px | The title strip and forms: window title, settings rows and inputs |
| `--font-lg` | 13px | Body: base size, empty-state title |

Weight does hierarchy inside a step: 600 for anything that names or acts, 400
for prose, 700 only for the single-glyph `?` marker. Multi-line text takes
`--leading` (1.45); single-line UI text takes the default.

## Spacing

A 4px grid, with 2px half-steps allowed below 8 for micro-padding inside
pills. Legal values: **2, 4, 6, 8, 12, 16, 20, 24** (and multiples of 4
above). The card gap and column padding are mirrored in
`src/shelf/geometry.ts` — `CARD_GAP` 8, `COLUMN_PADDING` 26 (12 per edge plus
the 1px panel border) — and the mirror is load-bearing: the popup column is a
window sized from those constants, and `tests/visual/layout.spec.ts` fails if
the two sides move apart.

## Radii

| Token | Value | Where |
| :-- | :-- | :-- |
| `--radius` | 14px / 8px on Windows | The panel. Windows is pinned to DWM's flyout radius — disagreeing shows the acrylic as a pale wedge in each corner |
| `--radius-lg` | 12px | Large decorative frames (the empty state) |
| `--radius-card` | 8px | Capture tiles |
| `--radius-ctl` | 6px | Buttons, inputs, markers |
| `--radius-pill` | 999px | Count- and duration-shaped things |
| `50%` | — | Dots: the watching mark, the unscanned marker |

## Control sizes and hit targets

**Nothing interactive is smaller than 24×24px** — the WCAG 2.5.8 minimum. The
tile actions were 21px and are now `--ctl-tile` (24); title-strip buttons are
`--ctl-bar` (28) inside the 40px bar; settings inputs carry `min-height: 24px`.

## Icons

One set, `src/icons.ts`: 24×24 stroke paths at stroke-width 1.7, inheriting
`currentColor`. Rendered sizes come off a five-step scale — **10** inside a
pill, **12** in a micro marker, **14** in a 24px control, **16** in a 28px
control, **24** on a card face. Callers used to pick 9, 11, 13, 14, 22 and 26
by eye.

## Motion

Two durations, both `ease-out`: `--motion-fast` (100ms) for feedback — hover,
press, reveal-on-hover — and `--motion-state` (160ms) for state, the watching
dot. Motion is never the only signal, which is what lets the global
`prefers-reduced-motion` rule flatten everything wholesale.

## Palette

Semantic tokens only; `check-design.mjs` refuses a colour literal outside
`:root`. The groups:

- **Surfaces**: `--panel` (tinted acrylic/vibrancy), `--raised`/`--raised-hover`
  (controls), `--overlay` (editor, quick look), `--surface-deep` (canvas),
  three neutral **scrims** for text over photographs.
- **Strokes**: three strengths of white alpha (0.09 / 0.16 / 0.26).
- **Text**: `--text`, `--muted` (5.6:1 on the panel — AA for its 11px+ uses),
  `--text-on-media` over scrims only.
- **Roles**: `--accent` (selection, primary action, focus ring), `--live`
  (watching), `--warning` (pinned state, credential rims), `--danger` for
  fills with `--danger-soft` for text — #ef4444 on the panel is 3.9:1, below
  AA, so text never uses it.
- **Credential badges by kind**: amber for tokens, crimson for a private key,
  stone for personal data, dim stone for "could not check". The distinction is
  severity communicated without words.

## Hierarchy of a card

Bottom to top: wash (blurred self, 0.5 opacity) → picture → label gradient
(hover) → duration badge (rest) → actions (hover, top-right) → credential
marker (always, top-left, the one thing never covered). Actions order: pin
(state), copy, show-in-folder, remove (destructive last).

## Accessibility policy

- Every control shows `:focus-visible` (2px accent ring) — the app ships a
  keyboard map, so focus must be visible everywhere it can land.
- Icon-only buttons carry `aria-label` equal to their tooltip; the pin also
  reports `aria-pressed`. Icons themselves are `aria-hidden`.
- Global reduced-motion flattening; no information is motion-only.
- Hit targets ≥ 24px throughout.
- Text contrast ≥ AA against its actual background (see palette notes).

## Feature inventory — what each one is for

Every shipped feature, the job it does, and where its gate lives. A feature
that cannot say what job it does gets removed before it gets polished.

| Feature | The job | Gate |
| :-- | :-- | :-- |
| Catch (folders + clipboard) | The product: a capture is on the shelf before the folder opens | Rust watchers' tests; run live on Windows (`docs/PARITY.md`) |
| Peek column | Grab it *now*, without the shelf stealing focus | `tests/e2e/popover.spec.ts` |
| Drag-out (multi-select, ordered) | The file lands where work happens; copy, never move | e2e drag specs; live drag on Windows |
| Copy | Apps that paste but refuse drops | e2e + live |
| Show in folder | The file itself is the product; this is the shortest path to it | e2e + the IPC scope-refusal test |
| Pin / retention / item cap | The shelf stays a shelf, not an archive | unit + e2e sweeps |
| Poster frames, duration, size | A recording is a file until you can see into it | Rust poster tests, e2e |
| OCR + credential warning | The last moment a token is only on your machine | Rust `secrets.rs` table, e2e, live OCR on Windows |
| Editor (5 tools, real redaction) | Point at the thing without a second app; redaction that removes pixels | `tests/e2e/editor.spec.ts` |
| Compare | The unit of iteration when working against a model | e2e compare specs |
| Quick look | Read the capture without opening an app | e2e + window-resize specs |
| Keyboard map | The shelf is summoned by key; acting on it should not need the mouse | `tests/e2e/keyboard.spec.ts` |
| Backfill | A reboot must not cost the morning's captures | Rust + e2e |
| Update check | The one network call; tells, never installs | Rust wiring + live failure path |

## Evaluated and deliberately not built

Each considered against the field (Dropover, CleanShot, ShareX) and declined
with a reason — so the next person weighs the reason, not the absence:

- **Drag *into* the shelf to hold arbitrary files** — Dropover's model.
  Shotshelf's wedge is *auto-catch*; a general basket dilutes the one job and
  doubles the surface (arbitrary paths in scope, foreign file types).
- **Open in default app on double-click** — Quick Look (Space) covers "see
  it", Show-in-folder covers "get to it"; double-click sits one ambiguity away
  from single-click-to-pick. Revisit if users ask.
- **Search / filter** — at a 50-item cap with day grouping, scanning beats
  querying. Search earns its place only if the cap ever grows an order of
  magnitude.
- **Rename / delete on disk** — breaks the invariant the whole app is built
  on: the capture file is never modified, moved or deleted.
- **Start at login** — an app that adds itself to startup unasked is a bad
  neighbour. Belongs as an explicit setting someday; documented manual steps
  until then.
- **A keyboard shortcut for Show-in-folder** — the map already covers pick,
  preview, copy, edit, remove; one more binding needs evidence it is reached
  for. Candidate: `o`.

## Regenerating the appearance goldens

The pixel goldens under `tests/visual/` are Linux-rendered. Any change to this
system invalidates all ten: run the **Appearance goldens** workflow, look at
the images, and commit them in the same PR as the change that moved them.
