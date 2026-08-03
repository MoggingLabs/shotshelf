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
   vibrancy), system font stack, tray-first lifecycle. The one cursor that is
   not an arrow is `grab`/`grabbing` on a card: the hand-that-grabs is the
   native drag affordance, not the web's link hand, and drag-out is the thing
   the shelf exists for — the affordance rule suppresses decoration, never
   the product.
4. **One owner per decision.** Whether a message shows is `status.ts`'s
   decision, expressed once; the stylesheet never restates it. The same rule
   produced the design gate: consistency owned by a script, not by memory.

## Type scale

Five whole-pixel steps. Fractional sizes (the file used to carry 9.5px and
10.5px) rasterise differently across the 100%–200% DPI factors this app runs
at. Roles pick the step, never taste:

| Token | Size | Role |
| :-- | :-- | :-- |
| `--font-xs` | 10px | Micro badges: duration pill, credential marker, day labels (uppercase + tracking carry the hierarchy) |
| `--font-sm` | 11px | Captions and compact controls: tile label, hints, alert strip, editor toolbar, Edit/Compare |
| `--font-md` | 12px | The title strip and forms: window title, settings rows and inputs |
| `--font-lg` | 13px | Body: base size, empty-state title |
| `--font-xl` | 16px | The settings window's section titles — the one step a 720px window needs that the 225px popover never did |

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
The watching dot stays an 8px dot visually but sits inside a 24px focusable
button, so its tooltip — the app's primary diagnostic — is reachable by
keyboard and by imprecise pointing alike.

**Documented exception: the scrollbar.** A 24px scrollbar inside a 225px panel
would spend a tenth of the window on chrome. The gutter is 12px with an 8px
visible thumb — under the minimum, deliberately, because the wheel, the arrow
keys and PageUp/Down all scroll the same list.

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

The *window* moves on the same clock: every shape change — the fitted shelf
taking or losing a card, the column growing, the popup becoming the browse
view — glides over 160ms of ease-out in `window.rs`, corner-anchored on every
frame, and jumps instantly when the window was hidden. One stated limit: the
OS reduced-motion preference is not portably readable from Rust, so the glide
stays a single beat rather than honouring the flag — short enough not to be a
journey, and written down here rather than hidden.

The browse window is also the one shape a hand may resize. The drag itself is
the frameless window's invisible edge (tao's), so the affordance is drawn, not
built: a six-dot diagonal grip in the bottom-right corner — dots on a 4px
pitch in a 12px box, 4px off the corner, `--stroke-heavy` so it reads as
chrome rather than content — `pointer-events: none`, browse mode only, and
revealed on hover at `--motion-fast` like the card controls. Hover-revealed
for the same reason they are: that corner is somebody's screenshot, and six
permanent dots on it read as dirt on the picture rather than as chrome. The
dragged width applies whenever the shelf is summoned; the dragged height is
the *ceiling* on the adaptive fit, so a snug window stays snug. Floors are
Rust's: stock width, one readable card of height. The column and the quick
look are sized by their content and show no grip. There is no snap-back
mid-gesture — the window stays where the hand left it, and the next capture
or reopen reconciles through the normal fit.

## Palette

Semantic tokens only; `check-design.mjs` refuses a colour literal outside
`:root`. Two themes: dark is the base `:root`, light is a
`:root[data-theme="light"]` override block, and `src/theme.ts` stamps
`data-theme` from the setting — "system" follows `prefers-color-scheme`
live. (The "no light theme" stance is retired: it dated from when the whole
UI was a 225px acrylic popover, and a real settings window on a light
desktop looked like a hole in it.) The light block overrides exactly the
tokens whose value is a theme decision:

| Token | Dark | Light | Why the light value |
| :-- | :-- | :-- | :-- |
| `--window` | `#14161e` | `#f4f5f8` | The solid window surface |
| `--panel` | white-on-dark tint | `rgba(248,249,252,.94)` | Same acrylic trick, inverted |
| `--raised` / strokes | white alphas | black alphas | Same three strengths |
| `--text` / `--muted` | `#e9ebf0` / `#8b91a1` | `#1a1d26` / `#5c6270` | 15.4:1 and 5.6:1 on `--window` |
| `--accent-text` | `#7275f4` | `#4f46e5` | Links: 5.8:1 on light |
| `--danger-soft` | `#fca5a5` | `#b91c1c` | Failure text: 5.9:1 on light |
| `--live` | `#34d399` | `#059669` | The dot held only 1.7:1 on light |

Beyond the stock pair, six named palettes ship as further
`:root[data-theme="…"]` blocks — Solarized Light/Dark, Nord, Dracula,
Gruvbox Dark, Catppuccin Mocha — each overriding the same token set under
the same AA bars, with any canonical colour that missed the bar nudged and
the nudge noted in the block. The spellings are joined three ways: Rust's
`THEMES`, the settings dropdown's options, and the blocks themselves, with
an e2e painting every one.

What deliberately does **not** change: everything that answers to a
*photograph* rather than a theme surface — the scrims, `--text-on-media`,
the credential badges — and the role **fills** with their audited
`--ink-on-fill`. `--accent-text` exists because no single indigo can be both
a fill carrying dark ink (needs to be light) and text on a light surface
(needs to be dark); 4.5:1 against both is arithmetically impossible.

The groups:

- **Surfaces**: `--panel` (tinted acrylic/vibrancy), `--raised`/`--raised-hover`
  (controls), `--overlay` (editor, quick look), `--surface-deep` (canvas),
  three neutral **scrims** for text over photographs.
- **Strokes**: three strengths of white alpha (0.09 / 0.16 / 0.26).
- **Text**: `--text`, `--muted` (5.6:1 on the panel — AA at every size it is
  used at, including the 10px day labels at 5.7:1), `--text-on-media` over
  scrims only, and `--ink-on-fill` — near-black ink for glyphs and labels
  sitting **on** a role-coloured fill. White on the amber pin was 2.15:1 and
  on the green copy receipt 1.92:1; the ink is ≥4.5:1 on every role fill, so
  a state colour never erases the glyph that names it.
- **Roles**: `--accent` (selection, primary action, focus ring), `--live`
  (watching), `--warning` (pinned state, credential rims), `--danger` for
  fills with `--danger-soft` for text — #ef4444 on the panel is 3.9:1, below
  AA, so text never uses it.
- **Composited badges answer for their worst background.** The credential and
  unscanned badges float over 8% of an arbitrary screenshot, so their alphas
  are 0.98 — high enough that a white capture cannot pull the badge below AA.
- **Credential badges by kind**: amber for tokens, crimson for a private key,
  stone for personal data, dim stone for "could not check". The distinction is
  severity communicated without words.

## The settings window

The one place the app asks the user for anything, and the only decorated
window. Its grid, all on the spacing scale: a 168px sidebar of 32px
min-height tabs; a content pane padded 24 with one section on screen;
rows of `label + control` separated by hairline `--stroke` borders, the
label a `--font-md` 600 line with an optional `--font-sm` muted hint under
it. Section titles are the type scale's `--font-xl` (the step that exists
for this window alone); group subtitles are uppercase `--font-xs`. Controls
right-align at 168px wide × 28px high (`--ctl-bar`), the number field
narrowed to 80.

The control vocabulary, chosen per setting rather than defaulted: a
segmented control for the theme (three named states, all visible), a 2×2
corner picker because the setting *is* spatial, a press-to-record button
for the hotkey (shown in the OS's spelling; the wire keeps
`CommandOrControl`), and the themed dropdown (`src/ui/select.ts`) for real
enumerations. No native `<select>` and no native `title` tooltip appears
anywhere in the app — `src/ui/tooltip.ts` answers `data-tip` with a themed
bubble (500ms hover delay, instant on focus, Escape dismisses without being
consumed), and the accessible name always lives on `aria-label`, never on
the tip.

## Hierarchy of a card

Bottom to top: wash (blurred self, 0.5 opacity) → picture → label gradient
(hover) → duration badge (rest) → actions (hover, top-right) → credential
marker (always, top-left, the one thing never covered). Actions order: pin
(state), copy, show-in-folder, remove, delete (most destructive outermost —
and delete is the one act here that touches the file, which its tip says
before the click lands and its Undo toast can take back after).

The corner grammar, stated once: **top-left** is safety (credential marker or
the unscanned `?`, mutually exclusive, never covered), **top-right** is action
(the hover cluster — and at rest on a pinned card, the star alone, its hidden
siblings collapsed to zero width so the state anchors the corner it was set
in), **bottom-left** is identity (the duration badge at rest, yielding to the
label gradient on hover). A state indicator lives where its control is — the
pinned star *is* the pin button — and no state may erase another: picked,
hover and the credential rim compose in one declared rule rather than
competing by specificity.

Selection carries two treatments: every picked card gets the 2px inset accent
ring, and in a multi-pick the **keyboard cursor** — the card the arrows move
from — additionally carries a 1px outer accent halo, so a range never loses
the point the user is standing on.

## Accessibility policy

- Every control shows `:focus-visible` (2px accent ring) — the app ships a
  keyboard map, so focus must be visible everywhere it can land.
- Focus must also be *usable* where it lands: the global keydown handler
  yields Enter and Space to whatever focusable control has focus, so tabbing
  to Hide and pressing Enter hides rather than copying.
- Icon-only buttons carry `aria-label` equal to their tooltip; the pin
  reports `aria-pressed`, and so do the editor's tool buttons. Icons
  themselves are `aria-hidden`; glyph-only thumbnails (a recording's film
  frame, a missing file) carry `sr-only` text.
- The two message surfaces are live regions: `#shelf-alert` is `role="status"`
  and `#settings-note` is `role="alert"` — a message nobody can hear is not a
  message.
- Global reduced-motion flattening; no information is motion-only.
- Hit targets ≥ 24px throughout (one documented exception: the scrollbar).
- Text contrast ≥ AA against its actual background (see palette notes) —
  including composited backgrounds: a badge over a screenshot answers for the
  whitest capture it can sit on.
- Tooltip micro-copy convention: control tooltips are label phrases with no
  terminal period ("Mark up this capture (E)"), informational tooltips are
  full-stopped sentences. Controls with a keyboard accelerator name it in
  parentheses at the end.
- **Stated limitation:** drawing in the editor is pointer-only. The tools,
  Undo and Save are keyboard-reachable, but placing a mark needs a pointer;
  an accessible marking flow is future work, recorded here rather than
  implied absent.

## Feature inventory — what each one is for

Every shipped feature, the job it does, and where its gate lives. A feature
that cannot say what job it does gets removed before it gets polished.

| Feature | The job | Gate |
| :-- | :-- | :-- |
| Catch (folders + clipboard) | The product: a capture is on the shelf before the folder opens | Rust watchers' tests; run live on Windows (`docs/PARITY.md`) |
| Peek column | Grab it *now*, without the shelf stealing focus | `tests/e2e/popover.spec.ts` |
| Drag-out (multi-select, ordered) | The file lands where work happens; copy, never move. The ghost under the cursor is bounded to `GHOST_EDGE` and shows the capture (a recording's poster when cached) — the original-file ghost covered half the screen | e2e drag specs; live drag on Windows; the ghost bound is unit-tested in `src-tauri/src/imaging/export.rs` |
| Copy | Apps that paste but refuse drops | e2e + live |
| Show in folder | The file itself is the product; this is the shortest path to it (tile control, `o`, and the tray's Open the screenshots folder) | e2e + the IPC scope-refusal test |
| Pin / retention / item cap | The shelf stays a shelf, not an archive | unit + e2e sweeps |
| Copy recognised text | The error text in a screenshot, into a chat, without retyping — the OCR the credential scan already runs, finally answering the keyboard | e2e + the IPC scope-refusal test; the text never crosses the wire |
| Start at login | The product is being there when the capture lands; a reboot must not turn it off | settings e2e + IPC tolerance test; roams with the account |
| Corner / monitor choice | A corner widget on the wrong corner is furniture in the way | `corner_origin` unit table + settings e2e + live re-place on save |
| Poster frames, duration, size | A recording is a file until you can see into it | Rust poster tests, e2e |
| OCR + credential warning | The last moment a token is only on your machine | Rust `secrets.rs` table, e2e, live OCR on Windows |
| Editor (5 tools, real redaction) | Point at the thing without a second app; redaction that removes pixels | `tests/e2e/editor.spec.ts` |
| Compare | The unit of iteration when working against a model | e2e compare specs |
| Quick look | Read the capture without opening an app | e2e + window-resize specs |
| Keyboard map | The shelf is summoned by key; acting on it should not need the mouse — incl. `t` copy-text, `p` pin, `o` show-in-folder, shelf-level `Ctrl+Z`, receipts for every key, and a guard sentence when nothing is picked. Taught in-app: tooltips name their keys, the settings footer lists the map, the empty state names the hotkey | `tests/e2e/keyboard.spec.ts` |
| Removal undo | A shift-range of eight vanished on one keypress with nothing said; now the receipt names the batch and `Ctrl+Z` brings it back — session-scoped, and restored captures rejoin the cap and retention like new arrivals | `tests/e2e/keyboard.spec.ts` |
| Backfill | A reboot must not cost the morning's captures | Rust + e2e |
| Update check | The one network call — a static manifest off this repo's Releases; tells, never installs | Rust wiring + live failure path |

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
- ~~Start at login~~ and ~~a keyboard key for Show-in-folder~~ — both were on
  this list and both shipped on 2026-08-01 when the owner asked, which is
  exactly the evidence the list said it was waiting for.

## Regenerating the appearance goldens

The pixel goldens under `tests/visual/` are Linux-rendered. Any change to this
system invalidates all fifteen: run the **Appearance goldens** workflow, look
at the images, and commit them in the same PR as the change that moved them.
Five of the fifteen picture *composed* states — pinned-at-rest,
pinned+secret, picked-under-hover, secret+picked, multi-pick-with-cursor —
because the 2026-08-02 audit's worst finds were compositions losing to
specificity, which is exactly the rot no single-state golden can catch.

For everything the goldens do not enforce, the **State atlas** workflow (or
`npm run atlas` locally) photographs every reachable UI state — about fifty
screenshots, assertion-free, for a person to read. That is the audit tool:
the next visual audit starts from a complete picture set instead of an
afternoon of harness reconstruction.
