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
            if paths.len() > 256 || paths.iter().any(|path| path.is_empty() || path.contains('\0')) {
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
                _ => anyhow::bail!("Unknown persistent denyRead action"),
            }
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
