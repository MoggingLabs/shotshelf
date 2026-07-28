//! Making a capture describe itself.
//!
//! A screenshot arrives as pixels and a filename, and the filename is a
//! timestamp. Everything useful about it — what it says, which app it came
//! from, whether it is safe to send — is knowable locally and is not written
//! down anywhere. This module works it out.
//!
//! Two things follow from doing it here rather than anywhere else. Shotshelf
//! is the last purely local step before a capture goes somewhere, which is the
//! only place a credential warning can still help. And it is the only thing
//! that sees the *stream* of captures rather than one file, which is what
//! makes "these two are a before and an after" answerable at all.
//!
//! Nothing here is on the critical path. A capture appears on the shelf the
//! moment it lands; enrichment catches up and fills it in.

pub mod ocr;
pub mod secrets;

use serde::Serialize;

/// What Shotshelf worked out about a capture on its own.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrichment {
    /// Text recognised in the capture, if the platform can.
    ///
    /// Kept whole rather than summarised: it is what makes the shelf
    /// searchable, and what can be handed to a model alongside the picture so
    /// it reads characters instead of guessing at pixels.
    pub text: Option<String>,
    /// Anything in that text worth a second look before the capture leaves.
    pub secrets: Vec<secrets::Finding>,
}

/// Read a capture and work out what can be worked out.
///
/// Failure is not an error worth surfacing: an unenriched capture is exactly
/// as useful as every capture was before this module existed. It drags out,
/// copies and pins the same way.
pub fn describe(path: &std::path::Path) -> Enrichment {
    let Some(text) = ocr::recognise(path) else {
        return Enrichment::default();
    };

    let findings = secrets::scan(&text);
    Enrichment {
        text: Some(text),
        secrets: findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_that_cannot_be_read_enriches_to_nothing_rather_than_failing() {
        // Every platform without OCR takes this path, as does every
        // unreadable file. It has to be ordinary, not exceptional.
        let enrichment = describe(std::path::Path::new("/nonexistent/capture.png"));
        assert!(enrichment.text.is_none());
        assert!(enrichment.secrets.is_empty());
    }
}
