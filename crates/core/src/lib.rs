pub mod git;
pub mod mcp;
pub mod plugins;
pub mod process;
pub mod snapshot;
pub mod store;
pub mod transport;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn digest(data: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(data))
}
pub fn data_dir() -> Result<PathBuf> {
    let path = std::env::var_os("VIVIDIFF_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            directories::ProjectDirs::from("app", "vividiff", "vividiff")
                .context("NO_DATA_DIR")?
                .data_local_dir()
                .into(),
        );
    fs::create_dir_all(&path)?;
    Ok(path)
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("INVALID_ARGUMENT: {key}"))
}
pub fn error(e: &anyhow::Error) -> Value {
    let message = e.to_string();
    let code = message
        .split(':')
        .next()
        .filter(|s| s.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
        .unwrap_or("INTERNAL");
    json!({"code":code,"message":message})
}
pub fn content(bytes: &[u8]) -> Value {
    let hash = digest(bytes);
    if bytes.len() > 2 * 1024 * 1024 {
        return json!({"hash":hash,"kind":"large","size":bytes.len()});
    }
    let decoded = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            None
        } else {
            let le = bytes[0] == 0xff;
            let chars: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|b| {
                    if le {
                        u16::from_le_bytes([b[0], b[1]])
                    } else {
                        u16::from_be_bytes([b[0], b[1]])
                    }
                })
                .collect();
            String::from_utf16(&chars).ok()
        }
    } else {
        std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
            .ok()
            .map(str::to_owned)
    };
    match decoded {
        Some(text) if !text.contains('\0') => {
            json!({"hash":hash,"kind":"text","size":bytes.len(),"text":text})
        }
        _ => json!({"hash":hash,"kind":"binary","size":bytes.len()}),
    }
}
