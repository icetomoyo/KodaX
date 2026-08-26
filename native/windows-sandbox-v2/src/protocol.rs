use std::io::{self, Read, Write};

use anyhow::{Context, Result, anyhow, bail};

pub const PROTOCOL_VERSION: u16 = 5;
pub const MAX_CONTROL_BYTES: usize = 1024 * 1024;
pub const MAX_STREAM_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FrameKind {
    Hello = 1,
    Spawn = 2,
    Ready = 3,
    Stdin = 4,
    CloseStdin = 5,
    Stdout = 6,
    Stderr = 7,
    Exit = 8,
    Error = 9,
    Terminate = 10,
    Started = 11,
    Resume = 12,
}

impl TryFrom<u8> for FrameKind {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Spawn),
            3 => Ok(Self::Ready),
            4 => Ok(Self::Stdin),
            5 => Ok(Self::CloseStdin),
            6 => Ok(Self::Stdout),
            7 => Ok(Self::Stderr),
            8 => Ok(Self::Exit),
            9 => Ok(Self::Error),
            10 => Ok(Self::Terminate),
            11 => Ok(Self::Started),
            12 => Ok(Self::Resume),
            _ => bail!("unknown sandbox protocol frame kind {value}"),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct Frame {
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

fn payload_limit(kind: FrameKind) -> usize {
    match kind {
        FrameKind::Stdin | FrameKind::Stdout | FrameKind::Stderr => MAX_STREAM_BYTES,
        FrameKind::CloseStdin | FrameKind::Terminate | FrameKind::Resume => 0,
        _ => MAX_CONTROL_BYTES,
    }
}

pub fn read_frame(reader: &mut impl Read) -> Result<Option<Frame>> {
    let mut header = [0u8; 5];
    let mut read = 0usize;
    while read < header.len() {
        match reader.read(&mut header[read..]) {
            Ok(0) if read == 0 => return Ok(None),
            Ok(0) => return Err(anyhow!("sandbox protocol ended inside a frame header")),
            Ok(count) => read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error).context("read sandbox protocol frame header"),
        }
    }
    let length = u32::from_le_bytes(header[..4].try_into().expect("four-byte length")) as usize;
    if length == 0 {
        bail!("sandbox protocol frame length must include its kind byte");
    }
    let kind = FrameKind::try_from(header[4])?;
    let payload_length = length - 1;
    let limit = payload_limit(kind);
    if payload_length > limit {
        bail!("sandbox protocol {kind:?} payload is {payload_length} bytes; limit is {limit}");
    }
    let mut payload = vec![0u8; payload_length];
    reader
        .read_exact(&mut payload)
        .with_context(|| format!("read sandbox protocol {kind:?} payload"))?;
    Ok(Some(Frame { kind, payload }))
}

pub fn write_frame(writer: &mut impl Write, kind: FrameKind, payload: &[u8]) -> Result<()> {
    let limit = payload_limit(kind);
    if payload.len() > limit {
        bail!(
            "sandbox protocol {kind:?} payload is {} bytes; limit is {limit}",
            payload.len()
        );
    }
    let length = u32::try_from(payload.len() + 1).context("sandbox frame length overflow")?;
    writer
        .write_all(&length.to_le_bytes())
        .context("write sandbox protocol frame length")?;
    writer
        .write_all(&[kind as u8])
        .context("write sandbox protocol frame kind")?;
    writer
        .write_all(payload)
        .with_context(|| format!("write sandbox protocol {kind:?} payload"))?;
    // The production transport uses unbuffered directional named-pipe files.
    // Calling File::flush invokes FlushFileBuffers and waits for the peer to
    // consume the frame, so protocol progress must not depend on it.
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::*;

    struct OneByteReader<R>(R);

    impl<R: Read> Read for OneByteReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let limit = buffer.len().min(1);
            self.0.read(&mut buffer[..limit])
        }
    }

    #[test]
    fn round_trips_partial_header_and_payload_reads() {
        let mut encoded = Vec::new();
        write_frame(&mut encoded, FrameKind::Stdin, b"hello\0world").unwrap();
        let mut reader = OneByteReader(Cursor::new(encoded));
        assert_eq!(
            read_frame(&mut reader).unwrap(),
            Some(Frame {
                kind: FrameKind::Stdin,
                payload: b"hello\0world".to_vec(),
            })
        );
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    #[test]
    fn rejects_partial_headers_instead_of_treating_them_as_eof() {
        let error = read_frame(&mut Cursor::new(vec![1, 0])).unwrap_err();
        assert!(error.to_string().contains("inside a frame header"));
    }

    #[test]
    fn enforces_stream_and_zero_payload_limits() {
        let oversized = vec![0u8; MAX_STREAM_BYTES + 1];
        assert!(write_frame(&mut Vec::new(), FrameKind::Stdin, &oversized).is_err());
        assert!(write_frame(&mut Vec::new(), FrameKind::CloseStdin, b"x").is_err());
    }

    #[test]
    fn rejects_unknown_frame_kinds() {
        let mut encoded = Vec::from(1u32.to_le_bytes());
        encoded.push(255);
        assert!(read_frame(&mut Cursor::new(encoded)).is_err());
    }
}
