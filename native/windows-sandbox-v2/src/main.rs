#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
mod acl;
#[cfg(windows)]
mod host;
mod model;
mod protocol;
#[cfg(windows)]
mod runner;
#[cfg(windows)]
mod win;

#[cfg(windows)]
use anyhow::{Context, ensure};
#[cfg(windows)]
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(windows)]
use sha2::{Digest, Sha256};

#[cfg(windows)]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupAccountCapabilitiesRequest {
    version: u32,
    sandbox_sid: String,
    sandbox_group_sid: String,
    filesystem_capability_nonce: String,
    read_roots: Vec<String>,
    write_roots: Vec<String>,
}

#[cfg(windows)]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupAccountCapabilitiesEnvelope {
    version: u32,
    request_path: String,
    sha256: String,
}

#[cfg(windows)]
impl SetupAccountCapabilitiesRequest {
    fn validate(&self) -> anyhow::Result<()> {
        ensure!(self.version == 1, "Unsupported setup account capability request version");
        ensure!(
            self.sandbox_sid.starts_with("S-1-5-21-")
                && self.sandbox_group_sid.starts_with("S-1-5-21-")
                && !self.sandbox_sid.eq_ignore_ascii_case(&self.sandbox_group_sid),
            "Setup account capability request contains invalid local account authority",
        );
        let nonce = uuid::Uuid::parse_str(&self.filesystem_capability_nonce)
            .map_err(|_| anyhow::anyhow!("Invalid setup filesystem capability nonce"))?;
        ensure!(nonce.get_version_num() == 4, "Invalid setup filesystem capability nonce");
        ensure!(
            self.read_roots.len() + self.write_roots.len() <= 1_024,
            "Setup account capability request exceeds 1024 roots",
        );
        ensure!(
            self.read_roots
                .iter()
                .chain(&self.write_roots)
                .all(|path| {
                    !path.is_empty()
                        && !path.contains('\0')
                        && std::path::Path::new(path).is_absolute()
                        && path.encode_utf16().count() <= 32_767
                }),
            "Setup account capability request contains invalid paths",
        );
        Ok(())
    }
}

#[cfg(windows)]
fn decode_setup_account_capabilities_request(
    bytes: &[u8],
    expected_sha256: &str,
) -> anyhow::Result<SetupAccountCapabilitiesRequest> {
    ensure!(
        expected_sha256.len() == 64 && expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid setup account capability request digest",
    );
    let observed_sha256 = format!("{:x}", Sha256::digest(bytes));
    ensure!(
        observed_sha256.eq_ignore_ascii_case(expected_sha256),
        "Setup account capability request digest changed before elevation",
    );
    let request: SetupAccountCapabilitiesRequest = serde_json::from_slice(bytes)
        .context("decode setup account capability request")?;
    request.validate()?;
    Ok(request)
}

#[cfg(windows)]
fn decode_setup_account_capabilities_envelope(
    encoded: &str,
) -> anyhow::Result<SetupAccountCapabilitiesEnvelope> {
    ensure!(
        !encoded.is_empty() && encoded.len() <= 8 * 1_024,
        "Invalid setup account capability envelope size",
    );
    let bytes = STANDARD
        .decode(encoded)
        .context("decode setup account capability envelope")?;
    let envelope: SetupAccountCapabilitiesEnvelope = serde_json::from_slice(&bytes)
        .context("decode setup account capability envelope JSON")?;
    ensure!(
        envelope.version == 1,
        "Unsupported setup account capability envelope version",
    );
    ensure!(
        !envelope.request_path.is_empty()
            && !envelope.request_path.contains('\0')
            && std::path::Path::new(&envelope.request_path).is_absolute(),
        "Invalid setup account capability envelope request path",
    );
    ensure!(
        envelope.sha256.len() == 64
            && envelope.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid setup account capability envelope digest",
    );
    Ok(envelope)
}

#[cfg(windows)]
fn verify_setup_account_capability_request_path(path: &std::path::Path) -> anyhow::Result<()> {
    ensure!(path.is_absolute(), "Setup account capability request path must be absolute");
    let control_directory = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Setup account capability request has no control directory"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("Setup account capability request name is not Unicode"))?;
    let identity = name
        .strip_prefix("windows-setup-")
        .and_then(|value| value.strip_suffix(".json"))
        .ok_or_else(|| anyhow::anyhow!("Setup account capability request name is invalid"))?;
    let (pid, nonce) = identity
        .split_once('-')
        .ok_or_else(|| anyhow::anyhow!("Setup account capability request identity is invalid"))?;
    ensure!(pid.parse::<u32>().is_ok_and(|value| value > 0), "Invalid setup request PID");
    let nonce = uuid::Uuid::parse_str(nonce)
        .map_err(|_| anyhow::anyhow!("Invalid setup request nonce"))?;
    ensure!(nonce.get_version_num() == 4, "Invalid setup request nonce");
    let token = win::current_token()?;
    let host_sid = win::token_user_sid(token.raw())?;
    acl::verify_setup_control_directory_boundary(control_directory, &host_sid)
}

#[cfg(windows)]
fn run() -> anyhow::Result<u32> {
    let mut args = std::env::args_os();
    let _program = args.next();
    let mode = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("Windows sandbox mode is required"))?;
    match mode.to_string_lossy().as_ref() {
        "__current-user-sid" => {
            if args.next().is_some() {
                anyhow::bail!("Current-user SID mode accepts no arguments");
            }
            let token = win::current_token()?;
            println!("{}", win::token_user_sid(token.raw())?);
            Ok(0)
        }
        "__setup-account-capabilities" => {
            let envelope = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Setup account capability envelope is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Account capability setup accepts one envelope");
            }
            let envelope = decode_setup_account_capabilities_envelope(
                envelope
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Setup account capability envelope is not Unicode"))?,
            )?;
            let request_path = std::path::PathBuf::from(envelope.request_path);
            verify_setup_account_capability_request_path(&request_path)?;
            let bytes = host::read_and_retire_request_file(&request_path)?;
            let request = decode_setup_account_capabilities_request(&bytes, &envelope.sha256)?;
            win::ensure_null_device_access(&request.sandbox_sid)?;
            acl::ensure_setup_acl_roots(
                &request.read_roots,
                &request.write_roots,
                &request.sandbox_group_sid,
                &request.filesystem_capability_nonce,
            )?;
            Ok(0)
        }
        "__verify-null-device" => {
            let sandbox_sid = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Sandbox SID is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Null-device verification accepts one sandbox SID");
            }
            win::verify_null_device_access(
                sandbox_sid
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Sandbox SID is not Unicode"))?,
            )?;
            Ok(0)
        }
        "__persistent-deny-read" => {
            let action = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Persistent denyRead action is required"))?;
            let sandbox_user_sid = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Sandbox user SID is required"))?;
            let sandbox_group_sid = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Sandbox group SID is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Persistent denyRead accepts action, user SID, and group SID");
            }
            let paths: Vec<String> = serde_json::from_reader(std::io::stdin())
                .map_err(|error| anyhow::anyhow!("Invalid persistent denyRead request: {error}"))?;
            if paths.len() > 256
                || paths
                    .iter()
                    .any(|path| path.is_empty() || path.contains('\0'))
            {
                anyhow::bail!("Persistent denyRead request contains invalid paths");
            }
            let user_sid = sandbox_user_sid
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Sandbox user SID is not Unicode"))?;
            let group_sid = sandbox_group_sid
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Sandbox group SID is not Unicode"))?;
            match action.to_string_lossy().as_ref() {
                "verify" => {
                    let missing = acl::verify_persistent_deny_read(&paths, group_sid)?;
                    println!("{}", serde_json::to_string(&missing)?);
                }
                "install" => {
                    acl::ensure_persistent_deny_read(&paths, user_sid, group_sid)?;
                    println!("[]");
                }
                "remove" => {
                    acl::remove_persistent_deny_read(&paths, group_sid)?;
                    println!("[]");
                }
                _ => anyhow::bail!("Unknown persistent denyRead action"),
            }
            Ok(0)
        }
        "__recover-execution-denies" => {
            let control_directory = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox control directory is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Execution deny recovery accepts one control directory");
            }
            acl::recover_stale_execution_denies(std::path::Path::new(&control_directory))?;
            Ok(0)
        }
        "__host" => {
            let value = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox host request is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Windows sandbox host accepts one request path");
            }
            host::run(std::path::Path::new(&value))
        }
        "__controller" => {
            let broker_pid = args
                .next()
                .ok_or_else(|| {
                    anyhow::anyhow!("Windows sandbox controller broker PID is required")
                })?
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("Windows sandbox controller broker PID is invalid"))?;
            if args.next().is_some() {
                anyhow::bail!("Windows sandbox controller accepts one broker PID");
            }
            win::run_controller_pipe_server(broker_pid)?;
            Ok(0)
        }
        "__runner" => {
            let control_pipe_name = args.next().ok_or_else(|| {
                anyhow::anyhow!("Windows sandbox runner control pipe is required")
            })?;
            let event_pipe_name = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox runner event pipe is required"))?;
            let host_sid = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox runner host SID is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Windows sandbox runner accepts two pipe names and host SID");
            }
            runner::run(
                control_pipe_name.to_str().ok_or_else(|| {
                    anyhow::anyhow!("Windows sandbox control pipe name is not Unicode")
                })?,
                event_pipe_name.to_str().ok_or_else(|| {
                    anyhow::anyhow!("Windows sandbox event pipe name is not Unicode")
                })?,
                host_sid
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Windows sandbox host SID is not Unicode"))?,
            )?;
            Ok(0)
        }
        _ => anyhow::bail!("Unknown Windows sandbox mode"),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn setup_account_capability_request_is_digest_bound_and_rejects_unknown_fields() {
        let valid = br#"{"version":1,"sandboxSid":"S-1-5-21-1","sandboxGroupSid":"S-1-5-21-2","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000003","readRoots":["C:\\Runtime"],"writeRoots":["C:\\Temp"]}"#;
        decode_setup_account_capabilities_request(valid, &digest(valid)).unwrap();
        assert!(
            decode_setup_account_capabilities_request(valid, &"0".repeat(64))
                .unwrap_err()
                .to_string()
                .contains("digest changed")
        );

        let unknown = br#"{"version":1,"sandboxSid":"S-1-5-21-1","sandboxGroupSid":"S-1-5-21-2","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000003","readRoots":[],"writeRoots":[],"unexpected":true}"#;
        assert!(decode_setup_account_capabilities_request(unknown, &digest(unknown)).is_err());
    }

    #[test]
    fn setup_account_capability_envelope_is_explicitly_bound_to_the_elevated_process() {
        let encoded = "eyJ2ZXJzaW9uIjoxLCJyZXF1ZXN0UGF0aCI6IkM6XFxDb250cm9sXFx3aW5kb3dzLXNldHVwLTEtMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxLmpzb24iLCJzaGEyNTYiOiIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIn0=";
        let envelope = decode_setup_account_capabilities_envelope(encoded).unwrap();
        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.request_path, r"C:\Control\windows-setup-1-00000000-0000-4000-8000-000000000001.json");
        assert_eq!(envelope.sha256, "0".repeat(64));

        assert!(decode_setup_account_capabilities_envelope("not-base64").is_err());
    }

    #[test]
    fn setup_account_capability_request_accepts_more_than_the_legacy_256_root_limit() {
        let roots = (0..300)
            .map(|index| format!(r"C:\Runtime\{index}"))
            .collect::<Vec<_>>();
        let payload = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "sandboxSid": "S-1-5-21-1",
            "sandboxGroupSid": "S-1-5-21-2",
            "filesystemCapabilityNonce": "00000000-0000-4000-8000-000000000003",
            "readRoots": roots,
            "writeRoots": [r"C:\Temp"],
        }))
        .unwrap();
        decode_setup_account_capabilities_request(&payload, &digest(&payload)).unwrap();
    }

    #[test]
    fn setup_account_capability_request_rejects_an_unprotected_parent_before_retirement() {
        let path = std::env::temp_dir().join(format!(
            "windows-setup-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        std::fs::write(&path, b"{}").unwrap();
        assert!(verify_setup_account_capability_request_path(&path).is_err());
        assert!(path.exists());
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(not(windows))]
fn run() -> anyhow::Result<u32> {
    anyhow::bail!("kodax-windows-sandbox is available only on Windows")
}

fn main() {
    #[cfg(windows)]
    // Set this before argument parsing or host startup. The host launches ASRT,
    // which launches the restricted runner, so a loader failure in either child
    // occurs before runner::run can suppress Windows' modal error dialog itself.
    win::suppress_system_error_dialogs();
    match run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!(
                "kodax-windows-sandbox protocol {} failed: {error:#}",
                protocol::PROTOCOL_VERSION,
            );
            std::process::exit(2);
        }
    }
}
