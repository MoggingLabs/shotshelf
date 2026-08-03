//! Pixel work.
//!
//! One rule governs everything in here, and it is the same rule the rest of
//! Shotshelf lives by: **the capture on disk is never modified**. Every
//! function below reads a file and produces new bytes. Nothing writes back
//! over its source, and nothing deletes anything.
//!
//! Where those new bytes go is the caller's business — a temporary file for a
//! drag, or a new capture on the shelf beside the original.

pub mod compare;
pub mod export;

use std::path::Path;

use image::{DynamicImage, ImageFormat, ImageReader};

/// A rectangle in image pixels.
///
/// Here rather than inside whichever feature first needed a rectangle: a plain
/// shape is not owned by the module that happened to define it, and reaching
/// sideways for one made `changed_regions() -> Vec<Region>` read, against that
/// type's own documentation, as "regions to destroy".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Anything that can go wrong touching pixels.
///
/// A single error type across the module because every caller treats these the
/// same way: the operation is optional polish, so it is reported and the
/// original capture is used instead.
#[derive(Debug)]
pub enum ImageError {
    Read(String),
    Decode(String),
    Encode(String),
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(why) => write!(f, "could not read the capture: {why}"),
            Self::Decode(why) => write!(f, "could not decode the capture: {why}"),
            Self::Encode(why) => write!(f, "could not encode the result: {why}"),
        }
    }
}

/// Serialised to the front-end, which reports failures rather than swallowing
/// them — an export that silently handed over the wrong file would be worse
/// than one that refused.
///
/// No `impl std::error::Error`: nothing here takes an `ImageError` as
/// `Box<dyn Error>`, calls `source()`, or `?`s it into a boxed error, and this
/// conversion needs `Display` alone. It carried one anyway, and no gate could
/// see it — rustc's `dead_code` lint does not analyse trait impls, so an unused
/// impl is invisible in a way an unused `fn` is not. The impl comes back in the
/// same diff as the caller that needs it.
impl From<ImageError> for String {
    fn from(error: ImageError) -> Self {
        error.to_string()
    }
}

/// Decode a capture off disk.
///
/// The format is sniffed from the file's contents rather than trusted from its
/// extension: screen-capture tools are not consistent about what they write,
/// and a PNG named `.jpg` is common enough to be worth surviving.
pub fn load(path: &Path) -> Result<DynamicImage, ImageError> {
    let mut reader = ImageReader::open(path)
        .map_err(|err| ImageError::Read(err.to_string()))?
        .with_guessed_format()
        .map_err(|err| ImageError::Read(err.to_string()))?;

    // Bounded, because the path comes from the webview.
    //
    // A PNG's header can promise far more pixels than its bytes, and decoding
    // is where that promise is honoured — so a small file becomes an
    // allocation the size of whatever it claimed.
    //
    // The dimension caps are the new part, and the ones that matter here:
    // `ImageReader::open` already installs `Limits::default()`, so this path
    // was never the unbounded decoder it looked like — but the default caps
    // *bytes* and nothing else, and 512 MiB of allocation is a great many
    // pixels to hand a resize. The byte ceiling below is stated rather than
    // inherited, and deliberately equals the default: an earlier version set
    // it to 1 GiB, which quietly doubled the protection it was overriding.
    //
    // `compare_captures` is the worst case and it is more than twice this
    // number, which is what an earlier version of this comment said. It holds
    // two decoded inputs, plus a composite that `compare.rs` describes as
    // "larger than both inputs put together" and caps separately at 512 MiB,
    // plus the encoded PNG on top — so roughly four allocations of this order,
    // not two. `limits::SIZING` admits two such commands at once.
    //
    // Nothing is unbounded: `compare::composite_size` computes in `u64` and
    // refuses past its own ceiling. The number was simply understated, in the
    // one place someone would look it up.
    //
    // The dimension cap is generous: an 8K display is 7680 wide, and a
    // stitched or multi-monitor capture is legitimately larger still.
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_DECODE_EDGE);
    limits.max_image_height = Some(MAX_DECODE_EDGE);
    reader.limits(limits);

    reader
        .decode()
        .map_err(|err| ImageError::Decode(err.to_string()))
}

/// A capture's width divided by its height, without decoding it.
///
/// `into_dimensions` reads the header and stops, so this costs a file open and
/// a few dozen bytes where [`load`] would cost a full bitmap. That difference
/// is the whole reason it exists: the editor window is sized from the capture's
/// shape before anything is displayed, and holding a 4K image in memory to
/// choose a window size would be an absurd way to pay for it.
///
/// `None` for anything that cannot be read or measured — a missing file, a
/// format the decoders do not know, a zero height. Every caller has a sane
/// default, and none of them should treat "I could not size this window
/// perfectly" as a failure worth reporting.
pub fn aspect_of(path: &Path) -> Option<f64> {
    let (width, height) = ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    if height == 0 {
        return None;
    }
    Some(f64::from(width) / f64::from(height))
}

/// The most a single decode may allocate. Matches the `image` crate's own
/// default, stated here so overriding the other limits cannot silently raise it.
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;
/// The longest edge a capture may claim.
const MAX_DECODE_EDGE: u32 = 32_768;

/// Encode to PNG bytes.
///
/// PNG throughout, whatever came in. These are screenshots — text, edges and
/// flat colour — and JPEG puts ringing around exactly the parts a screenshot
/// exists to show. A recompressed screenshot handed to a model is a screenshot
/// with its smallest text made harder to read.
pub fn to_png(image: &DynamicImage) -> Result<Vec<u8>, ImageError> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|err| ImageError::Encode(err.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use image::RgbaImage;

    use super::*;

    /// A directory of this test's own, since these write real files.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shotshelf-imaging-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the scratch directory is created");
        dir
    }

    /// Write `image` to `path` as PNG, whatever the extension says.
    fn written(path: &std::path::Path, image: &DynamicImage) {
        std::fs::write(path, to_png(image).expect("the fixture encodes"))
            .expect("the fixture writes");
    }

    /// A picture with a huge edge but almost no pixels — one row is 4 bytes
    /// each, so 32769 of them is 128 KiB, not a bomb. The point is the *claimed*
    /// dimension, which is what the cap reads.
    fn wide(width: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::new(width, 1))
    }

    #[test]
    fn a_capture_past_the_edge_cap_is_refused_rather_than_decoded() {
        // This module had no test of any kind, and the cap is not decoration:
        // `compare.rs` cites it three times as the reason its own allocation
        // arithmetic cannot overflow. Deleting the `reader.limits(limits)` line
        // left every gate in the repository green.
        //
        // The two cases together are what make this bite. Only the refusal, and
        // a mutant that refused *everything* would pass; only the acceptance,
        // and a mutant that removed the cap would pass.
        let dir = scratch("edge");

        let over = dir.join("over.png");
        written(&over, &wide(MAX_DECODE_EDGE + 1));
        assert!(
            load(&over).is_err(),
            "a capture claiming more than {MAX_DECODE_EDGE} pixels on an edge was decoded",
        );

        let at = dir.join("at.png");
        written(&at, &wide(MAX_DECODE_EDGE));
        assert!(
            load(&at).is_ok(),
            "a capture exactly at the cap is legitimate and must still decode",
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_stated_allocation_ceiling_is_the_one_it_claims_to_match() {
        // The constant's comment says it "matches the `image` crate's own
        // default, stated here so overriding the other limits cannot silently
        // raise it" — and an earlier version set it to 1 GiB, quietly doubling
        // the protection it was overriding. Nothing checked that claim, so the
        // same edit would land the same way again, and a dependency bump that
        // lowered the default would go unnoticed in the other direction.
        assert_eq!(
            Some(MAX_DECODE_BYTES),
            image::Limits::default().max_alloc,
            "this no longer matches the default it says it matches",
        );
    }

    #[test]
    fn the_format_is_read_from_the_bytes_not_from_the_extension() {
        // `load`'s docstring promises this — "a PNG named `.jpg` is common
        // enough to be worth surviving" — and nothing exercised it. Dropping
        // `with_guessed_format()` keeps every other test passing, because every
        // other fixture is named honestly.
        let dir = scratch("sniff");
        let lying = dir.join("actually-a-png.jpg");
        written(&lying, &wide(8));

        let decoded = load(&lying).expect("a PNG is decoded whatever it is called");
        assert_eq!(decoded.width(), 8);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_capture_that_is_not_an_image_is_reported_rather_than_panicking() {
        let dir = scratch("garbage");
        let path = dir.join("not-an-image.png");
        std::fs::write(&path, b"this is not a picture").expect("the fixture writes");

        assert!(matches!(
            load(&path),
            Err(ImageError::Read(_) | ImageError::Decode(_))
        ));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_capture_that_is_not_there_is_a_read_error() {
        let missing = std::env::temp_dir().join("shotshelf-imaging-absent-000.png");
        assert!(matches!(load(&missing), Err(ImageError::Read(_))));
    }

    #[test]
    fn every_failure_says_which_stage_it_came_from() {
        // The variants are what the front end shows the user, and `From<_> for
        // String` is the only thing between them and the card. A variant that
        // rendered as the wrong stage would send someone looking in the wrong
        // place.
        assert_eq!(
            String::from(ImageError::Read("gone".to_owned())),
            "could not read the capture: gone",
        );
        assert_eq!(
            String::from(ImageError::Decode("truncated".to_owned())),
            "could not decode the capture: truncated",
        );
        assert_eq!(
            String::from(ImageError::Encode("full".to_owned())),
            "could not encode the result: full",
        );
    }

    #[test]
    fn encoding_round_trips_through_png_whatever_came_in() {
        // The module encodes PNG throughout on purpose — JPEG rings around the
        // text a screenshot exists to show — so the bytes must sniff back as
        // PNG rather than merely as something decodable.
        let source = DynamicImage::ImageRgba8(RgbaImage::new(3, 5));
        let bytes = to_png(&source).expect("it encodes");

        assert_eq!(
            image::guess_format(&bytes).expect("the bytes are a known format"),
            ImageFormat::Png,
        );

        let back = ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .expect("the format is guessed")
            .decode()
            .expect("it decodes");
        assert_eq!((back.width(), back.height()), (3, 5));
    }
}
