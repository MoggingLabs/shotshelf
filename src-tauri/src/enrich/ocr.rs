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
//! * **macOS** — the Vision framework, the same recogniser Preview and Quick
//!   Look use. No permission either: reading a *window title* on macOS needs
//!   Screen Recording, but reading a file you were handed does not.
//! * **Linux** — Tesseract, if it is installed. There is nothing built into
//!   the platform, and vendoring an OCR engine to guarantee a feature almost
//!   nobody on Linux is asking for is a poor trade against the binary size and
//!   the build complexity. Shelling out to a system package it may already
//!   have costs nothing when it is absent.
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
/// Not `const`: on Linux this depends on whether the machine has Tesseract,
/// so it is a question about the running system rather than about the build.
/// `command(async)` because on Linux the first call spawns `tesseract
/// --version` to find out, and a plain command runs inline on the IPC thread —
/// the same rule `prepare_drag` follows, for the same reason.
#[tauri::command(async)]
#[must_use]
pub fn text_recognition_available() -> bool {
    platform::available()
}

/// The most of one capture this will hold in memory at a time.
///
/// Generous for what it is guarding — a 6K screenshot is a few megabytes — and
/// the point is only that there *is* a ceiling. The recognisers below hand the
/// whole file to the OS in a single allocation, and the path reaches them from
/// the webview, so an unbounded read turns one stray path into an
/// out-of-memory kill of the whole app.
///
/// Linux does not need this: tesseract is handed the path and reads the file
/// itself, in its own process.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const MAX_CAPTURE_BYTES: u64 = 96 * 1024 * 1024;

/// Read a capture into memory, refusing one that is implausibly large.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn read_capture(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size > MAX_CAPTURE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{size} bytes is past the ceiling for a single capture"),
        ));
    }

    let mut bytes = Vec::new();
    // Capped a second time on the read itself: the file can grow between the
    // metadata call and here.
    file.take(MAX_CAPTURE_BYTES).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::path::Path;

    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    pub const fn available() -> bool {
        true
    }

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
        let bytes = super::read_capture(path).map_err(|err| {
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

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;

    // `AnyThread` is what puts `alloc` in scope; without it the allocation
    // method the initialiser consumes simply does not exist on the type.
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
    };

    pub const fn available() -> bool {
        true
    }

    /// Vision's text recogniser, run synchronously.
    ///
    /// `performRequests` blocks until the request finishes, which is what this
    /// wants: it already runs on a worker off the catch pipeline, so there is
    /// nothing to gain from threading a completion handler through a module
    /// with one job.
    pub fn recognise(path: &Path) -> Option<String> {
        let bytes = super::read_capture(path).ok()?;

        // Handed the file's bytes rather than a URL: the URL initialiser needs
        // ImageIO, and this way the same read serves any format Vision knows.
        let data = NSData::with_bytes(&bytes);
        let options = NSDictionary::new();
        // No `unsafe` on any of these three: objc2 marks them safe, because an
        // allocation consumed by its own initialiser, a request with no
        // arguments, and reading a property all have no invariant for a caller
        // to uphold. An `unsafe` block that guards nothing is worse than none
        // — it spends the reader's attention on a promise never at risk.
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );

        let request = VNRecognizeTextRequest::new();
        let requests = NSArray::from_slice(&[&*request as &VNRequest]);

        // A failure here is "no text", the same as every other failure in this
        // module — there is nothing a user could do about a codec refusing one
        // screenshot.
        handler.performRequests_error(&requests).ok()?;

        // Only valid once the request has been performed, which it has.
        let results = request.results()?;

        let mut out = String::new();
        for observation in &results {
            let Ok(text) = observation
                .downcast_ref::<VNRecognizedTextObservation>()
                .ok_or(())
            else {
                continue;
            };
            // One candidate: this is a screenshot, not handwriting, and the
            // alternatives are for interactive correction rather than for a
            // scanner deciding whether a token is on screen.
            let candidates = text.topCandidates(1);
            let Some(best) = candidates.iter().next() else {
                continue;
            };

            if !out.is_empty() {
                // One observation per line, joined as they were laid out:
                // layout is most of what makes a stack trace readable.
                out.push('\n');
            }
            out.push_str(&best.string().to_string());
        }

        Some(out)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use std::path::Path;

    /// Tesseract, if the machine has it.
    ///
    /// Shelled out to rather than linked: `leptess` would make an OCR engine a
    /// hard build dependency of an app that is compile-verified on Linux and
    /// run on it by nobody yet, and the binary is a package most distributions
    /// already carry. Absent, this is simply unavailable — which the shelf says
    /// out loud rather than letting an unchecked capture look checked.
    ///
    /// Probed once and remembered: this asks the machine a question, and
    /// spawning a process to re-ask it per capture would be absurd.
    static PRESENT: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
        std::process::Command::new("tesseract")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    });

    pub fn available() -> bool {
        *PRESENT
    }

    /// How long one capture may take before the child is killed.
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
    /// A ceiling on recognised text, which is another program's output.
    const MAX_TEXT: usize = 200_000;

    pub fn recognise(path: &Path) -> Option<String> {
        if !available() {
            return None;
        }

        // `-` writes the text to stdout instead of to a file beside the
        // capture, which matters: the folder being read is a folder Shotshelf
        // is watching, and writing into it would catch our own output.
        let mut child = std::process::Command::new("tesseract")
            .arg(path)
            .arg("-")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;

        // stdout is drained on its own thread for the whole wait, rather than
        // read once the child has exited.
        //
        // A pipe holds on the order of 64 KiB. Polling `try_wait` without
        // reading meant a capture with more text than that filled the buffer,
        // tesseract blocked forever on the write, the child therefore never
        // exited, and the timeout below killed it — so the densest
        // screenshots, which are precisely the ones worth reading for a
        // credential, reliably came back with nothing at all. The failure was
        // invisible: "no text found" and "could not read the text" looked the
        // same from here.
        let mut out = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            // Bounded: this is another program's stdout, and it ends up in a
            // scanner and later in a search index.
            let _ = (&mut out).take(MAX_TEXT as u64).read_to_end(&mut buf);
            // Anything past the ceiling is drained and thrown away rather than
            // left in the pipe, for the same reason: a child blocked on a full
            // pipe never exits, and this one is holding a worker.
            let _ = std::io::copy(&mut out, &mut std::io::sink());
            buf
        });

        // A wedged child would otherwise hold a blocking worker for the life
        // of the process, and the shelf starts one of these per capture.
        let deadline = std::time::Instant::now() + TIMEOUT;
        let finished = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                // Out of time, or the child cannot be waited on at all.
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };

        // Joined on every path, including the kill: closing the pipe ends the
        // read, so this cannot outlive the child it is reading.
        let bytes = reader.join().ok()?;
        if !finished {
            return None;
        }

        let text = String::from_utf8_lossy(&bytes);
        Some(
            text.chars()
                .take(MAX_TEXT)
                .collect::<String>()
                .trim()
                .to_owned(),
        )
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
        //
        // Not asserted to a fixed value: on Linux the answer depends on
        // whether the machine has Tesseract, which is the point.
        let answer = text_recognition_available();
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert!(answer, "both have a recogniser built into the OS");
        }
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
