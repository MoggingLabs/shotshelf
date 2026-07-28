//! Sizing a capture for hand-off.
//!
//! A screenshot from a 4K display is around eight megapixels. Every vision
//! model in use resizes what it is given to something far smaller before it
//! looks at it — roughly 1568px on the long edge is the common ceiling — so
//! those extra pixels are uploaded, paid for, and then discarded before they
//! affect a single token of the answer.
//!
//! Shrinking first is therefore free in quality terms and not free in cost
//! terms, which is an unusually one-sided trade. What is *not* free is
//! shrinking too far: a screenshot's smallest legible text is often the point
//! of sending it, so this only ever shrinks, never enlarges, and never crosses
//! below the ceiling.

use image::{imageops::FilterType, DynamicImage};

use super::ImageError;

/// The long edge a capture is reduced to, in pixels.
///
/// Chosen to match what vision models resize to rather than to hit a file
/// size: going below it starts costing legibility, and going above it costs
/// upload and tokens for pixels that are discarded on arrival.
pub const LONG_EDGE: u32 = 1568;

/// A capture, sized for hand-off.
pub struct Sized {
    pub image: DynamicImage,
    /// False when the capture was already small enough to send untouched.
    pub resized: bool,
}

/// Shrink a capture to the hand-off ceiling, if it is over it.
///
/// Lanczos3 rather than something cheaper: this runs once per drag on a single
/// image, so the milliseconds are irrelevant, and a nearest-neighbour or
/// triangle downscale of small text is visibly worse — aliased strokes and
/// dropped hairlines in exactly the region someone is asking about.
pub fn for_handoff(image: DynamicImage, long_edge: u32) -> Sized {
    let (width, height) = (image.width(), image.height());
    let longest = width.max(height);

    // Never enlarge. A small capture is small on purpose — a cropped region, a
    // dialog — and upscaling it invents detail that was never there.
    if longest <= long_edge || longest == 0 {
        return Sized { image, resized: false };
    }

    let scale = f64::from(long_edge) / f64::from(longest);
    // `resize` preserves aspect ratio within the box it is given, and rounding
    // up keeps a very wide capture from losing its short edge to zero.
    let target_width = scale_edge(width, scale);
    let target_height = scale_edge(height, scale);

    Sized {
        image: image.resize(target_width, target_height, FilterType::Lanczos3),
        resized: true,
    }
}

/// Scale one edge, never below a single pixel.
///
/// A 6000x1 panorama scaled by the long edge would otherwise round its height
/// to zero, and an image with a zero dimension fails to encode.
fn scale_edge(edge: u32, scale: f64) -> u32 {
    let scaled = (f64::from(edge) * scale).round();
    // `as u32` saturates at zero for negatives and at u32::MAX above the
    // range, and both are unreachable here — scale is in (0, 1].
    (scaled as u32).max(1)
}

/// The pixels a capture would cost to send, before and after.
///
/// Used to tell the user what they saved, in the only unit that matters to
/// them: not bytes on disk, but how much of the image survives.
pub fn megapixels(width: u32, height: u32) -> f64 {
    f64::from(width) * f64::from(height) / 1_000_000.0
}

/// Read a capture, size it for hand-off, and return PNG bytes.
///
/// Returns `Ok(None)` when the capture is already within the ceiling, so the
/// caller can hand over the original file untouched rather than writing a
/// byte-identical copy of it.
pub fn png_for_handoff(path: &std::path::Path, long_edge: u32) -> Result<Option<Vec<u8>>, ImageError> {
    let sized = for_handoff(super::load(path)?, long_edge);
    if !sized.resized {
        return Ok(None);
    }
    super::to_png(&sized.image).map(Some)
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, RgbaImage};

    use super::*;

    fn image(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::new(width, height))
    }

    #[test]
    fn a_capture_over_the_ceiling_is_brought_down_to_it() {
        let sized = for_handoff(image(3840, 2160), LONG_EDGE);
        assert!(sized.resized);
        assert_eq!(sized.image.width(), LONG_EDGE);
        assert_eq!(sized.image.height(), 882, "aspect ratio is preserved");
    }

    #[test]
    fn a_portrait_capture_is_measured_by_its_long_edge_too() {
        let sized = for_handoff(image(1080, 3840), LONG_EDGE);
        assert_eq!(sized.image.height(), LONG_EDGE);
        assert_eq!(sized.image.width(), 441);
    }

    #[test]
    fn a_capture_already_small_enough_is_left_exactly_alone() {
        let sized = for_handoff(image(800, 600), LONG_EDGE);
        assert!(!sized.resized);
        assert_eq!((sized.image.width(), sized.image.height()), (800, 600));
    }

    #[test]
    fn a_capture_exactly_on_the_ceiling_is_not_touched() {
        let sized = for_handoff(image(LONG_EDGE, 400), LONG_EDGE);
        assert!(!sized.resized, "resizing to the size it already is is pure loss");
    }

    #[test]
    fn nothing_is_ever_enlarged() {
        // A cropped region or a dialog is small on purpose; upscaling it would
        // invent detail that was never captured.
        let sized = for_handoff(image(200, 100), LONG_EDGE);
        assert!(!sized.resized);
        assert_eq!(sized.image.width(), 200);
    }

    #[test]
    fn an_extreme_panorama_keeps_at_least_one_pixel_of_short_edge() {
        // Rounding the short edge to zero produces an image that cannot be
        // encoded at all, turning a cosmetic step into a failed drag.
        let sized = for_handoff(image(9000, 2), 1000);
        assert_eq!(sized.image.width(), 1000);
        assert!(sized.image.height() >= 1);
    }

    #[test]
    fn megapixels_are_reported_for_the_saving_message() {
        assert!((megapixels(1920, 1080) - 2.0736).abs() < 0.0001);
        assert_eq!(megapixels(0, 0), 0.0);
    }
}
