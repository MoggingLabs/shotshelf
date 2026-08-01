// The stylesheet must stay on the scales `docs/DESIGN.md` sets.
//
// The design system is a standard, and a standard nobody checks is a mood
// board. Before it existed `src/styles.css` had six font sizes with
// quarter-pixel steps, thirteen distinct spacing values and twenty-odd
// hard-coded colours — every one added locally, reasonably, and never
// compared with the file it was added to. This gate is what stops the drift
// from starting again: a new value either sits on a scale or changes the
// scale in `docs/DESIGN.md`, in the same commit, on purpose.
//
// Four rules, all mechanical:
//
//   A. `font-size` uses a type-scale token. There are four sizes; a fifth is
//      a decision, not a tweak.
//   B. Spacing (`margin`, `padding`, `gap`, offsets) sits on the 4px grid,
//      with 2px half-steps below 8. The grid is what makes unrelated screens
//      look related.
//   C. `border-radius` uses a radius token or `50%`. Radii are the most
//      recognisable of all the values — a one-off radius reads as a bug.
//   D. No colour literal outside `:root`. The palette is the single place
//      colour decisions live; `rgba(0, 0, 0, 0)` is exempt because a
//      transparent gradient stop is arithmetic, not a colour choice.
//
// Durations get the same treatment as colours for free: `transition` values
// must reference `var(--motion-…)`, with the reduced-motion override's
// `0.01ms` exempt — that literal *is* the reduced-motion mechanism.

import { readFileSync } from "node:fs";

const SHEET = "src/styles.css";

/** The 4px grid, 2px half-steps below 8, and 0. Larger steps stay multiples of 4. */
const onGrid = (px) => px === 0 || px === 2 || px === 6 || (px % 4 === 0 && px >= 4);

/** Hairline widths for strokes and the sr-only clip box. */
const HAIRLINES = new Set([1, 1.5]);

const source = readFileSync(SHEET, "utf8");

// Strip comments so prose about a bad value cannot fire the rules; keep line
// structure so reports can point somewhere.
const lines = source
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .split("\n");

// Everything inside `:root { … }` blocks is the palette itself.
const rootRanges = [];
{
  let depth = 0;
  let inRoot = false;
  let start = 0;
  lines.forEach((line, i) => {
    if (!inRoot && /^:root\b/.test(line.trim())) {
      inRoot = true;
      start = i;
    }
    if (inRoot) {
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth <= 0 && /\}/.test(line)) {
        rootRanges.push([start, i]);
        inRoot = false;
        depth = 0;
      }
    }
  });
}
const inRoot = (i) => rootRanges.some(([a, b]) => i >= a && i <= b);

const problems = [];
const counts = { fontSize: 0, spacing: 0, radius: 0, colour: 0, duration: 0 };

lines.forEach((line, i) => {
  if (inRoot(i)) return;
  const at = `${SHEET}:${i + 1}`;

  // ── A: font sizes come off the type scale ──
  for (const [, value] of line.matchAll(/font-size\s*:\s*([^;]+);/g)) {
    counts.fontSize += 1;
    if (!/^var\(--font-(?:xs|sm|md|lg)\)$/.test(value.trim())) {
      problems.push(`  ${at}: font-size is "${value.trim()}", not a --font-* token`);
    }
  }

  // ── B: spacing sits on the grid ──
  for (const [, prop, value] of line.matchAll(
    /(?<![-\w])(margin|padding|gap|row-gap|column-gap|top|right|bottom|left)\s*:\s*([^;]+);/g,
  )) {
    for (const [, px] of value.matchAll(/(-?[\d.]+)px/g)) {
      counts.spacing += 1;
      const n = Math.abs(Number(px));
      if (!onGrid(n) && !HAIRLINES.has(n)) {
        problems.push(`  ${at}: ${prop} uses ${px}px, which is off the 4px grid`);
      }
    }
  }

  // ── C: radii are tokens ──
  for (const [, value] of line.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
    counts.radius += 1;
    if (!/^(?:var\(--radius(?:-[a-z]+)?\)|50%)$/.test(value.trim())) {
      problems.push(`  ${at}: border-radius is "${value.trim()}", not a --radius token or 50%`);
    }
  }

  // ── D: colours live in the palette ──
  for (const [literal] of line.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
    counts.colour += 1;
    if (literal.replace(/\s/g, "") !== "rgba(0,0,0,0)") {
      problems.push(`  ${at}: colour literal ${literal} outside :root — add it to the palette`);
    }
  }

  // ── durations ride the motion tokens ──
  for (const [, value] of line.matchAll(/transition(?:-duration)?\s*:\s*([^;]+);/g)) {
    for (const [duration] of value.matchAll(/[\d.]+m?s/g)) {
      counts.duration += 1;
      if (duration !== "0.01ms") {
        problems.push(`  ${at}: duration ${duration} written out — use var(--motion-*)`);
      }
    }
  }
});

// A rule that matched nothing has rotted, not succeeded — the same trap
// check-references.mjs documents for a glob that contributes no references.
for (const [rule, count] of Object.entries(counts)) {
  if (count === 0) {
    problems.push(
      `  ${SHEET}: the ${rule} rule matched no declarations at all — ` +
        `either the stylesheet changed shape or this gate's pattern rotted`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\nOff-scale values in the stylesheet:\n${problems.join("\n")}\n\n` +
      "Every value comes off a scale in docs/DESIGN.md. Move the value onto " +
      "a scale, or change the scale there — in the same commit, on purpose.",
  );
  process.exit(1);
}

console.info(
  `Checked ${counts.fontSize} font sizes, ${counts.spacing} spacing values, ` +
    `${counts.radius} radii, ${counts.colour} colour literals and ` +
    `${counts.duration} durations against the design scales.`,
);
