//! Noticing when a capture is carrying a credential.
//!
//! Shotshelf sits at the last moment a capture is purely local. Everything
//! after it — a drag into a chat, a paste into an issue — puts the pixels
//! somewhere else, and screenshots of a working machine routinely contain a
//! token, a `.env`, a connection string, a customer's address.
//!
//! Two design rules, both load-bearing:
//!
//! **This never blocks.** It flags. A false positive that refuses to let you
//! drag a screenshot is a tool people uninstall, and a scanner people
//! uninstall protects nobody. The user is always right about their own screen.
//!
//! **A finding never repeats the secret.** The whole point is to stop the
//! value spreading, so putting it in a tooltip, a log line or an error message
//! would be self-defeating. Findings carry a masked preview — enough to say
//! *which* one, never enough to use.
//!
//! The input is recognised text, so it is noisy: OCR misreads `l` as `1`, drops
//! characters, and joins words. That makes false *negatives* routine, which is
//! why this is a seatbelt and not a guarantee — and why the patterns below are
//! anchored on distinctive prefixes rather than on entropy, which OCR destroys.

use std::sync::LazyLock;

use regex::Regex;

/// What kind of thing was found, in rough order of how alarming it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    /// A private key block. Nothing else looks like this; it is never a
    /// false positive.
    PrivateKey,
    /// A credential issued by a named service, matched on its own prefix.
    ServiceToken,
    /// A signed token — JWTs turn up in devtools and network tabs constantly.
    Jwt,
    /// `SOMETHING_SECRET=value` in a shell, a `.env`, or a config file.
    Assignment,
    /// Personal data rather than a credential: lower stakes, still worth a nudge.
    PersonalData,
}

impl SecretKind {
    /// Whether a finding is certain enough to lead with.
    ///
    /// Personal data is a nudge; a private key is a stop-and-look. The
    /// front-end sorts on this so the worst thing is what you see first.
    #[must_use]
    pub fn severity(self) -> u8 {
        match self {
            Self::PrivateKey => 4,
            Self::ServiceToken => 3,
            Self::Jwt => 2,
            Self::Assignment => 2,
            Self::PersonalData => 1,
        }
    }
}

/// One thing worth looking at before this capture leaves the machine.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub kind: SecretKind,
    /// What it is, in words: "GitHub personal access token".
    pub label: &'static str,
    /// Masked. Never the value itself.
    pub preview: String,
    /// How alarming this is, on the wire.
    ///
    /// Sent rather than left implicit in the order of the list. The front-end
    /// shows the worst finding first, and making that depend on a `sort` two
    /// process boundaries away meant anything that touched the list in
    /// between — a cache, a dedupe, a second producer — silently broke it
    /// with no test failing.
    pub severity: u8,
}

struct Pattern {
    kind: SecretKind,
    label: &'static str,
    regex: Regex,
    /// How much of a match is the type marker rather than the credential.
    ///
    /// A per-pattern length because it *is* per-pattern: `ghp_` is four
    /// characters and `xoxb-` is five. A single constant across all of them
    /// showed two to four characters of credential body in every preview —
    /// the module's stated rule is "keep only the part that names it", and a
    /// fixed seven does not implement that rule for any pattern but the
    /// longest.
    marker: usize,
}

/// Patterns anchored on distinctive prefixes rather than on entropy.
///
/// Entropy scoring is the usual approach and the wrong one here: OCR flattens
/// exactly the character distinctions entropy depends on, and a base64 blob in
/// a screenshot is as likely to be a data URI or a hash as a credential. A
/// prefix like `ghp_` is unambiguous, survives a misread of the payload, and
/// almost never appears by accident.
static PATTERNS: LazyLock<Vec<Pattern>> = LazyLock::new(|| {
    let compile = |kind, label, marker, source: &str| Pattern {
        kind,
        label,
        marker,
        // These are fixed literals in this file, not user input; a failure here
        // is a programming error and should be loud at first use.
        regex: Regex::new(source).expect("shotshelf: built-in secret pattern is invalid"),
    };

    vec![
        compile(
            SecretKind::PrivateKey,
            "private key",
            "-----BEGIN".len(),
            r"-----BEGIN[ A-Z]*PRIVATE KEY-----",
        ),
        compile(
            SecretKind::ServiceToken,
            "GitHub token",
            4,
            r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "OpenAI or Anthropic API key",
            3,
            r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "AWS access key ID",
            4,
            r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Google API key",
            4,
            r"\bAIza[A-Za-z0-9_-]{35}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Slack token",
            5,
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Stripe secret key",
            3,
            r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b",
        ),
        compile(
            SecretKind::Jwt,
            "signed token",
            3,
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        ),
        compile(
            SecretKind::Assignment,
            "secret in a config value",
            0,
            // The name carries the signal. A value of at least eight
            // non-space characters keeps `PASSWORD=` in a blank template from
            // being reported as a leak.
            r"(?i)\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*\S{8,}",
        ),
        compile(
            SecretKind::PersonalData,
            "email address",
            0,
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        ),
    ]
});

/// The most findings one capture will report.
///
/// A screenshot of a contact list is thousands of distinct addresses, and the
/// whole list crosses IPC and becomes a tooltip. Past a handful the warning has
/// already made its point.
///
/// What this bounds, precisely: the IPC payload and the tooltip. It is applied
/// after the scan, so the working set during the scan is *not* bounded by it —
/// `seen` holds one owned copy of every distinct raw match, which for that
/// contact list is every address on screen at once, in the module written to
/// stop those values spreading.
///
/// Left that way on purpose rather than by oversight. Truncating during the
/// loop would bound it, but findings are ordered worst-first *after*
/// collection, so stopping early would let fifty email addresses hide a private
/// key found further down — trading a bounded allocation for a missed
/// credential. The real bound is the length of the recognised text, which is
/// itself bounded on Linux by `ocr::MAX_TEXT`; on Windows and macOS it is
/// whatever the platform recogniser returns, in practice tens of kilobytes.
/// `regex` is linear, so there is no hang either way.
const MAX_FINDINGS: usize = 50;

/// Scan recognised text for anything worth a second look.
///
/// Findings are deduplicated and ordered worst-first, so a caller showing only
/// one is showing the one that matters, and capped at [`MAX_FINDINGS`].
#[must_use]
pub fn scan(text: &str) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for pattern in PATTERNS.iter() {
        for hit in pattern.regex.find_iter(text) {
            let finding = Finding {
                kind: pattern.kind,
                label: pattern.label,
                preview: mask(pattern.kind, hit.as_str(), pattern.marker),
                severity: pattern.kind.severity(),
            };
            // The same secret printed twice on one screen is one problem.
            //
            // Keyed on the **matched text**, which is the only thing that says
            // whether two hits are the same secret. Keying on the `Finding`
            // looked equivalent and was not: its only varying field is the
            // *masked* preview, so every GitHub token reduces to `ghp_…` and
            // five distinct credentials on one screen collapsed into a single
            // warning with no count. The raw match never leaves this function.
            //
            // A set rather than a scan of the vec, because the case the
            // ceiling exists for — a screenshot of a contact list — was also
            // the case that made the scan quadratic.
            if seen.insert(hit.as_str().to_owned()) {
                findings.push(finding);
            }
        }
    }

    // Reverse severity: the worst thing is what you see first.
    findings.sort_by_key(|finding| std::cmp::Reverse(finding.severity));
    // Truncated *after* sorting, so what survives is the most serious of what
    // was found rather than whichever pattern happened to run first.
    //
    // Bounding inside the loop instead looked tidier and broke both halves of
    // that: `break` left the *inner* loop only, so each remaining pattern
    // could add one more and the real ceiling was 59 — and which findings
    // survived depended on `PATTERNS` happening to be listed worst-first, a
    // dependency nothing stated or enforced.
    findings.truncate(MAX_FINDINGS);
    findings
}

/// Enough of a match to recognise it, never enough to use it.
///
/// What is safe to show depends on *where the value starts*, which differs by
/// kind — and one rule across all of them leaked. A fixed seven-character
/// prefix is right for a token, where those characters are a type marker
/// (`ghp_`, `sk-ant-`) and not the credential. It is wrong for
/// `TOKEN=abcdefgh`, where it showed the first character of the secret, and
/// badly wrong for an email, where it showed most of the address — into the
/// very tooltip this module exists to keep it out of.
///
/// So each kind keeps only the part that names it:
///
/// * tokens and keys — the type prefix, tail dropped entirely, because a known
///   prefix *plus* a known suffix is a materially smaller search space than
///   either alone;
/// * an assignment — the variable's name, never any of its value;
/// * an email — the domain, never the local part, which is the identifying half.
fn mask(kind: SecretKind, value: &str, marker: usize) -> String {
    match kind {
        SecretKind::Assignment => mask_assignment(value),
        SecretKind::PersonalData => mask_email(value),
        SecretKind::PrivateKey | SecretKind::ServiceToken | SecretKind::Jwt => {
            mask_prefix(value, marker)
        }
    }
}

/// Keep exactly the type marker, drop the rest.
///
/// `keep` is the marker's own length, so nothing after it survives. A constant
/// here — seven, as it was — leaves two to four characters of the credential
/// showing for every pattern whose marker is shorter than that.
fn mask_prefix(value: &str, keep: usize) -> String {
    if value.chars().count() <= keep || keep == 0 {
        // Nothing here is long enough for any of it to be safe.
        return "•".repeat(value.chars().count().clamp(1, 8));
    }

    let visible: String = value.chars().take(keep).collect();
    format!("{visible}…")
}

/// `DATABASE_PASSWORD=hunter2` → `DATABASE_PASSWORD=•••`.
///
/// The name is the useful half — it tells you *what* is exposed — and it is
/// not itself a credential. The value is never shown at any length.
fn mask_assignment(value: &str) -> String {
    match value.find(['=', ':']) {
        Some(split) => format!("{}{}•••", &value[..split], &value[split..=split]),
        // No separator means the pattern matched something unexpected; show
        // nothing rather than guess which half was the secret.
        None => "•••".to_owned(),
    }
}

/// `someone@example.com` → `•••@example.com`.
///
/// The local part identifies the person and is dropped whole; the domain says
/// enough to recognise which address without being the address.
fn mask_email(value: &str) -> String {
    match value.rfind('@') {
        Some(at) => format!("•••{}", &value[at..]),
        None => "•••".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_different_secrets_that_mask_alike_stay_two_findings() {
        // The masked preview is identical for every token of a kind, so
        // keying the dedupe on the `Finding` collapsed distinct credentials
        // into one warning — telling the user a single secret is exposed when
        // several are.
        let text = concat!(
            "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
",
            "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
",
        );

        assert_eq!(scan(text).len(), 2);
    }

    #[test]
    fn the_same_secret_twice_is_one_finding() {
        let token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let text = format!(
            "{token}
and again: {token}
"
        );

        assert_eq!(scan(&text).len(), 1);
    }

    #[test]
    fn a_capture_full_of_findings_reports_the_worst_of_them_and_stops() {
        // A screenshot of a contact list is thousands of distinct addresses,
        // and every one of them crossed IPC and became a tooltip.
        let mut text = String::from(
            "-----BEGIN RSA PRIVATE KEY-----
",
        );
        // Addresses at *different* domains, so each is a distinct finding.
        // An earlier version used 400 addresses at one domain: they all mask
        // to the same preview, deduped to a single finding, and the scan
        // returned two — so the assertion below passed with the cap deleted
        // outright, which is the opposite of what this test is named for.
        for n in 0..400 {
            text.push_str(&format!(
                "person@example{n}.com
"
            ));
        }

        let findings = scan(&text);
        assert!(
            findings.len() > 1,
            "the fixture must produce more than one finding to bound",
        );
        assert!(
            findings.len() <= MAX_FINDINGS,
            "{} findings",
            findings.len()
        );
        // And the private key is still the first thing reported.
        assert_eq!(
            findings.first().map(|f| f.kind),
            Some(SecretKind::PrivateKey)
        );
    }

    #[test]
    fn the_kinds_on_the_wire_are_the_ones_the_front_end_knows() {
        // `SecretKind` is declared four times — here, as a TypeScript union, as
        // CSS selectors, and as strings in the e2e specs — and nothing joined
        // them. Renaming a variant compiled on both sides, silently stopped
        // matching a CSS rule, and rendered a warning in the wrong colour, with
        // every gate green. This and `src/shelf/types.test.ts` assert against
        // one fixture, so a rename fails on whichever side forgot.
        let expected: Vec<String> =
            serde_json::from_str(include_str!("../../../tests/fixtures/secret-kinds.json"))
                .expect("the shared kinds fixture parses");

        // Exhaustive by the compiler. The list used to be a bare array
        // literal, so a sixth variant was simply absent from it: the array
        // agreed with the fixture, the fixture agreed with TypeScript, and the
        // new kind rendered with no CSS rule at all — which is the exact
        // failure the comment above describes, left open by the test written
        // to close it.
        //
        // The `match` is what makes that impossible: adding a variant stops
        // this compiling until it is named here, and naming it here fails the
        // assertion until the shared fixture and the TypeScript union agree.
        let all = [
            SecretKind::PrivateKey,
            SecretKind::ServiceToken,
            SecretKind::Jwt,
            SecretKind::Assignment,
            SecretKind::PersonalData,
        ];
        for kind in all {
            // No wildcard arm — that is the whole mechanism.
            match kind {
                SecretKind::PrivateKey
                | SecretKind::ServiceToken
                | SecretKind::Jwt
                | SecretKind::Assignment
                | SecretKind::PersonalData => {}
            }
        }

        let ours: Vec<String> = all
            .iter()
            .map(|kind| {
                serde_json::to_value(kind)
                    .expect("a kind serialises")
                    .as_str()
                    .expect("as a string")
                    .to_owned()
            })
            .collect();

        assert_eq!(
            ours, expected,
            "the wire names have drifted from the fixture"
        );
    }

    fn kinds(text: &str) -> Vec<SecretKind> {
        scan(text).into_iter().map(|finding| finding.kind).collect()
    }

    #[test]
    fn a_github_token_is_found() {
        let text = "export GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
        assert!(kinds(text).contains(&SecretKind::ServiceToken));
    }

    #[test]
    fn an_anthropic_key_is_found() {
        assert!(kinds("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx").contains(&SecretKind::ServiceToken));
    }

    #[test]
    fn an_aws_access_key_is_found() {
        assert!(kinds("AKIAIOSFODNN7EXAMPLE").contains(&SecretKind::ServiceToken));
    }

    #[test]
    fn a_private_key_block_is_found() {
        let text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza...";
        assert_eq!(kinds(text).first(), Some(&SecretKind::PrivateKey));
    }

    #[test]
    fn a_signed_token_is_found() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert!(kinds(jwt).contains(&SecretKind::Jwt));
    }

    #[test]
    fn a_config_assignment_is_found() {
        assert!(kinds("DATABASE_PASSWORD=hunter2hunter2").contains(&SecretKind::Assignment));
        assert!(kinds("api_key: 9f8e7d6c5b4a3210").contains(&SecretKind::Assignment));
    }

    #[test]
    fn an_empty_placeholder_is_not_a_leak() {
        // A blank template is the most common thing on a developer's screen.
        assert!(scan("PASSWORD=").is_empty());
        assert!(scan("API_KEY = ").is_empty());
    }

    #[test]
    fn ordinary_screen_text_is_not_flagged() {
        let text = "\
            error[E0425]: cannot find function `round_corners` in this scope\n\
            npm run build && vite preview --port 4173\n\
            The quick brown fox jumps over the lazy dog.";
        assert!(
            scan(text).is_empty(),
            "a scanner that cries wolf gets uninstalled"
        );
    }

    #[test]
    fn a_finding_never_carries_the_secret() {
        let secret = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
        let findings = scan(secret);

        assert_eq!(findings.len(), 1);
        let preview = &findings[0].preview;
        assert!(
            !preview.contains("Q7r8"),
            "the tail must not survive: {preview}"
        );
        // Stated as two separate properties. Combined into one `||` they
        // cancelled: the length clause was unconditionally true, so the
        // containment clause — the actual safety property — never ran, and a
        // preview leaking four characters of credential passed for weeks.
        let shown = preview.trim_end_matches('…');
        assert_eq!(shown, "ghp_", "only the marker may survive, got {shown}");
        assert!(
            secret.starts_with(shown),
            "the marker is the head of the match: {shown}"
        );
        assert!(
            preview.starts_with("ghp_"),
            "the prefix is what names it: {preview}"
        );
    }

    #[test]
    fn a_short_match_is_masked_completely() {
        // Nothing here is long enough for a prefix to be safe.
        assert_eq!(mask(SecretKind::ServiceToken, "abc", 4), "•••");
        assert_eq!(mask(SecretKind::ServiceToken, "", 4), "•");
    }

    #[test]
    fn an_assignment_shows_its_name_and_none_of_its_value() {
        // A fixed prefix rule showed `TOKEN=a…` here — one character of the
        // credential, in the tooltip this module exists to keep it out of.
        let masked = mask(
            SecretKind::Assignment,
            "DATABASE_PASSWORD=hunter2hunter2",
            0,
        );
        assert_eq!(masked, "DATABASE_PASSWORD=•••");
        assert!(
            !masked.contains('h'),
            "no part of the value survives: {masked}"
        );

        assert_eq!(
            mask(SecretKind::Assignment, "api_key: 9f8e7d6c", 0),
            "api_key:•••"
        );
    }

    #[test]
    fn an_email_keeps_its_domain_and_loses_the_person() {
        // A fixed prefix rule showed `bob@exa…` — most of the address.
        let masked = mask(SecretKind::PersonalData, "someone@example.com", 0);
        assert_eq!(masked, "•••@example.com");
        assert!(!masked.contains("someone"));
    }

    /// One sample per shipped pattern, and the **exact** preview it may
    /// produce.
    ///
    /// Joined to `PATTERNS` by label, and asserted in both directions, because
    /// the previous version of this test carried its own copy of each `marker`
    /// and so could only ever agree with itself. Every `marker` is a
    /// credential-disclosure decision — `mask_prefix` shows exactly that many
    /// characters, verbatim — and the shipped table had ten of them with one
    /// covered end to end. Raising `"Google API key"` from 4 to 30 would have
    /// put thirty characters of a live key into the card tooltip with every
    /// gate green, in the module whose stated rule is that a finding never
    /// repeats the secret.
    ///
    /// Exact equality, not `!contains(…)`: a containment check passes for any
    /// marker that happens to stop before the fixture's chosen tail, so it
    /// tests the fixture rather than the rule.
    const SAMPLES: &[(&str, &str, &str, &str)] = &[
        (
            "private key",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN\u{2026}",
            "PRIVATE KEY",
        ),
        (
            "GitHub token",
            "ghp_A1b2C3d4E5f6G7h8I9j0",
            "ghp_\u{2026}",
            "A1b2",
        ),
        (
            "OpenAI or Anthropic API key",
            "sk-ant-A1b2C3d4E5f6G7h8",
            "sk-\u{2026}",
            "ant-",
        ),
        (
            "AWS access key ID",
            "AKIAIOSFODNN7EXAMPLE",
            "AKIA\u{2026}",
            "IOSF",
        ),
        (
            "Google API key",
            // Exactly 35 characters after `AIza`, which is what the pattern
            // requires — a sample two characters long matched nothing, and the
            // test said so rather than passing on an empty result.
            "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
            "AIza\u{2026}",
            "SyA1",
        ),
        (
            "Slack token",
            "xoxb-A1b2C3d4E5f6G7h8",
            "xoxb-\u{2026}",
            "A1b2",
        ),
        (
            "Stripe secret key",
            "sk_live_A1b2C3d4E5f6G7h8",
            "sk_\u{2026}",
            "live",
        ),
        (
            "signed token",
            "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK",
            "eyJ\u{2026}",
            "hbGc",
        ),
        (
            "secret in a config value",
            "API_KEY=A1b2C3d4E5f6",
            "API_KEY=\u{2022}\u{2022}\u{2022}",
            "A1b2",
        ),
        (
            "email address",
            "someone@example.com",
            "\u{2022}\u{2022}\u{2022}@example.com",
            // The *person*, not the tail. Keeping the domain is this rule's
            // documented behaviour, so "the last few characters never appear"
            // is false here — and was standing in for the real question.
            "someone",
        ),
    ];

    #[test]
    fn every_shipped_pattern_has_a_sample_and_no_sample_is_stale() {
        // The coverage half. Without it, adding an eleventh pattern — the way
        // every one of the ten arrived — silently adds an unverified
        // disclosure decision, and the test below still passes.
        // Exactly one sample per pattern, and exactly one pattern per label.
        //
        // `any(â€¦)` alone counted a *label* as covered, so an eleventh pattern
        // reusing an existing label â€” the natural way to add a second spelling
        // of the same credential â€” was covered by the first one's sample and
        // its own `marker` was never exercised. That is the whole failure this
        // test exists to prevent, reachable by adding a pattern the way every
        // pattern here was added.
        for pattern in PATTERNS.iter() {
            let covering = SAMPLES
                .iter()
                .filter(|(label, ..)| *label == pattern.label)
                .count();
            assert_eq!(
                covering, 1,
                "the shipped pattern {:?} has {covering} samples; it needs exactly one",
                pattern.label,
            );
        }

        // And the labels are distinct, so "one sample per label" means "one
        // sample per pattern". Without this, two patterns sharing a label each
        // see one sample and the count above still passes.
        for pattern in PATTERNS.iter() {
            let sharing = PATTERNS
                .iter()
                .filter(|other| other.label == pattern.label)
                .count();
            assert_eq!(
                sharing, 1,
                "{:?} labels {sharing} patterns; a label names one rule",
                pattern.label,
            );
        }
        for (label, ..) in SAMPLES {
            assert!(
                PATTERNS.iter().any(|pattern| pattern.label == *label),
                "sample {label:?} names no shipped pattern",
            );
        }
    }

    #[test]
    fn no_shipped_pattern_shows_more_than_its_type_marker() {
        // Through `scan`, not `mask`: the preview a card actually renders is
        // the product of the pattern's own marker travelling through the whole
        // pipeline, and only one of the ten was ever checked that far.
        for (label, sample, expected, secret) in SAMPLES {
            let findings = scan(sample);
            let found = findings
                .iter()
                .find(|finding| finding.label == *label)
                .unwrap_or_else(|| panic!("{label:?} did not match its own sample {sample:?}"));

            assert_eq!(
                found.preview, *expected,
                "{label:?} previewed {:?} for {sample:?}",
                found.preview,
            );
            // The belt, independent of the marker: the secret-bearing part of
            // the sample never appears in the rendered string.
            //
            // Named per sample rather than computed as "the last six
            // characters". That version was written `.rev().take(6)`, which
            // yields the tail *reversed* — no preview can contain it, so it
            // held even against a preview that leaked the sample whole.
            // Corrected, it then failed on the email rule, which keeps the
            // domain deliberately: the tail was never the question. This is.
            assert!(
                !found.preview.contains(secret),
                "{label:?} leaked {secret:?}: {:?}",
                found.preview,
            );
        }
    }

    #[test]
    fn the_same_secret_printed_twice_is_one_finding() {
        let key = "AKIAIOSFODNN7EXAMPLE";
        assert_eq!(scan(&format!("{key} and again {key}")).len(), 1);
    }

    #[test]
    fn findings_lead_with_the_worst_one() {
        let text = "\
            contact me at someone@example.com\n\
            -----BEGIN RSA PRIVATE KEY-----";
        assert_eq!(
            scan(text).first().map(|finding| finding.kind),
            Some(SecretKind::PrivateKey)
        );
    }

    #[test]
    fn an_email_is_a_nudge_not_an_alarm() {
        let findings = scan("someone@example.com");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, SecretKind::PersonalData);
        assert!(findings[0].kind.severity() < SecretKind::PrivateKey.severity());
    }

    #[test]
    fn scanning_a_wall_of_text_does_not_hang() {
        // Deliberately seeded. With ordinary prose alone this passed with every
        // entry in `PATTERNS` deleted — a scanner that matches nothing is very
        // fast — so it timed an empty loop and called it a performance
        // guarantee. The seeds make it time the real work.
        // OCR of a dense screenshot can be long, and the catch pipeline is on a
        // deadline. `regex` guarantees linear time; this asserts the wiring.
        let haystack = SAMPLES
            .iter()
            .map(|(_, sample, ..)| format!("lorem ipsum {sample} dolor sit amet "))
            .collect::<String>()
            .repeat(4_000);
        let started = std::time::Instant::now();
        let findings = scan(&haystack);
        assert!(
            started.elapsed().as_secs() < 2,
            "scan should be linear in input size"
        );
        // And it did the work being timed.
        assert!(
            !findings.is_empty(),
            "the seeded secrets were not scanned for"
        );
    }
}
