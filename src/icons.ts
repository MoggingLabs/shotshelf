/**
 * One icon set, drawn by one hand.
 *
 * Everything here is a 24×24 stroke path rendered at whatever size the caller
 * asks for, inheriting `currentColor`. The shelf previously mixed emoji
 * (📸 🎬 ⚠) with typographic symbols (★ ☆ ⧉ × ▶): different weights, different
 * colours, and a different look on every machine.
 *
 * Sizes come off the icon scale in `docs/DESIGN.md` — 10 inside a pill badge,
 * 12 in a micro marker, 14 in a 24px control, 16 in a 28px control, 24 on a
 * card face. Callers used to pick 9, 11, 13, 14, 22 and 26 by eye, which is
 * six near-misses of a five-step scale.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  settings: [
    "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
    "M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46V21a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97H3a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.46V3a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46.97H21a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.46.97Z",
  ],
  minus: ["M5 12h14"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  copy: ["M9.5 9.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z", "M5.5 15.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1"],
  star: ["M12 3.6l2.63 5.44 5.87.86-4.25 4.2 1 5.94L12 17.22 6.75 20l1-5.94-4.25-4.2 5.87-.86L12 3.6Z"],
  play: ["M8.5 5.8v12.4l10-6.2-10-6.2Z"],
  camera: ["M4.5 8.5h3l1.6-2.2h5.8l1.6 2.2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-16a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z", "M12 17.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z"],
  film: ["M3.5 5.5h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z", "M8 5.5v13", "M16 5.5v13", "M2.5 12h19"],
  alert: ["M12 4.5 2.8 20h18.4L12 4.5Z", "M12 10.5v4", "M12 17.4v.2"],
  trash: ["M5 7h14", "M9.5 7V5.6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7", "M6.8 7l.7 11.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9L17.2 7", "M10 10.5v5", "M14 10.5v5"],
  folder: ["M3.5 6.5h5.2l2 2.5h9.8a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"],
} as const;

export type IconName = keyof typeof PATHS;

// No default size: 15 was off the documented five-step scale (10/12/14/16/24),
// and a caller omitting the argument was the one thing `check-design.mjs`
// cannot see — it reads the stylesheet, not this file.
export function icon(name: IconName, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");

  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }

  return svg;
}

/** Solid rather than outlined, for states that need to read at a glance. */
export function solidIcon(name: IconName, size: number): SVGSVGElement {
  const svg = icon(name, size);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke-width", "1");
  return svg;
}
