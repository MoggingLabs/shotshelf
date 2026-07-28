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

use super::redact::Region;

/// How the two captures are laid out.
const GUTTER: u32 = 16;
/// Thickness of the outline drawn around a changed area.
const OUTLINE: u32 = 3;
const BACKGROUND: Rgba<u8> = Rgba([17, 18, 26, 255]);
/// Amber: reads as "look here" against both light and dark captures.
const HIGHLIGHT: Rgba<u8> = Rgba([245, 158, 11, 255]);

/// Comparison settings, exposed so the sensitivity can be tuned rather than
/// guessed at.
#[derive(Clone, Copy, Debug)]
pub struct Settings {
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

impl Default for Settings {
    fn default() -> Self {
        // Tuned for screenshots of user interfaces: text that has actually
        // changed moves far more than these, and subpixel rendering moves less.
        Self { block: 16, threshold: 48, density: 0.06 }
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
    settings: Settings,
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
    settings: Settings,
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
        // Present in one and not the other.
        (None, None) => false,
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

/// The two captures side by side, with changed areas outlined on the after.
pub fn side_by_side(
    before: &DynamicImage,
    after: &DynamicImage,
    highlights: &[Region],
) -> DynamicImage {
    let width = before.width() + GUTTER + after.width();
    let height = before.height().max(after.height());
    let mut canvas = RgbaImage::from_pixel(width.max(1), height.max(1), BACKGROUND);

    blit(&mut canvas, before, 0);
    let offset = before.width() + GUTTER;
    blit(&mut canvas, after, offset);

    let mut canvas = DynamicImage::ImageRgba8(canvas);
    for region in highlights {
        outline(&mut canvas, *region, offset);
    }
    canvas
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

/// Draw a hollow rectangle. Hollow because the point is to direct attention to
/// what changed, not to hide it.
fn outline(canvas: &mut DynamicImage, region: Region, offset_x: u32) {
    let (canvas_width, canvas_height) = (canvas.width(), canvas.height());

    for y in region.y..(region.y + region.height).min(canvas_height) {
        for x in region.x..(region.x + region.width) {
            let on_edge = y < region.y + OUTLINE
                || y + OUTLINE >= region.y + region.height
                || x < region.x + OUTLINE
                || x + OUTLINE >= region.x + region.width;
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
        let regions = changed_regions(&before, &before.clone(), Settings::default());
        assert!(regions.is_empty(), "nothing changed is a useful answer, not a failure");
    }

    #[test]
    fn a_changed_area_is_found_and_covers_it() {
        let before = filled(64, 64, [255, 255, 255, 255]);
        let after = with_patch(&before, Region { x: 16, y: 16, width: 16, height: 16 }, [0, 0, 0, 255]);

        let regions = changed_regions(&before, &after, Settings::default());

        assert_eq!(regions.len(), 1);
        let found = regions[0];
        assert!(found.x <= 16 && found.y <= 16);
        assert!(found.x + found.width >= 32 && found.y + found.height >= 32);
    }

    #[test]
    fn adjacent_changes_merge_into_one_region() {
        let before = filled(96, 32, [255, 255, 255, 255]);
        // A run of changed blocks, as a line of edited text would produce.
        let after = with_patch(&before, Region { x: 0, y: 0, width: 80, height: 16 }, [0, 0, 0, 255]);

        let regions = changed_regions(&before, &after, Settings::default());

        assert_eq!(regions.len(), 1, "a changed paragraph is one thing, not five boxes");
    }

    #[test]
    fn separate_changes_stay_separate() {
        let before = filled(128, 32, [255, 255, 255, 255]);
        let mut after = with_patch(&before, Region { x: 0, y: 0, width: 16, height: 16 }, [0, 0, 0, 255]);
        after = with_patch(&after, Region { x: 96, y: 0, width: 16, height: 16 }, [0, 0, 0, 255]);

        assert_eq!(changed_regions(&before, &after, Settings::default()).len(), 2);
    }

    #[test]
    fn subpixel_noise_is_not_a_change() {
        // Two screenshots of the same screen differ slightly along antialiased
        // edges. Reporting that is confetti, not a diff.
        let before = filled(64, 64, [200, 200, 200, 255]);
        let after = filled(64, 64, [203, 202, 201, 255]);

        assert!(changed_regions(&before, &after, Settings::default()).is_empty());
    }

    #[test]
    fn a_capture_that_grew_reports_the_new_area_as_changed() {
        let before = filled(32, 32, [255, 255, 255, 255]);
        let after = filled(64, 32, [255, 255, 255, 255]);

        let regions = changed_regions(&before, &after, Settings::default());

        assert!(!regions.is_empty(), "a window that grew has genuinely changed");
        assert!(regions.iter().any(|region| region.x + region.width > 32));
    }

    #[test]
    fn a_change_in_transparency_alone_still_counts() {
        let before = filled(32, 32, [0, 0, 0, 0]);
        let after = filled(32, 32, [0, 0, 0, 255]);
        assert!(!changed_regions(&before, &after, Settings::default()).is_empty());
    }

    #[test]
    fn side_by_side_holds_both_captures_and_a_gutter() {
        let before = filled(40, 20, [255, 0, 0, 255]);
        let after = filled(30, 25, [0, 0, 255, 255]);

        let sheet = side_by_side(&before, &after, &[]);

        assert_eq!(sheet.width(), 40 + GUTTER + 30);
        assert_eq!(sheet.height(), 25, "as tall as the taller of the two");
        assert_eq!(sheet.get_pixel(0, 0), Rgba([255, 0, 0, 255]), "before on the left");
        assert_eq!(sheet.get_pixel(40 + GUTTER, 0), Rgba([0, 0, 255, 255]), "after on the right");
        assert_eq!(sheet.get_pixel(41, 0), BACKGROUND, "gutter between them");
    }

    #[test]
    fn a_highlight_outlines_the_change_without_covering_it() {
        let before = filled(64, 64, [255, 255, 255, 255]);
        let after = filled(64, 64, [255, 255, 255, 255]);
        let region = Region { x: 10, y: 10, width: 20, height: 20 };

        let sheet = side_by_side(&before, &after, &[region]);
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
        assert!(changed_regions(&empty, &empty.clone(), Settings::default()).is_empty());
    }
}
