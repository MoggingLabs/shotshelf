//! Before and after, as one picture.
//!
//! When you are iterating on something with a model, the unit that carries
//! meaning is rarely a single screenshot — it is the pair. Shotshelf is the
//! only thing in that loop that sees both: the OS hands over one file at a
//! time and the chat receives one image at a time.
//!
//! What comes out is a single image, because that is what can be dragged into
//! a conversation and talked about. Changed areas are outlined rather than
//! painted over: the point is to direct attention, and a heat-map of altered
//! pixels obscures the very thing it is pointing at.

use image::{DynamicImage, GenericImage, GenericImageView, Rgba, RgbaImage};

use super::Region;

/// How the two captures are laid out.
const GUTTER: u32 = 16;
/// Thickness of the outline drawn around a changed area.
const OUTLINE: u32 = 3;
const BACKGROUND: Rgba<u8> = Rgba([17, 18, 26, 255]);
/// Amber: reads as "look here" against both light and dark captures.
const HIGHLIGHT: Rgba<u8> = Rgba([245, 158, 11, 255]);

/// How much has to change before it counts.
///
/// Named for what it is rather than `Settings`: the crate already has a
/// `settings::Settings` holding the user's preferences, and two unrelated
/// concepts sharing the most generic name in the crate is a reader's problem.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sensitivity {
    /// Side of the square blocks the image is divided into before comparing.
    ///
    /// Comparing whole blocks rather than single pixels is what makes the
    /// result useful: a one-pixel antialiasing difference along a redrawn edge
    /// is not a change anyone wants pointed out, and per-pixel diffing of two
    /// screenshots of the same UI produces confetti.
    pub block: u32,
    /// How different two pixels must be, summed across channels, to count.
    pub threshold: u32,
    /// What fraction of a block's pixels must differ before the block does.
    pub density: f32,
}

impl Default for Sensitivity {
    fn default() -> Self {
        // Tuned for screenshots of user interfaces: text that has actually
        // changed moves far more than these, and subpixel rendering moves less.
        Self {
            block: 16,
            threshold: 48,
            density: 0.06,
        }
    }
}

/// Which areas differ between two captures.
///
/// Returns bounding boxes in the coordinate space of the larger image. An
/// empty result means the two are the same as far as the settings care, which
/// is a useful answer in itself — "nothing I can see changed" is often the
/// thing being checked.
pub fn changed_regions(
    before: &DynamicImage,
    after: &DynamicImage,
    settings: Sensitivity,
) -> Vec<Region> {
    let width = before.width().max(after.width());
    let height = before.height().max(after.height());
    let block = settings.block.max(1);
    if width == 0 || height == 0 {
        return Vec::new();
    }

    let columns = width.div_ceil(block);
    let rows = height.div_ceil(block);
    let mut changed = vec![false; (columns * rows) as usize];

    for row in 0..rows {
        for column in 0..columns {
            let region = Region {
                x: column * block,
                y: row * block,
                width: block.min(width - column * block),
                height: block.min(height - row * block),
            };
            if block_changed(before, after, region, settings) {
                changed[(row * columns + column) as usize] = true;
            }
        }
    }

    merge(&changed, columns, rows, block, width, height)
}

/// Whether enough of one block's pixels differ.
///
/// A pixel present in one image and off the edge of the other counts as
/// changed: a window that grew has genuinely changed in the new area.
fn block_changed(
    before: &DynamicImage,
    after: &DynamicImage,
    region: Region,
    settings: Sensitivity,
) -> bool {
    let total = region.width * region.height;
    if total == 0 {
        return false;
    }

    let mut differing = 0_u32;
    for y in region.y..region.y + region.height {
        for x in region.x..region.x + region.width {
            if pixel_changed(before, after, x, y, settings.threshold) {
                differing += 1;
            }
        }
    }

    #[allow(clippy::cast_precision_loss)] // Block sizes are far below f32's exact range.
    let fraction = differing as f32 / total as f32;
    fraction > settings.density
}

fn pixel_changed(
    before: &DynamicImage,
    after: &DynamicImage,
    x: u32,
    y: u32,
    threshold: u32,
) -> bool {
    match (in_bounds(before, x, y), in_bounds(after, x, y)) {
        (Some(a), Some(b)) => {
            let distance: u32 = (0..3)
                .map(|channel| u32::from(a.0[channel].abs_diff(b.0[channel])))
                .sum();
            // Transparency changes are changes: a dialog that appeared over a
            // transparent region differs only in alpha.
            distance + u32::from(a.0[3].abs_diff(b.0[3])) > threshold
        }
        // Past the edge of both: the captures are different sizes and this
        // point is outside each of them, so there is nothing to compare.
        (None, None) => false,
        // Present in one and not the other — one capture is larger, and the
        // area only it covers is a change.
        _ => true,
    }
}

fn in_bounds(image: &DynamicImage, x: u32, y: u32) -> Option<Rgba<u8>> {
    (x < image.width() && y < image.height()).then(|| image.get_pixel(x, y))
}

/// Merge adjacent changed blocks into rectangles.
///
/// Flood fill over the block grid rather than one box per block: a paragraph
/// of changed text is one thing that changed, and outlining every sixteen-pixel
/// square of it is unreadable.
fn merge(
    changed: &[bool],
    columns: u32,
    rows: u32,
    block: u32,
    width: u32,
    height: u32,
) -> Vec<Region> {
    let mut seen = vec![false; changed.len()];
    let mut regions = Vec::new();

    for row in 0..rows {
        for column in 0..columns {
            let start = (row * columns + column) as usize;
            if !changed[start] || seen[start] {
                continue;
            }

            let (mut min_c, mut max_c, mut min_r, mut max_r) = (column, column, row, row);
            let mut stack = vec![(column, row)];
            seen[start] = true;

            while let Some((c, r)) = stack.pop() {
                min_c = min_c.min(c);
                max_c = max_c.max(c);
                min_r = min_r.min(r);
                max_r = max_r.max(r);

                for (dc, dr) in [(0_i64, 1_i64), (0, -1), (1, 0), (-1, 0)] {
                    let (nc, nr) = (i64::from(c) + dc, i64::from(r) + dr);
                    if nc < 0 || nr < 0 || nc >= i64::from(columns) || nr >= i64::from(rows) {
                        continue;
                    }
                    #[allow(clippy::cast_sign_loss)] // Guarded non-negative above.
                    let index = (nr as u32 * columns + nc as u32) as usize;
                    if changed[index] && !seen[index] {
                        seen[index] = true;
                        #[allow(clippy::cast_sign_loss)]
                        stack.push((nc as u32, nr as u32));
                    }
                }
            }

            let x = min_c * block;
            let y = min_r * block;
            regions.push(Region {
                x,
                y,
                width: ((max_c + 1) * block).min(width) - x,
                height: ((max_r + 1) * block).min(height) - y,
            });
        }
    }

    regions
}

/// The most a composite may allocate.
///
/// The decodes either side of this are already bounded, and that was taken to
/// mean the command was — but the composite is *larger than both inputs put
/// together*, and nothing capped it. Two stitched multi-monitor captures, the
/// case `imaging::load`'s dimension cap exists to allow, produced well over a
/// gigabyte here.
const MAX_COMPOSITE_BYTES: u64 = 512 * 1024 * 1024;

/// The two captures side by side, with changed areas outlined on the after.
///
/// Returns `None` when the pair would produce a composite past the ceiling.
/// A refusal the user can act on — crop one and try again — beats an
/// allocation that takes the app down with it.
pub fn side_by_side(
    before: &DynamicImage,
    after: &DynamicImage,
    highlights: &[Region],
) -> Option<DynamicImage> {
    // The only place the composite's size is computed, so the ceiling cannot
    // be bypassed by deriving the dimensions some other way — including the
    // `max(1)` below, which is part of the same decision and is why it is
    // written here rather than inside `composite_size`: a zero-sized pair is
    // refused by `RgbaImage` rather than by the ceiling, and a canvas is never
    // smaller than one pixel. Everything else about the size comes from that
    // one function.
    let (width, height) = composite_size(
        (before.width(), before.height()),
        (after.width(), after.height()),
    )?;

    let mut canvas = RgbaImage::from_pixel(width.max(1), height.max(1), BACKGROUND);

    blit(&mut canvas, before, 0);
    let offset = before.width() + GUTTER;
    blit(&mut canvas, after, offset);

    let mut canvas = DynamicImage::ImageRgba8(canvas);
    for region in highlights {
        outline(&mut canvas, *region, offset);
    }
    Some(canvas)
}

/// The composite's dimensions, or `None` if it would pass the ceiling.
///
/// Takes sizes rather than images so the refusal can be stated without
/// building the gigabyte it exists to refuse — the test for it used to
/// allocate two 512 MiB buffers to reach an assert about not allocating.
///
/// Arithmetic in `u64` throughout. The composite's width is a *sum* of two
/// decoded widths plus the gutter, and that sum could wrap a `u32` before the
/// ceiling was ever consulted — a wrap that produces a small width, passes the
/// check, and then blits out of a canvas far too small. `imaging::load`'s
/// dimension cap makes it unreachable today; it should not depend on that.
fn composite_size(before: (u32, u32), after: (u32, u32)) -> Option<(u32, u32)> {
    // The right-hand pane is as wide as the **region space**, not as the after
    // image — `changed_regions` reports boxes in the coordinate space of the
    // larger of the two, so a region can extend past the after image's own
    // width whenever the capture shrank.
    //
    // Sized to the after image, every such box fell outside the canvas and
    // `outline` dropped it pixel by pixel, silently. That is not an edge case:
    // a dialog closing or a window being resized between the two shots is the
    // ordinary way to produce it, and the vanished strip is usually the single
    // largest change in the pair. `pixel_changed` marks it correctly — the
    // `(Some, None)` arm is there for exactly this — and the drawing threw it
    // away, so the feature's whole output was wrong for half its input space
    // while its docstring promised "changed areas outlined on the after".
    //
    // The extra width is background, which is the honest rendering: the
    // outline says "this was here and is not any more".
    let pane = u64::from(before.0.max(after.0));
    let width = u64::from(before.0) + u64::from(GUTTER) + pane;
    let height = u64::from(before.1.max(after.1));

    // Four bytes per pixel. Checked, because at the extremes the product of
    // two `u32`-derived values overflows even a `u64`, and an overflow is a
    // refusal rather than a wrap.
    let bytes = width.checked_mul(height).and_then(|px| px.checked_mul(4))?;
    if bytes > MAX_COMPOSITE_BYTES {
        return None;
    }

    // Under the ceiling both fit a `u32` with room to spare.
    Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
}

fn blit(canvas: &mut RgbaImage, image: &DynamicImage, offset_x: u32) {
    for y in 0..image.height() {
        for x in 0..image.width() {
            let (target_x, target_y) = (x + offset_x, y);
            if target_x < canvas.width() && target_y < canvas.height() {
                canvas.put_pixel(target_x, target_y, image.get_pixel(x, y));
            }
        }
    }
}

/// How thick a border one edge can carry and still leave something inside it.
///
/// A fixed `OUTLINE` on both sides meets in the middle of anything narrower
/// than twice it, and the two bands then cover every pixel â€” a solid block of
/// highlight over the change, in a function whose test is named "outlines the
/// change *without covering it*".
///
/// Not a rare shape. `merge` emits a region bounded by the last partial block
/// of the image: a 1366-wide capture with a 16-pixel block leaves a final
/// column six pixels across, and `2 * OUTLINE` is six. A change confined to the
/// right-hand edge of a very common laptop width came out painted over.
///
/// Below three pixels there is no interior to preserve and the region is filled
/// â€” a one-pixel-wide box cannot be both a border and a middle.
fn stroke(extent: u32) -> u32 {
    if extent < 3 {
        return extent;
    }
    OUTLINE.min((extent - 1) / 2).max(1)
}

/// Draw a hollow rectangle. Hollow because the point is to direct attention to
/// what changed, not to hide it.
/// How thick a border one edge can carry and still leave something inside it.
///
/// A fixed `OUTLINE` on both sides meets in the middle of anything narrower
/// than twice it, and the two bands then cover every pixel — a solid block of
/// highlight over the change, in a function whose test is named "outlines the
/// change *without covering it*".
///
/// Not a rare shape. `merge` emits a region bounded by the last partial block
/// of the image: a 1366-wide capture with a 16-pixel block leaves a final
/// column six pixels across, and `2 * OUTLINE` is six. A change confined to the
/// right-hand edge of a very common laptop width came out painted over.
///
/// Below three pixels there is no interior to preserve and the region is filled
/// — a one-pixel-wide box cannot be both a border and a middle.
fn outline(canvas: &mut DynamicImage, region: Region, offset_x: u32) {
    let (canvas_width, canvas_height) = (canvas.width(), canvas.height());
    let (across, down) = (stroke(region.width), stroke(region.height));

    for y in region.y..(region.y + region.height).min(canvas_height) {
        for x in region.x..(region.x + region.width) {
            let on_edge = y < region.y + down
                || y + down >= region.y + region.height
                || x < region.x + across
                || x + across >= region.x + region.width;
            if !on_edge {
                continue;
            }
            let target_x = x + offset_x;
            if target_x < canvas_width {
                canvas.put_pixel(target_x, y, HIGHLIGHT);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use image::{Rgba, RgbaImage};

    use super::*;

    fn filled(width: u32, height: u32, colour: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba(colour)))
    }

    fn with_patch(base: &DynamicImage, patch: Region, colour: [u8; 4]) -> DynamicImage {
        let mut image = base.clone();
        for y in patch.y..patch.y + patch.height {
            for x in patch.x..patch.x + patch.width {
                image.put_pixel(x, y, Rgba(colour));
            }
        }
        image
    }

    #[test]
    fn two_identical_captures_report_nothing_changed() {
        let before = filled(64, 64, [255, 255, 255, 255]);
        let regions = changed_regions(&before, &before.clone(), Sensitivity::default());
        assert!(
            regions.is_empty(),
            "nothing changed is a useful answer, not a failure"
        );
    }

    #[test]
    fn a_changed_area_is_found_and_covers_it() {
        let before = filled(64, 64, [255, 255, 255, 255]);
        let after = with_patch(
            &before,
            Region {
                x: 16,
                y: 16,
                width: 16,
                height: 16,
            },
            [0, 0, 0, 255],
        );

        let regions = changed_regions(&before, &after, Sensitivity::default());

        assert_eq!(regions.len(), 1);
        let found = regions[0];
        assert!(found.x <= 16 && found.y <= 16);
        assert!(found.x + found.width >= 32 && found.y + found.height >= 32);
    }

    #[test]
    fn adjacent_changes_merge_into_one_region() {
        let before = filled(96, 32, [255, 255, 255, 255]);
        // A run of changed blocks, as a line of edited text would produce.
        let after = with_patch(
            &before,
            Region {
                x: 0,
                y: 0,
                width: 80,
                height: 16,
            },
            [0, 0, 0, 255],
        );

        let regions = changed_regions(&before, &after, Sensitivity::default());

        assert_eq!(
            regions.len(),
            1,
            "a changed paragraph is one thing, not five boxes"
        );
    }

    #[test]
    fn separate_changes_stay_separate() {
        let before = filled(128, 32, [255, 255, 255, 255]);
        let mut after = with_patch(
            &before,
            Region {
                x: 0,
                y: 0,
                width: 16,
                height: 16,
            },
            [0, 0, 0, 255],
        );
        after = with_patch(
            &after,
            Region {
                x: 96,
                y: 0,
                width: 16,
                height: 16,
            },
            [0, 0, 0, 255],
        );

        assert_eq!(
            changed_regions(&before, &after, Sensitivity::default()).len(),
            2
        );
    }

    #[test]
    fn subpixel_noise_is_not_a_change() {
        // Two screenshots of the same screen differ slightly along antialiased
        // edges. Reporting that is confetti, not a diff.
        let before = filled(64, 64, [200, 200, 200, 255]);
        let after = filled(64, 64, [203, 202, 201, 255]);

        assert!(changed_regions(&before, &after, Sensitivity::default()).is_empty());
    }

    #[test]
    fn a_capture_that_grew_reports_the_new_area_as_changed() {
        let before = filled(32, 32, [255, 255, 255, 255]);
        let after = filled(64, 32, [255, 255, 255, 255]);

        let regions = changed_regions(&before, &after, Sensitivity::default());

        assert!(
            !regions.is_empty(),
            "a window that grew has genuinely changed"
        );
        assert!(regions.iter().any(|region| region.x + region.width > 32));
    }

    #[test]
    fn a_change_in_transparency_alone_still_counts() {
        let before = filled(32, 32, [0, 0, 0, 0]);
        let after = filled(32, 32, [0, 0, 0, 255]);
        assert!(!changed_regions(&before, &after, Sensitivity::default()).is_empty());
    }

    #[test]
    fn a_pair_too_large_to_composite_is_refused_rather_than_allocated() {
        // The decodes either side are bounded and the composite was not, though
        // it is larger than both inputs together.
        //
        // Stated against the dimensions, which is what "rather than allocated"
        // has to mean. This test used to build two `RgbaImage`s of ~512 MiB
        // each in order to reach the assert — it spent a gigabyte proving the
        // code would not spend one, while its own comment claimed otherwise.
        //
        // No cheap end-to-end case exists: the composite is always about the
        // size of its inputs, so an oversized composite requires oversized
        // inputs. The join to `side_by_side` is structural instead —
        // `composite_size` is the only thing that produces the canvas's
        // dimensions there, so the check cannot be dropped without visibly
        // re-deriving them.
        let wide = u32::try_from(MAX_COMPOSITE_BYTES / 4 / 8 + 1).expect("fits");
        assert!(composite_size((wide, 8), (0, 8)).is_none());
        assert!(composite_size((100, 100), (100, 100)).is_some());

        // The width is a sum of two decoded widths plus the gutter. In `u32`
        // that wrapped to something small, passed the ceiling, and left the
        // blits writing outside a canvas sized from the wrapped value.
        assert!(composite_size((u32::MAX, 4), (u32::MAX, 4)).is_none());
    }

    #[test]
    fn a_capture_that_shrank_still_has_its_lost_area_outlined() {
        // The whole output of Compare, for half its input space.
        //
        // `changed_regions` reports in the coordinate space of the *larger*
        // image, so when the after is narrower a region can sit past the after
        // image's own width. The composite was sized to the after image, every
        // such box fell off the canvas, and `outline` discarded it a pixel at a
        // time — no warning, no partial mark, just nothing where the largest
        // change in the pair should be.
        //
        // Asserted end to end, through `changed_regions` into `side_by_side`,
        // because that join was what nothing exercised: each half was tested
        // and the seam between them was not.
        let before = filled(64, 32, [255, 0, 0, 255]);
        let after = filled(32, 32, [255, 0, 0, 255]);

        let regions = changed_regions(&before, &after, Sensitivity::default());
        assert!(
            !regions.is_empty(),
            "the area present only in the before is a change",
        );

        let sheet = side_by_side(&before, &after, &regions).expect("a small pair fits");
        let marked = (0..sheet.width())
            .flat_map(|x| (0..sheet.height()).map(move |y| (x, y)))
            .filter(|&(x, y)| sheet.get_pixel(x, y) == HIGHLIGHT)
            .count();

        assert!(marked > 0, "the lost area was outlined nowhere");
    }

    #[test]
    fn side_by_side_holds_both_captures_and_a_gutter() {
        let before = filled(40, 20, [255, 0, 0, 255]);
        let after = filled(30, 25, [0, 0, 255, 255]);

        let sheet = side_by_side(&before, &after, &[]).expect("a small pair fits");

        // The right pane is the region space — `max(40, 30)` — not the after
        // image's own 30, so a box reported past the after's width still lands
        // on canvas.
        assert_eq!(sheet.width(), 40 + GUTTER + 40);
        assert_eq!(sheet.height(), 25, "as tall as the taller of the two");
        assert_eq!(
            sheet.get_pixel(0, 0),
            Rgba([255, 0, 0, 255]),
            "before on the left"
        );
        assert_eq!(
            sheet.get_pixel(40 + GUTTER, 0),
            Rgba([0, 0, 255, 255]),
            "after on the right"
        );
        assert_eq!(sheet.get_pixel(41, 0), BACKGROUND, "gutter between them");
    }

    #[test]
    fn a_narrow_region_is_outlined_rather_than_painted_over() {
        // Six pixels across is what `merge` produces for the last column of a
        // 1366-wide capture at the default block size, and `2 * OUTLINE` is
        // six — so the left and right bands met and filled the region solid,
        // hiding the very change it was marking.
        let before = filled(64, 64, [255, 255, 255, 255]);
        let after = filled(64, 64, [255, 255, 255, 255]);
        let region = Region {
            x: 10,
            y: 10,
            width: 6,
            height: 6,
        };

        let sheet = side_by_side(&before, &after, &[region]).expect("a small pair fits");
        let offset = 64 + GUTTER;

        assert_eq!(
            sheet.get_pixel(offset + 10, 10),
            HIGHLIGHT,
            "the border is still drawn"
        );
        assert_eq!(
            sheet.get_pixel(offset + 12, 12),
            Rgba([255, 255, 255, 255]),
            "the middle of a narrow region must still show the capture",
        );
    }

    #[test]
    fn a_highlight_outlines_the_change_without_covering_it() {
        let before = filled(64, 64, [255, 255, 255, 255]);
        let after = filled(64, 64, [255, 255, 255, 255]);
        let region = Region {
            x: 10,
            y: 10,
            width: 20,
            height: 20,
        };

        let sheet = side_by_side(&before, &after, &[region]).expect("a small pair fits");
        let offset = 64 + GUTTER;

        assert_eq!(sheet.get_pixel(offset + 10, 10), HIGHLIGHT, "edge is drawn");
        assert_eq!(
            sheet.get_pixel(offset + 20, 20),
            Rgba([255, 255, 255, 255]),
            "the middle is left alone — the point is to point, not to hide",
        );
    }

    #[test]
    fn comparing_empty_images_does_not_panic() {
        let empty = filled(0, 0, [0, 0, 0, 0]);
        assert!(changed_regions(&empty, &empty.clone(), Sensitivity::default()).is_empty());
    }
}
