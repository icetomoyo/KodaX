//! KodaX RepoIntel engine: indexes repositories for the Host that starts it,
//! and answers over stdio with JSON-RPC framed as LSP frames it.

mod extract;
mod imports;
mod manifest;
mod memory;
mod priority;
mod query;
mod references;
mod resolve;
mod rpc;
mod server;
mod store;
mod workspace;

use server::{Outcome, Server};
use std::io::{self, BufReader};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut server = Server::new(priority::probe());
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    loop {
        let body = match rpc::read_frame(&mut input) {
            Ok(Some(body)) => body,
            // The Host closed our input without exit: it is gone, so stop.
            Ok(None) => return ExitCode::from(1),
            Err(error) => {
                eprintln!("kodax-repo-intel: cannot read a message: {error}");
                return ExitCode::from(2);
            }
        };
        let outcome = match serde_json::from_slice(&body) {
            Ok(message) => server.handle(message),
            Err(error) => server.unparsable(&error),
        };
        match outcome {
            Outcome::Reply(reply) => {
                if let Err(error) = rpc::write_message(&mut output, &reply) {
                    eprintln!("kodax-repo-intel: cannot answer: {error}");
                    return ExitCode::from(2);
                }
            }
            Outcome::Silent => {}
            Outcome::Exit(code) => return ExitCode::from(code as u8),
        }
    }
}
