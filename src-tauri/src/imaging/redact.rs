//! Destroying a region of a capture.
//!
//! This is the one operation in Shotshelf where doing the job *badly* is
//! actively dangerous, so it is worth being explicit about what "redacted"
//! means here: the pixels are replaced. Not covered, not blurred, not drawn
//! over — replaced, before anything is encoded.
//!
//! Every other approach leaks. A black rectangle drawn as an annotation layer
//! is separable from what it covers. A blur is invertible in principle and
//! frequently legible in practice, especially over text, which is exactly what
//! anyone redacting a screenshot is trying to hide. Pixelation is worse: a
//! mosaic of a known-shape glyph set is close to plaintext.
//!
//! So: flat fill, applied to the decoded image, and the result re-encoded from
//! those pixels. What comes out cannot be undone because the original values
//! are not in it.

use image::{DynamicImage, GenericImage, Rgba};

/// A rectangle to destroy, in image pixels.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    /// Clip to the image, so a region dragged past an edge still redacts what
    /// it actually covers instead of failing or wrapping.
    fn clipped(self, bounds: (u32, u32)) -> Option<Self> {
        let (image_width, image_height) = bounds;
        if self.x >= image_width || self.y >= image_height {
            return None;
        }

        let width = self.width.min(image_width - self.x);
        let height = self.height.min(image_height - self.y);
        if width == 0 || height == 0 {
            return None;
        }

        Some(Self {
            x: self.x,
            y: self.y,
            width,
            height,
        })
    }
}

/// The colour redacted regions are filled with.
///
/// Opaque, and near-black rather than pure black so a redaction is visibly a
/// redaction rather than mistakable for a dark region of the capture itself.
const FILL: Rgba<u8> = Rgba([17, 17, 20, 255]);

/// Replace every pixel in each region.
///
/// Takes the image by value and returns it: there is no version of this that
/// hands back something still referencing the original pixels.
pub fn apply(mut image: DynamicImage, regions: &[Region]) -> DynamicImage {
    let bounds = (image.width(), image.height());

    for region in regions.iter().filter_map(|region| region.clipped(bounds)) {
        for y in region.y..region.y + region.height {
            for x in region.x..region.x + region.width {
                // Bounds already guaranteed by `clipped`, so this cannot panic.
                image.put_pixel(x, y, FILL);
            }
        }
    }

    image
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, GenericImageView, RgbaImage};

    use super::*;

    fn white(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            Rgba([255, 255, 255, 255]),
        ))
    }

    #[test]
    fn a_redacted_region_no_longer_holds_its_original_pixels() {
        let redacted = apply(
            white(10, 10),
            &[Region {
                x: 2,
                y: 2,
                width: 3,
                height: 3,
            }],
        );

        for y in 2..5 {
            for x in 2..5 {
                assert_eq!(
                    redacted.get_pixel(x, y),
                    FILL,
                    "({x},{y}) should be destroyed"
                );
            }
        }
    }

    #[test]
    fn everything_outside_the_region_is_untouched() {
        let redacted = apply(
            white(10, 10),
            &[Region {
                x: 2,
                y: 2,
                width: 3,
                height: 3,
            }],
        );

        assert_eq!(redacted.get_pixel(0, 0), Rgba([255, 255, 255, 255]));
        assert_eq!(
            redacted.get_pixel(5, 5),
            Rgba([255, 255, 255, 255]),
            "exclusive upper bound"
        );
        assert_eq!(redacted.get_pixel(9, 9), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn a_region_dragged_past_the_edge_redacts_what_it_covers() {
        // Dragging a box off the side of the image is the normal way to redact
        // something at the edge; it must not fail or wrap around.
        let redacted = apply(
            white(10, 10),
            &[Region {
                x: 8,
                y: 8,
                width: 999,
                height: 999,
            }],
        );

        assert_eq!(redacted.get_pixel(9, 9), FILL);
        assert_eq!(redacted.get_pixel(7, 7), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn a_region_entirely_outside_the_image_is_ignored() {
        let redacted = apply(
            white(10, 10),
            &[Region {
                x: 50,
                y: 50,
                width: 5,
                height: 5,
            }],
        );
        assert_eq!(redacted.get_pixel(0, 0), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn an_empty_region_does_nothing() {
        let redacted = apply(
            white(10, 10),
            &[Region {
                x: 1,
                y: 1,
                width: 0,
                height: 5,
            }],
        );
        assert_eq!(redacted.get_pixel(1, 1), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn several_regions_are_all_destroyed() {
        let redacted = apply(
            white(10, 10),
            &[
                Region {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                },
                Region {
                    x: 8,
                    y: 8,
                    width: 2,
                    height: 2,
                },
            ],
        );

        assert_eq!(redacted.get_pixel(0, 0), FILL);
        assert_eq!(redacted.get_pixel(9, 9), FILL);
        assert_eq!(redacted.get_pixel(5, 5), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn the_fill_is_opaque() {
        // A fill with any transparency would composite with what is beneath it
        // and leave the original recoverable.
        assert_eq!(FILL.0[3], 255);
    }
}
