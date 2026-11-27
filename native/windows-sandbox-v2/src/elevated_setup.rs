//! One elevation for the whole Windows sandbox setup.
//!
//! `srt-win install`, `srt-win uninstall` and the account capability step each
//! asked for their own UAC consent. Account rotation therefore showed up to
//! three prompts, and a prompt that only flashed in the taskbar timed out.
//!
//! `__elevated-setup` asks for consent once and starts
//! `__elevated-setup-session` elevated. The session connects back to a named
//! pipe served by the SDK process and runs one request per line. It accepts
//! only the setup steps: `srt-win install`/`uninstall` with a fixed flag set,
//! and the existing account capability envelope.
//!
//! The runner image is trusted only by the hash built into this helper. The
//! caller's path and hash are untrusted input, so another program on the
//! user's desktop cannot borrow this consent to run its own executable. The
//! runner stays open without write or delete sharing from hashing until it
//! exits, so the hashed image is the one that runs.
//!
//! The session refuses a pipe served by any process other than the requester,
//! and a prompt approved after the requester gave up finds no pipe and exits
//! without doing anything.
use crate::win::{self, OwnedHandle};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::mem::size_of;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use windows::Win32::Foundation::{ERROR_CANCELLED, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TokenElevation};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    GetFinalPathNameByHandleW,
};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
use windows::Win32::UI::Shell::{
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::PCWSTR;

/// Exit code when the user dismisses the UAC prompt; matches `srt-win install`.
pub const EXIT_ELEVATION_CANCELLED: u32 = 10;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_OUTPUT_CHARS: usize = 4096;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Set by `scripts/build-native.mjs` from the pinned ASRT release.
const PINNED_SRT_WIN_SHA256: Option<&str> = option_env!("KODAX_ASRT_RUNNER_SHA256");

/// The runner hash this helper was built for. A build without it runs no runner.
fn ensure_pinned_runner(observed: &str, pinned: Option<&str>) -> Result<()> {
    let pinned = pinned.context("This helper was built without a pinned sandbox runner hash")?;
    ensure!(
        observed.eq_ignore_ascii_case(pinned),
        "The sandbox runner is not the runner this helper was built for"
    );
    Ok(())
}

#[derive(Debug, PartialEq)]
struct SessionArgs {
    pipe_name: String,
    server_pid: u32,
    srt_win: String,
    srt_win_sha256: String,
    srt_win_prefix: Vec<String>,
}

impl SessionArgs {
    /// `<pipe> <server-pid> <srt-win> <srt-win-sha256> [-- <srt-win prefix args>...]`
    fn parse(argv: &[String]) -> Result<Self> {
        ensure!(
            argv.len() >= 4,
            "Elevated setup requires a pipe, PID, runner and runner hash"
        );
        let pipe_name = argv[0].clone();
        ensure!(
            pipe_name.starts_with(r"\\.\pipe\kodax-elevated-setup-")
                && pipe_name.len() <= 256
                && !pipe_name[9..].contains('\\'),
            "Elevated setup pipe name is invalid"
        );
        let server_pid = argv[1]
            .parse::<u32>()
            .context("Elevated setup server PID")?;
        ensure!(server_pid > 0, "Elevated setup server PID is invalid");
        let srt_win = argv[2].clone();
        ensure!(
            std::path::Path::new(&srt_win).is_absolute(),
            "Elevated setup runner path must be absolute"
        );
        let srt_win_sha256 = argv[3].to_ascii_lowercase();
        ensure!(
            srt_win_sha256.len() == 64
                && srt_win_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Elevated setup runner hash is invalid"
        );
        let srt_win_prefix = match argv.get(4).map(String::as_str) {
            None => Vec::new(),
            Some("--") => argv[5..].to_vec(),
            Some(_) => bail!("Unexpected elevated setup argument"),
        };
        // ASRT's protected runner copy dispatches on this one sentinel.
        ensure!(
            srt_win_prefix.is_empty() || srt_win_prefix == ["--srt-win"],
            "Unexpected elevated setup runner prefix"
        );
        Ok(Self {
            pipe_name,
            server_pid,
            srt_win,
            srt_win_sha256,
            srt_win_prefix,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Request {
    SrtWin { args: Vec<String> },
    AccountCapabilities { envelope: String },
    Exit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    exit_code: i32,
    output: String,
}

fn utf8_args(argv: Vec<std::ffi::OsString>) -> Result<Vec<String>> {
    argv.into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("Elevated setup argument is not Unicode"))
        })
        .collect()
}

fn current_process_is_elevated() -> Result<bool> {
    let token = win::current_token()?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0u32;
    unsafe {
        GetTokenInformation(
            token.raw(),
            TokenElevation,
            Some((&raw mut elevation).cast()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut length,
        )
    }
    .context("GetTokenInformation(TokenElevation)")?;
    Ok(elevation.TokenIsElevated != 0)
}

/// Non-elevated entry. Asks for consent once, then relays the session's exit.
pub fn launch(argv: Vec<std::ffi::OsString>) -> Result<u32> {
    let argv = utf8_args(argv)?;
    let args = SessionArgs::parse(&argv)?;
    // Refuse a mismatched runner before asking for consent, not after.
    ensure_pinned_runner(&args.srt_win_sha256, PINNED_SRT_WIN_SHA256)?;
    if current_process_is_elevated()? {
        return run_session(&args);
    }
    let executable = std::env::current_exe().context("resolve the elevated setup helper")?;
    let executable = executable
        .to_str()
        .context("Elevated setup helper path is not Unicode")?
        .to_owned();
    let mut session_argv = vec!["__elevated-setup-session".to_owned()];
    session_argv.extend(argv);
    let verb = win::wide("runas");
    let file = win::wide(&executable);
    let parameters = win::wide(&win::command_line(&session_argv));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        if error.code() == ERROR_CANCELLED.to_hresult() {
            return Ok(EXIT_ELEVATION_CANCELLED);
        }
        return Err(error).context("ShellExecuteExW(runas) for elevated setup");
    }
    ensure!(
        !info.hProcess.is_invalid(),
        "ShellExecuteExW returned no elevated setup process"
    );
    let process = OwnedHandle::new(info.hProcess, "elevated setup process")?;
    unsafe { WaitForSingleObject(process.raw(), INFINITE) };
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(process.raw(), &mut code) }
        .context("GetExitCodeProcess(elevated setup)")?;
    Ok(code)
}

/// Elevated entry. Serves setup requests from the requester's pipe.
pub fn serve(argv: Vec<std::ffi::OsString>) -> Result<u32> {
    run_session(&SessionArgs::parse(&utf8_args(argv)?)?)
}

fn run_session(args: &SessionArgs) -> Result<u32> {
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&args.pipe_name)
        .context("connect to the elevated setup requester")?;
    let mut server_pid = 0u32;
    unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut server_pid) }
        .context("GetNamedPipeServerProcessId(elevated setup)")?;
    ensure!(
        server_pid == args.server_pid,
        "Elevated setup pipe is served by an unexpected process"
    );
    let mut writer = pipe
        .try_clone()
        .context("duplicate the elevated setup pipe")?;
    let mut reader = BufReader::new(pipe);
    loop {
        let mut line = String::new();
        let read = (&mut reader).take(MAX_REQUEST_BYTES).read_line(&mut line)?;
        if read == 0 {
            return Ok(0);
        }
        ensure!(
            line.ends_with('\n'),
            "Elevated setup request exceeds its size bound"
        );
        let request: Request =
            serde_json::from_str(&line).context("decode elevated setup request")?;
        if matches!(request, Request::Exit) {
            return Ok(0);
        }
        let reply = handle(args, request);
        writer.write_all(serde_json::to_string(&reply)?.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

fn handle(args: &SessionArgs, request: Request) -> Reply {
    let result = match request {
        Request::SrtWin { args: srt_args } => run_srt_win(args, &srt_args),
        Request::AccountCapabilities { envelope } => crate::setup_account_capabilities(&envelope)
            .map(|()| Reply {
                exit_code: 0,
                output: String::new(),
            }),
        Request::Exit => unreachable!("exit is handled by the session loop"),
    };
    result.unwrap_or_else(|error| Reply {
        exit_code: 1,
        output: tail(&format!("{error:#}")),
    })
}

/// Only the setup commands, with the flags setup uses.
fn validate_srt_win_args(args: &[String]) -> Result<()> {
    let (command, flags) = args.split_first().context("srt-win command is required")?;
    match command.as_str() {
        "uninstall" => ensure!(flags.is_empty(), "srt-win uninstall takes no setup flags"),
        "install" => {
            let mut index = 0;
            while index < flags.len() {
                match flags[index].as_str() {
                    "--force" => index += 1,
                    "--proxy-port-range" => {
                        let range = flags
                            .get(index + 1)
                            .context("--proxy-port-range needs a value")?;
                        let valid = range.split_once('-').is_some_and(|(low, high)| {
                            low.parse::<u16>().is_ok() && high.parse::<u16>().is_ok()
                        });
                        ensure!(valid, "Invalid srt-win proxy port range");
                        index += 2;
                    }
                    _ => bail!("Unsupported srt-win install flag"),
                }
            }
        }
        _ => bail!("Unsupported elevated srt-win command"),
    }
    Ok(())
}

fn run_srt_win(args: &SessionArgs, srt_args: &[String]) -> Result<Reply> {
    validate_srt_win_args(srt_args)?;
    let (image, path) = open_runner_image(&args.srt_win)?;
    let output = Command::new(&path)
        .args(&args.srt_win_prefix)
        .args(srt_args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .context("run the sandbox runner")?;
    drop(image);
    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    Ok(Reply {
        exit_code: output.status.code().unwrap_or(1),
        output: tail(text.trim()),
    })
}

/// Opens the runner so nobody can write, delete or rename it, checks the pinned
/// hash, and returns the resolved path to run. Keep the file open until the
/// runner exits: a link swapped in after the check would otherwise run instead.
fn open_runner_image(path: &str) -> Result<(File, String)> {
    let mut image = lock_image(path)?;
    let mut bytes = Vec::new();
    image
        .read_to_end(&mut bytes)
        .context("read the sandbox runner")?;
    ensure_pinned_runner(
        &format!("{:x}", Sha256::digest(&bytes)),
        PINNED_SRT_WIN_SHA256,
    )?;
    let resolved = final_local_path(&image)?;
    Ok((image, resolved))
}

fn lock_image(path: &str) -> Result<File> {
    let image = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .context("open the sandbox runner")?;
    let metadata = image.metadata().context("inspect the sandbox runner")?;
    ensure!(
        metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0,
        "The sandbox runner is not a regular file"
    );
    Ok(image)
}

fn final_local_path(file: &File) -> Result<String> {
    let mut buffer = vec![0u16; 512];
    loop {
        let handle = HANDLE(file.as_raw_handle());
        let written = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, Default::default()) };
        ensure!(written != 0, "resolve the sandbox runner path");
        if (written as usize) < buffer.len() {
            let raw = String::from_utf16(&buffer[..written as usize])
                .context("decode the sandbox runner path")?;
            ensure!(
                !raw.to_ascii_lowercase().starts_with(r"\\?\unc\"),
                "The sandbox runner must be on a local disk"
            );
            return raw
                .strip_prefix(r"\\?\")
                .map(str::to_owned)
                .context("The sandbox runner did not resolve to a local path");
        }
        buffer.resize(written as usize + 1, 0);
    }
}

fn tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= MAX_OUTPUT_CHARS {
        return text.to_owned();
    }
    text.chars().skip(count - MAX_OUTPUT_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    const PIPE: &str = r"\\.\pipe\kodax-elevated-setup-00000000-0000-4000-8000-000000000001";

    #[test]
    fn session_args_require_a_kodax_pipe_and_a_pinned_runner() {
        let hash = "A".repeat(64);
        let parsed = SessionArgs::parse(&argv(&[
            PIPE,
            "42",
            r"C:\Runner\srt-win.exe",
            &hash,
            "--",
            "--srt-win",
        ]))
        .unwrap();
        assert_eq!(parsed.server_pid, 42);
        assert_eq!(parsed.srt_win_sha256, "a".repeat(64));
        assert_eq!(parsed.srt_win_prefix, vec!["--srt-win".to_owned()]);

        assert!(
            SessionArgs::parse(&argv(&[r"\\.\pipe\other", "42", r"C:\srt-win.exe", &hash]))
                .is_err()
        );
        assert!(
            SessionArgs::parse(&argv(&[
                &format!(r"{PIPE}\x"),
                "42",
                r"C:\srt-win.exe",
                &hash
            ]))
            .is_err()
        );
        assert!(SessionArgs::parse(&argv(&[PIPE, "0", r"C:\srt-win.exe", &hash])).is_err());
        assert!(SessionArgs::parse(&argv(&[PIPE, "42", "srt-win.exe", &hash])).is_err());
        assert!(SessionArgs::parse(&argv(&[PIPE, "42", r"C:\srt-win.exe", "abc"])).is_err());
        assert!(
            SessionArgs::parse(&argv(&[PIPE, "42", r"C:\srt-win.exe", &hash, "extra"])).is_err()
        );
        assert!(
            SessionArgs::parse(&argv(&[PIPE, "42", r"C:\srt-win.exe", &hash, "--", "exec"]))
                .is_err()
        );
    }

    #[test]
    fn only_setup_commands_and_flags_reach_the_runner() {
        validate_srt_win_args(&argv(&["uninstall"])).unwrap();
        validate_srt_win_args(&argv(&[
            "install",
            "--proxy-port-range",
            "60080-60143",
            "--force",
        ]))
        .unwrap();

        for rejected in [
            argv(&[]),
            argv(&["uninstall", "--keep-user"]),
            argv(&["exec", "cmd.exe"]),
            argv(&["install", "--sandbox-user", "other"]),
            argv(&["install", "--proxy-port-range"]),
            argv(&["install", "--proxy-port-range", "1-x"]),
        ] {
            assert!(validate_srt_win_args(&rejected).is_err(), "{rejected:?}");
        }
    }

    #[test]
    fn requests_decode_by_operation() {
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"op":"srt-win","args":["uninstall"]}"#).unwrap(),
            Request::SrtWin { .. }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"op":"account-capabilities","envelope":"e30="}"#)
                .unwrap(),
            Request::AccountCapabilities { .. }
        ));
        assert!(matches!(
            serde_json::from_str::<Request>(r#"{"op":"exit"}"#).unwrap(),
            Request::Exit
        ));
        assert!(serde_json::from_str::<Request>(r#"{"op":"exec","args":[]}"#).is_err());
    }

    #[test]
    fn only_the_built_in_runner_hash_is_trusted() {
        let pin = "ab".repeat(32);
        ensure_pinned_runner(&pin.to_ascii_uppercase(), Some(&pin)).unwrap();
        assert!(ensure_pinned_runner(&"cd".repeat(32), Some(&pin)).is_err());
        assert!(ensure_pinned_runner(&pin, None).is_err());
    }

    #[test]
    fn a_locked_runner_cannot_be_rewritten_moved_or_deleted() {
        let dir = std::env::temp_dir().join(format!(
            "kodax-elevated-setup-lock-test-{}",
            std::process::id()
        ));
        let moved_dir = dir.with_extension("moved");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("srt-win.exe");
        std::fs::write(&path, b"image").unwrap();
        {
            let image = lock_image(path.to_str().unwrap()).unwrap();
            assert!(OpenOptions::new().write(true).open(&path).is_err());
            assert!(std::fs::rename(&path, dir.join("moved.exe")).is_err());
            assert!(std::fs::remove_file(&path).is_err());
            assert!(std::fs::rename(&dir, &moved_dir).is_err());
            let resolved = final_local_path(&image).unwrap();
            assert!(!resolved.starts_with(r"\\?\"), "{resolved}");
            assert!(resolved.ends_with(r"\srt-win.exe"), "{resolved}");
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn long_output_keeps_its_end() {
        let text = format!("{}END", "x".repeat(MAX_OUTPUT_CHARS));
        let kept = tail(&text);
        assert_eq!(kept.chars().count(), MAX_OUTPUT_CHARS);
        assert!(kept.ends_with("END"));
    }
}
