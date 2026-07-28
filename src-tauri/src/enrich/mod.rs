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

pub mod foreground;
pub mod ocr;
pub mod secrets;

use serde::Serialize;

/// What Shotshelf worked out about a capture on its own.
///
/// **The recognised text never reaches this struct.** It is the capture's full
/// contents in characters — every token, every address, verbatim — and the
/// whole point of masking a finding is that the value does not spread. It is
/// scanned inside `describe` and dropped there; what survives is the masked
/// findings and whether the capture could be read.
#[derive(Clone, Debug, Default)]
pub struct Enrichment {
    /// Whether the capture could be read at all.
    ///
    /// A `bool`, not the text. The text was kept here on the reasoning that
    /// scanning needed it — but `describe` scans a local before this struct
    /// exists, and the only read of the field anywhere was `.is_some()`. So a
    /// whole screenshot's worth of recognised characters was retained to
    /// answer one question, in the module whose entire purpose is not letting
    /// that text spread. When the shelf becomes searchable this comes back as
    /// a field with a reader.
    pub read: bool,
    /// Anything in that text worth a second look before the capture leaves.
    pub secrets: Vec<secrets::Finding>,
}

/// The part of an [`Enrichment`] that is safe to send to the webview.
///
/// A response DTO shaped to its one caller, rather than "everything
/// enrichment happens to know" — that shape is how the raw text ended up
/// crossing the boundary in the first place.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Findings {
    pub secrets: Vec<secrets::Finding>,
    /// Whether the capture was actually read.
    ///
    /// False means "could not look" — no text recogniser on this platform, or
    /// a file that would not decode — which is a different answer from "looked
    /// and found nothing" and must not be shown as the same thing. Collapsing
    /// the two is how a safety feature becomes silently inert.
    pub scanned: bool,
}

impl From<Enrichment> for Findings {
    fn from(enrichment: Enrichment) -> Self {
        Self {
            scanned: enrichment.read,
            secrets: enrichment.secrets,
        }
    }
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

    Enrichment {
        read: true,
        secrets: secrets::scan(&text),
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
        assert!(!enrichment.read);
        assert!(enrichment.secrets.is_empty());
    }

    #[test]
    fn a_capture_that_could_not_be_read_is_not_reported_as_read_and_clean() {
        // The distinction the whole marker rests on. "No secrets found" and
        // "could not look" are both an empty list, and the only thing telling
        // them apart across the wire is this flag.
        let findings = Findings::from(describe(std::path::Path::new("/nonexistent/capture.png")));
        assert!(!findings.scanned, "an unreadable capture was not scanned");
        assert!(findings.secrets.is_empty());
    }

    #[test]
    fn text_that_was_read_is_reported_as_scanned_even_when_it_is_clean() {
        // Empty text is a real answer — a screenshot of a blank editor — and
        // it must not collapse into "could not look".
        let findings = Findings::from(Enrichment {
            read: true,
            secrets: Vec::new(),
        });
        assert!(findings.scanned);
        assert!(findings.secrets.is_empty());
    }

    #[test]
    fn the_findings_that_cross_the_wire_carry_masked_previews_and_no_text() {
        // `Enrichment` holds the capture's full text; `Findings` is what the
        // webview gets. This pins that the conversion drops the text and keeps
        // the masked previews — the split exists for exactly that reason, and
        // nothing else asserts it.
        let text = "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let enrichment = Enrichment {
            read: true,
            secrets: secrets::scan(text),
        };
        assert!(
            !enrichment.secrets.is_empty(),
            "the fixture has to contain something worth finding",
        );

        let findings = Findings::from(enrichment);
        assert!(findings.scanned);

        let wire = serde_json::to_string(&findings).expect("Findings serialises");
        assert!(
            !wire.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "the secret's value reached the webview: {wire}",
        );
        assert!(
            !wire.contains("\"text\""),
            "recognised text reached the webview: {wire}"
        );
    }
}
