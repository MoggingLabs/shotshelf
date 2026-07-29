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
//! of sending it, so this only ever shrinks and never enlarges. A capture past
//! the ceiling comes out with its long edge *on* the ceiling, give or take the
//! single rounding in `scale_edge` — it used to land as much as eight pixels
//! under it, because the resize rounded a second time from the first rounding's
//! output.

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
pub fn for_handoff(image: DynamicImage) -> Sized {
    // `LONG_EDGE` directly, not a parameter. This took one, and every caller in
    // the crate — the one production call site and all nine tests — passed
    // `LONG_EDGE`. A parameter nobody varies reads as configuration and is not:
    // it makes the ceiling look like the caller's decision when it is this
    // module's, and it invites guards for values that cannot arrive.
    let long_edge = LONG_EDGE;
    let (width, height) = (image.width(), image.height());
    let longest = width.max(height);

    // Never enlarge. A small capture is small on purpose — a cropped region, a
    // dialog — and upscaling it invents detail that was never there.
    // `longest == 0` was a second clause here and could never be reached:
    // `0 <= long_edge` holds for every `u32`, so the first one had already
    // returned.
    if longest <= long_edge {
        return Sized {
            image,
            resized: false,
        };
    }

    let scale = f64::from(long_edge) / f64::from(longest);
    let target_width = scale_edge(width, scale);
    let target_height = scale_edge(height, scale);

    // `resize_exact`, not `resize`, and the difference is a rounding.
    //
    // `resize` treats its arguments as a *box* and re-derives its own ratio as
    // `min(w/width, h/height)` from the already-rounded pair, then rounds again.
    // When the short edge rounded down it became the binding one and dragged
    // the long edge with it: `for_handoff(10000x500, 1568)` produced **1560**x78,
    // not 1568x78, and the error grows with the aspect ratio. The module header
    // says a capture is reduced to this long edge, and it was not.
    //
    // Both edges here come from one `scale` computed from one long edge, so the
    // aspect ratio is already preserved to within a pixel — asking `resize` to
    // preserve it a second time added nothing but the second rounding. One
    // rounding, in `scale_edge`, which is the function that documents it.
    Sized {
        image: image.resize_exact(target_width, target_height, FilterType::Lanczos3),
        resized: true,
    }
}

/// Scale one edge, never below a single pixel.
///
/// A 6000x1 panorama scaled by the long edge would otherwise round its height
/// to zero, and an image with a zero dimension fails to encode.
///
/// The floor is `.max(1)`, and `.round()` is round-to-nearest. `for_handoff` used
/// to credit the guarantee to "rounding up", which this function does not do —
/// and a test further down this file asserts, correctly, that "the floor is a
/// floor, not a rounding-up rule". One file, three statements, two of them
/// agreeing and the third describing a mechanism that was never here.
fn scale_edge(edge: u32, scale: f64) -> u32 {
    let scaled = (f64::from(edge) * scale).round();
    // Clamped into range *before* the conversion rather than relying on `as` to
    // saturate. It does saturate, and both ends are unreachable while scale is
    // in (0, 1] — but "unreachable given a caller that behaves" is exactly the
    // reasoning that stops being true when a second caller appears, and it read
    // as a licence for the next float conversion to skip the question.
    let clamped = scaled.clamp(1.0, f64::from(u32::MAX));
    // The clamp above is the guard; clippy cannot see through it. Accountable
    // in `check-dirs.mjs`'s table, and load-bearing — `cast_sign_loss` is
    // switched on in `Cargo.toml`, so removing this attribute fails the build.
    #[allow(clippy::cast_sign_loss)]
    let edge = clamped as u32;
    edge
}

/// Read a capture, size it for hand-off, and return PNG bytes.
///
/// Returns `Ok(None)` when the capture is already within the ceiling, so the
/// caller can hand over the original file untouched rather than writing a
/// byte-identical copy of it.
pub fn png_for_handoff(path: &std::path::Path) -> Result<Option<Vec<u8>>, ImageError> {
    let sized = for_handoff(super::load(path)?);
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
    fn an_extreme_aspect_ratio_still_lands_on_the_ceiling() {
        // The long edge is the whole contract of this module, and it was being
        // missed by up to eight pixels: `resize` re-derived its own ratio from
        // the already-rounded pair and rounded a second time, so the short edge
        // rounding down dragged the long edge under the ceiling with it.
        //
        // Two ratios where the second rounding used to bite. Every existing
        // test used dimensions where it happened to cancel.
        for (width, height) in [(10_000_u32, 500_u32), (3_841, 1_000)] {
            let sized = for_handoff(DynamicImage::ImageRgba8(image::RgbaImage::new(
                width, height,
            )));
            assert!(sized.resized);
            assert_eq!(
                sized.image.width().max(sized.image.height()),
                LONG_EDGE,
                "{width}x{height} came out {}x{}",
                sized.image.width(),
                sized.image.height(),
            );
        }
    }

    #[test]
    fn a_capture_over_the_ceiling_is_brought_down_to_it() {
        let sized = for_handoff(image(3840, 2160));
        assert!(sized.resized);
        assert_eq!(sized.image.width(), LONG_EDGE);
        assert_eq!(sized.image.height(), 882, "aspect ratio is preserved");
    }

    #[test]
    fn a_portrait_capture_is_measured_by_its_long_edge_too() {
        let sized = for_handoff(image(1080, 3840));
        assert_eq!(sized.image.height(), LONG_EDGE);
        assert_eq!(sized.image.width(), 441);
    }

    #[test]
    fn a_capture_already_small_enough_is_left_exactly_alone() {
        let sized = for_handoff(image(800, 600));
        assert!(!sized.resized);
        assert_eq!((sized.image.width(), sized.image.height()), (800, 600));
    }

    #[test]
    fn a_capture_exactly_on_the_ceiling_is_not_touched() {
        let sized = for_handoff(image(LONG_EDGE, 400));
        assert!(
            !sized.resized,
            "resizing to the size it already is is pure loss"
        );
    }

    #[test]
    fn nothing_is_ever_enlarged() {
        // A cropped region or a dialog is small on purpose; upscaling it would
        // invent detail that was never captured.
        let sized = for_handoff(image(200, 100));
        assert!(!sized.resized);
        assert_eq!(sized.image.width(), 200);
    }

    #[test]
    fn an_extreme_panorama_keeps_at_least_one_pixel_of_short_edge() {
        // Rounding the short edge to zero produces an image that cannot be
        // encoded at all, turning a cosmetic step into a failed drag.
        //
        // Stated against `scale_edge`, which is the floor this module owns.
        // The assertion this replaces — `sized.image.height() >= 1` on
        // `for_handoff`'s output — could not fail: `image`'s own `resize`
        // floors both output edges at 1 whatever it is handed, so the test
        // named for our guard was passing on the dependency's.
        assert_eq!(
            scale_edge(2, 1000.0 / 9000.0),
            1,
            "rounds to zero without the floor"
        );
        assert_eq!(scale_edge(1, 0.001), 1);
        // And the floor is a floor, not a rounding-up rule.
        assert_eq!(scale_edge(9000, 1000.0 / 9000.0), 1000);

        // Through the real ceiling rather than a made-up one: this used to pass
        // its own `1000`, which was the only place in the crate that varied the
        // parameter — and a parameter varied only by the test that measures it
        // is not configuration.
        let sized = for_handoff(image(9000, 2));
        assert_eq!(sized.image.width(), LONG_EDGE);
    }
}
