//! Reading the text in a capture, on this machine.
//!
//! Worth doing because a model reading *characters* is reliable in a way that
//! a model reading pixels of characters is not — a stack trace or an error
//! code handed over as text removes a whole class of misreads — and because
//! text is what makes a shelf searchable and what secret detection scans.
//!
//! Local by construction. There is no cloud OCR here and there will not be:
//! sending every screenshot to a service to find out what it says would invert
//! the one promise this app makes.
//!
//! Per platform:
//!
//! * **Windows** — `Windows.Media.Ocr`, part of the OS since 10. No extra
//!   permission, no model to download, no network.
//! * **macOS** — Vision would do this well, but reading a *window title*
//!   there needs Screen Recording permission and Shotshelf documents that it
//!   does not need it. Vision itself does not, so this is a gap rather than a
//!   refusal; see the note on the stub below.
//! * **Linux** — nothing built in. Tesseract is the obvious candidate and is
//!   a system package rather than something to vendor.
//!
//! Every platform that cannot do it returns `None`, and `None` is ordinary:
//! an unenriched capture behaves exactly as every capture did before.

use std::path::Path;

/// Recognise the text in an image file.
///
/// `None` means "not available or not readable", never "empty page" — a
/// successfully-read image with no text returns `Some("")`, which is a
/// different and useful answer.
#[must_use]
pub fn recognise(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    platform::recognise(path)
}

/// Whether this build can read text at all.
///
/// Asked once at start-up so the shelf can say plainly that credential
/// checking is unavailable here, rather than leaving every capture looking as
/// though it had been checked and come back clean.
#[tauri::command]
#[must_use]
pub const fn text_recognition_available() -> bool {
    platform::AVAILABLE
}

#[cfg(target_os = "windows")]
mod platform {
    use std::path::Path;

    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    pub const AVAILABLE: bool = true;

    /// Windows' own OCR engine, driven synchronously.
    ///
    /// The WinRT calls are asynchronous and are awaited with `.get()` on
    /// purpose: this already runs off the catch pipeline's critical path on a
    /// worker, so a blocking wait here costs nothing and avoids threading an
    /// async runtime through a module that has one job.
    ///
    /// Errors are swallowed into `None` rather than propagated. Every one of
    /// them means the same thing to every caller — no text — and there is no
    /// action a user could take about a codec failure on one screenshot.
    pub fn recognise(path: &Path) -> Option<String> {
        recognise_inner(path).ok()
    }

    fn recognise_inner(path: &Path) -> windows::core::Result<String> {
        // Read through an in-memory stream rather than `StorageFile`, which
        // applies broker rules that do not apply to a desktop app reading a
        // file it was handed by the OS.
        let bytes = std::fs::read(path).map_err(|err| {
            windows::core::Error::new(windows::Win32::Foundation::E_FAIL, err.to_string())
        })?;

        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0)?)?;
        writer.WriteBytes(&bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        stream.Seek(0)?;

        let decoder = BitmapDecoder::CreateWithIdAsync(BitmapDecoder::PngDecoderId()?, &stream);
        // The id is a hint; the decoder sniffs the real format, so a capture
        // written as JPEG under a .png name still decodes.
        let bitmap = decoder?.get()?.GetSoftwareBitmapAsync()?.get()?;

        // The engine follows the user's own language list, which is what makes
        // this work for someone whose screenshots are not in English.
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;

        // `Text()` joins lines with spaces; the per-line text keeps the layout,
        // and layout is most of what makes a stack trace readable.
        let lines = result.Lines()?;
        let mut out = String::new();
        for line in lines {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&line.Text()?.to_string_lossy());
        }
        Ok(out)
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use std::path::Path;

    pub const AVAILABLE: bool = false;

    /// Not yet implemented off Windows.
    ///
    /// macOS could use Vision and Linux could shell out to Tesseract, and both
    /// are worth doing. Neither is stubbed with something that pretends to
    /// work: a scanner that silently finds nothing would make the secret
    /// warning quietly useless on those platforms, which is worse than the
    /// front-end saying plainly that text recognition is unavailable here.
    pub fn recognise(_path: &Path) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_that_is_not_a_file_reads_as_unavailable() {
        assert_eq!(recognise(Path::new("/definitely/not/here.png")), None);
        // A directory is a real path that is not a capture.
        assert_eq!(recognise(Path::new(".")), None);
    }

    #[test]
    fn availability_is_answerable_without_a_capture() {
        // Asked at start-up so the shelf can say plainly that credential
        // checking is off here, rather than letting every unchecked capture
        // look like one that was checked and came back clean.
        assert_eq!(text_recognition_available(), cfg!(target_os = "windows"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_file_that_is_not_an_image_reads_as_nothing_rather_than_panicking() {
        let path = std::env::temp_dir().join("shotshelf-ocr-not-an-image.png");
        std::fs::write(&path, b"this is not a PNG").expect("temp file");

        let result = recognise(&path);

        let _ = std::fs::remove_file(&path);
        assert_eq!(
            result, None,
            "a corrupt capture is ordinary, not exceptional"
        );
    }
}
