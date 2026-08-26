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
        "__setup-null-device" => {
            let sandbox_sid = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Sandbox SID is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Null-device setup accepts one sandbox SID");
            }
            win::ensure_null_device_access(
                sandbox_sid
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Sandbox SID is not Unicode"))?,
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
        "__host" => {
            let value = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Windows sandbox host request is required"))?;
            if args.next().is_some() {
                anyhow::bail!("Windows sandbox host accepts one request path");
            }
            host::run(std::path::Path::new(&value))
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
