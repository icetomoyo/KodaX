use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protocol::PROTOCOL_VERSION;

pub fn controller_pipe_server_pid(value: &str) -> Result<u32> {
    let suffix = value
        .strip_prefix(r"\\.\pipe\kodax-v2-")
        .ok_or_else(|| anyhow::anyhow!("Invalid Windows sandbox controller pipe"))?;
    let (pid, nonce) = suffix
        .split_once('-')
        .ok_or_else(|| anyhow::anyhow!("Invalid Windows sandbox controller pipe"))?;
    let pid = pid
        .parse::<u32>()
        .map_err(|_| anyhow::anyhow!("Invalid Windows sandbox controller pipe"))?;
    if pid == 0 || uuid::Uuid::parse_str(nonce).is_err() {
        bail!("Invalid Windows sandbox controller pipe");
    }
    Ok(pid)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub protocol: u16,
    pub generation: String,
    pub sandbox_user_sid: String,
    pub sandbox_group_sid: String,
    pub asrt_executable: String,
    pub asrt_prefix_args: Vec<String>,
    pub target_argv: Vec<String>,
    pub cwd: String,
    pub policy_fingerprint: String,
    pub policy_capability_sid: String,
    pub allow_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_read: Vec<String>,
    pub deny_write: Vec<String>,
    pub controller_pipe: String,
    pub terminal_record_path: String,
    pub terminal_nonce: String,
    pub launch_deadline_unix_ms: u64,
}

impl RunRequest {
    pub fn validate(&self) -> Result<()> {
        if self.protocol != PROTOCOL_VERSION {
            bail!(
                "Windows sandbox request protocol {} does not match runner protocol {}",
                self.protocol,
                PROTOCOL_VERSION
            );
        }
        if self.generation.is_empty() {
            bail!("Windows sandbox generation is empty");
        }
        if self.launch_deadline_unix_ms == 0 {
            bail!("Windows sandbox launch deadline is invalid");
        }
        if self.asrt_executable.is_empty() || self.target_argv.first().is_none_or(String::is_empty)
        {
            bail!("Windows sandbox request omitted an executable");
        }
        if self.asrt_prefix_args.last().map(String::as_str) != Some("--") {
            bail!("ASRT prefix must end at the target separator");
        }
        if self.asrt_prefix_args.iter().any(|argument| {
            argument.eq_ignore_ascii_case("--env")
                || argument
                    .get(..6)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("--env="))
        }) {
            bail!("ASRT prefix must not carry target environment entries");
        }
        controller_pipe_server_pid(&self.controller_pipe)?;
        if self.terminal_record_path.is_empty() || self.terminal_record_path.contains('\0') {
            bail!("Invalid Windows sandbox terminal record path");
        }
        uuid::Uuid::parse_str(&self.terminal_nonce)
            .map_err(|_| anyhow::anyhow!("Invalid Windows sandbox terminal nonce"))?;
        let valid_sid = |value: &str| {
            value.starts_with("S-1-")
                && value[2..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
        };
        if !valid_sid(&self.sandbox_user_sid) {
            bail!("Invalid Windows sandbox account SID");
        }
        if !valid_sid(&self.sandbox_group_sid) {
            bail!("Invalid Windows sandbox group SID");
        }
        if self.sandbox_group_sid == self.sandbox_user_sid
            || self.sandbox_group_sid == self.policy_capability_sid
        {
            bail!("Windows sandbox group SID is not an independent account group");
        }
        if !self
            .policy_fingerprint
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
            || self.policy_fingerprint.len() != 64
        {
            bail!("Invalid Windows sandbox policy fingerprint");
        }
        let expected = capability_sid(&self.policy_fingerprint)?;
        if expected != self.policy_capability_sid {
            bail!("Windows sandbox policy capability SID does not match its fingerprint");
        }
        for candidate in self
            .allow_read
            .iter()
            .chain(&self.allow_write)
            .chain(&self.deny_read)
            .chain(&self.deny_write)
        {
            if candidate.is_empty() || candidate.contains('\0') {
                bail!("Windows sandbox policy contains an empty or invalid path");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub protocol: u16,
    pub target_environment: Vec<EnvironmentEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentEntry {
    pub name: String,
    pub value: String,
}

impl BootstrapRequest {
    pub fn validate(&self) -> Result<()> {
        if self.protocol != PROTOCOL_VERSION {
            bail!("Windows sandbox bootstrap protocol is incompatible");
        }
        if self.target_environment.len() > 4_096 {
            bail!("Windows sandbox target environment has too many entries");
        }
        let mut names = std::collections::BTreeSet::new();
        let mut units = 1usize;
        for entry in &self.target_environment {
            let name = &entry.name;
            let value = &entry.value;
            if name.is_empty()
                || name.contains('=')
                || name.contains('\0')
                || value.contains('\0')
                || !names.insert(name.to_uppercase())
            {
                bail!("Windows sandbox target environment contains an invalid entry");
            }
            units = units
                .checked_add(name.encode_utf16().count() + value.encode_utf16().count() + 2)
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox environment size overflow"))?;
        }
        if units > 30_000 {
            bail!("Windows sandbox target environment exceeds its UTF-16 bound");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloMessage {
    pub protocol: u16,
    pub pid: u32,
    pub logon_sid: String,
    pub session_nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpawnMessage {
    pub protocol: u16,
    pub target_argv: Vec<String>,
    pub cwd: String,
    pub policy_capability_sid: String,
    pub session_nonce: String,
    pub target_environment: Vec<EnvironmentEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadyMessage {
    pub protocol: u16,
    pub pid: u32,
    pub job_contained: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartedMessage {
    pub protocol: u16,
    pub pid: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitMessage {
    pub protocol: u16,
    pub code: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRecord {
    pub protocol: u16,
    pub nonce: String,
    pub job_drained: bool,
    pub target_exit_code: u32,
    pub termination_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorMessage {
    pub protocol: u16,
    pub stage: String,
    pub message: String,
}

pub fn capability_sid(fingerprint: &str) -> Result<String> {
    let normalized = fingerprint.to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|value| value.is_ascii_hexdigit()) {
        bail!("Invalid Windows sandbox policy fingerprint");
    }
    let mut hash = Sha256::new();
    hash.update(b"KodaX Windows sandbox v2 policy capability\0");
    hash.update(normalized.as_bytes());
    let digest = hash.finalize();
    let authorities = digest.as_chunks::<4>().0[..4]
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk))
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("-");
    Ok(format!("S-1-5-21-{authorities}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_sid_is_stable_and_matches_the_typescript_shape() {
        let fingerprint = "5b401146bc05d22e91d1b99a6c8ff5e46dc0725a62d5f43b7e31da594151fa76";
        assert_eq!(
            capability_sid(fingerprint).unwrap(),
            capability_sid(&fingerprint.to_ascii_uppercase()).unwrap(),
        );
        assert!(
            capability_sid(fingerprint)
                .unwrap()
                .starts_with("S-1-5-21-")
        );
    }

    #[test]
    fn request_rejects_a_capability_substitution() {
        let request = RunRequest {
            protocol: PROTOCOL_VERSION,
            generation: "generation-a".into(),
            sandbox_user_sid: "S-1-5-21-1-2-3-4".into(),
            sandbox_group_sid: "S-1-5-21-1-2-3-5".into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: r"C:\work".into(),
            policy_fingerprint: "0".repeat(64),
            policy_capability_sid: "S-1-5-21-1-2-3-4".into(),
            allow_read: vec![],
            allow_write: vec![],
            deny_read: vec![],
            deny_write: vec![],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            terminal_record_path: r"C:\control\terminal.json".into(),
            terminal_nonce: "12345678-1234-1234-1234-123456789abc".into(),
            launch_deadline_unix_ms: 1,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn request_accepts_a_normal_windows_account_sid() {
        let fingerprint = "0".repeat(64);
        let request = RunRequest {
            protocol: PROTOCOL_VERSION,
            generation: "generation-a".into(),
            sandbox_user_sid: "S-1-5-21-2130785933-3654544736-2779019230-1006".into(),
            sandbox_group_sid: "S-1-5-21-2130785933-3654544736-2779019230-1005".into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: r"C:\work".into(),
            policy_capability_sid: capability_sid(&fingerprint).unwrap(),
            policy_fingerprint: fingerprint,
            allow_read: vec![],
            allow_write: vec![],
            deny_read: vec![],
            deny_write: vec![],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            terminal_record_path: r"C:\control\terminal.json".into(),
            terminal_nonce: "12345678-1234-1234-1234-123456789abc".into(),
            launch_deadline_unix_ms: 1,
        };
        request.validate().unwrap();
    }

    #[test]
    fn request_rejects_the_account_sid_as_its_normal_access_group() {
        let fingerprint = "0".repeat(64);
        let sid = "S-1-5-21-1-2-3-4";
        let request = RunRequest {
            protocol: PROTOCOL_VERSION,
            generation: "generation-a".into(),
            sandbox_user_sid: sid.into(),
            sandbox_group_sid: sid.into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: r"C:\work".into(),
            policy_capability_sid: capability_sid(&fingerprint).unwrap(),
            policy_fingerprint: fingerprint,
            allow_read: vec![],
            allow_write: vec![],
            deny_read: vec![],
            deny_write: vec![],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            terminal_record_path: r"C:\control\terminal.json".into(),
            terminal_nonce: "12345678-1234-1234-1234-123456789abc".into(),
            launch_deadline_unix_ms: 1,
        };

        assert!(
            request
                .validate()
                .unwrap_err()
                .to_string()
                .contains("independent account group")
        );
    }

    #[test]
    fn request_rejects_inline_asrt_environment_entries() {
        let fingerprint = "0".repeat(64);
        let request = RunRequest {
            protocol: PROTOCOL_VERSION,
            generation: "generation-a".into(),
            sandbox_user_sid: "S-1-5-21-1-2-3-4".into(),
            sandbox_group_sid: "S-1-5-21-1-2-3-5".into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--ENV=SECRET=value".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: r"C:\work".into(),
            policy_capability_sid: capability_sid(&fingerprint).unwrap(),
            policy_fingerprint: fingerprint,
            allow_read: vec![],
            allow_write: vec![],
            deny_read: vec![],
            deny_write: vec![],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            terminal_record_path: r"C:\control\terminal.json".into(),
            terminal_nonce: "12345678-1234-1234-1234-123456789abc".into(),
            launch_deadline_unix_ms: 1,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn bootstrap_accepts_unicode_names_but_rejects_windows_case_duplicates() {
        BootstrapRequest {
            protocol: PROTOCOL_VERSION,
            target_environment: vec![EnvironmentEntry {
                name: "\u{73af}\u{5883}".into(),
                value: "\u{503c}".into(),
            }],
        }
        .validate()
        .unwrap();

        assert!(
            BootstrapRequest {
                protocol: PROTOCOL_VERSION,
                target_environment: vec![
                    EnvironmentEntry {
                        name: "Path".into(),
                        value: "one".into()
                    },
                    EnvironmentEntry {
                        name: "PATH".into(),
                        value: "two".into()
                    },
                ],
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn controller_pipe_binds_the_broker_pid() {
        assert_eq!(
            controller_pipe_server_pid(
                r"\\.\pipe\kodax-v2-4321-12345678-1234-1234-1234-123456789abc"
            )
            .unwrap(),
            4321
        );
        assert!(controller_pipe_server_pid(r"\\.\pipe\other-4321-nonce").is_err());
    }
}
