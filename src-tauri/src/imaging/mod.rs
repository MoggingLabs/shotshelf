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

impl std::error::Error for ImageError {}

/// Serialised to the front-end, which reports failures rather than swallowing
/// them — an export that silently handed over the wrong file would be worse
/// than one that refused.
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
    // `compare_captures` decodes two of these in one blocking task, so the
    // real ceiling for that command is twice this number.
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
