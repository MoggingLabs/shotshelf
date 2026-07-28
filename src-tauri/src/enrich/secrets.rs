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
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub kind: SecretKind,
    /// What it is, in words: "GitHub personal access token".
    pub label: &'static str,
    /// Masked. Never the value itself.
    pub preview: String,
}

struct Pattern {
    kind: SecretKind,
    label: &'static str,
    regex: Regex,
}

/// Patterns anchored on distinctive prefixes rather than on entropy.
///
/// Entropy scoring is the usual approach and the wrong one here: OCR flattens
/// exactly the character distinctions entropy depends on, and a base64 blob in
/// a screenshot is as likely to be a data URI or a hash as a credential. A
/// prefix like `ghp_` is unambiguous, survives a misread of the payload, and
/// almost never appears by accident.
static PATTERNS: LazyLock<Vec<Pattern>> = LazyLock::new(|| {
    let compile = |kind, label, source: &str| Pattern {
        kind,
        label,
        // These are fixed literals in this file, not user input; a failure here
        // is a programming error and should be loud at first use.
        regex: Regex::new(source).expect("shotshelf: built-in secret pattern is invalid"),
    };

    vec![
        compile(
            SecretKind::PrivateKey,
            "private key",
            r"-----BEGIN[ A-Z]*PRIVATE KEY-----",
        ),
        compile(
            SecretKind::ServiceToken,
            "GitHub token",
            r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "OpenAI or Anthropic API key",
            r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "AWS access key ID",
            r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Google API key",
            r"\bAIza[A-Za-z0-9_-]{35}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Slack token",
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
        ),
        compile(
            SecretKind::ServiceToken,
            "Stripe secret key",
            r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b",
        ),
        compile(
            SecretKind::Jwt,
            "signed token",
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        ),
        compile(
            SecretKind::Assignment,
            "secret in a config value",
            // The name carries the signal. A value of at least eight
            // non-space characters keeps `PASSWORD=` in a blank template from
            // being reported as a leak.
            r"(?i)\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*\S{8,}",
        ),
        compile(
            SecretKind::PersonalData,
            "email address",
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        ),
    ]
});

/// Scan recognised text for anything worth a second look.
///
/// Findings are deduplicated and ordered worst-first, so a caller showing only
/// one is showing the one that matters.
#[must_use]
pub fn scan(text: &str) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();

    for pattern in PATTERNS.iter() {
        for hit in pattern.regex.find_iter(text) {
            let finding = Finding {
                kind: pattern.kind,
                label: pattern.label,
                preview: mask(hit.as_str()),
            };
            // The same key printed twice on one screen is one problem.
            if !findings.contains(&finding) {
                findings.push(finding);
            }
        }
    }

    // Reverse severity: the worst thing is what you see first.
    findings.sort_by_key(|finding| std::cmp::Reverse(finding.kind.severity()));
    findings
}

/// Enough of a match to recognise it, never enough to use it.
///
/// Keeping the leading characters is deliberate: the prefix is what tells you
/// *which* credential it is — `ghp_` versus `sk-ant-` — and the prefix alone is
/// not the secret. The tail is dropped entirely rather than partly shown,
/// because a known prefix plus a known suffix is a materially smaller search
/// space than either alone.
fn mask(value: &str) -> String {
    const KEEP: usize = 7;

    let visible: String = value.chars().take(KEEP).collect();
    if value.chars().count() <= KEEP {
        // Short enough that any of it is too much of it.
        return "•".repeat(value.chars().count().max(1));
    }

    format!("{visible}…")
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!secret.contains(preview.trim_end_matches('…')) || preview.len() < 12);
        assert!(
            preview.starts_with("ghp_"),
            "the prefix is what names it: {preview}"
        );
    }

    #[test]
    fn a_short_match_is_masked_completely() {
        // Nothing here is long enough for a prefix to be safe.
        assert_eq!(mask("abc"), "•••");
        assert_eq!(mask(""), "•");
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
        // OCR of a dense screenshot can be long, and the catch pipeline is on a
        // deadline. `regex` guarantees linear time; this asserts the wiring.
        let haystack = "lorem ipsum dolor sit amet ".repeat(20_000);
        let started = std::time::Instant::now();
        let _ = scan(&haystack);
        assert!(
            started.elapsed().as_secs() < 2,
            "scan should be linear in input size"
        );
    }
}
