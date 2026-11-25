//! JSON-RPC 2.0 messages framed with a `Content-Length` header, as LSP frames them.

use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

/// A message larger than this is refused, so a broken peer cannot make the
/// engine allocate without bound.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
/// Sent for any request before `initialize`, as LSP does.
pub const SERVER_NOT_INITIALIZED: i64 = -32002;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Reads one frame's body, or `None` when the input ends between frames.
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut length: Option<usize> = None;
    let mut started = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            if started {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "input ended inside a header"));
            }
            return Ok(None);
        }
        started = true;
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(invalid("a header line has no colon"));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            length = Some(value.trim().parse().map_err(|_| invalid("Content-Length is not a number"))?);
        }
    }
    let length = length.ok_or_else(|| invalid("a message has no Content-Length"))?;
    if length > MAX_MESSAGE_BYTES {
        return Err(invalid("a message is larger than the engine accepts"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_message(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

pub fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn failure(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(body: &str) -> String {
        format!("Content-Length: {}\r\n\r\n{body}", body.len())
    }

    #[test]
    fn reads_frames_back_to_back_and_stops_cleanly_between_them() {
        let input = format!("{}{}", frame("{\"a\":1}"), frame("[]"));
        let mut reader = Cursor::new(input.into_bytes());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"[]");
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn accepts_other_headers_and_any_case() {
        let input = "content-type: application/vscode-jsonrpc\r\ncontent-length: 2\r\n\r\n{}";
        let mut reader = Cursor::new(input.as_bytes().to_vec());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"{}");
    }

    #[test]
    fn refuses_a_frame_without_length_or_beyond_the_limit() {
        let mut missing = Cursor::new(b"X-Other: 1\r\n\r\n{}".to_vec());
        assert_eq!(read_frame(&mut missing).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let huge = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1);
        let mut reader = Cursor::new(huge.into_bytes());
        assert_eq!(read_frame(&mut reader).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn reports_input_that_ends_inside_a_frame() {
        let mut header = Cursor::new(b"Content-Length: 2\r\n".to_vec());
        assert_eq!(read_frame(&mut header).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        let mut body = Cursor::new(b"Content-Length: 5\r\n\r\n{}".to_vec());
        assert_eq!(read_frame(&mut body).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn writes_what_it_reads() {
        let mut out = Vec::new();
        write_message(&mut out, &success(json!(1), json!({ "ok": true }))).unwrap();
        let body = read_frame(&mut Cursor::new(out)).unwrap().unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value, json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }));
    }
}
