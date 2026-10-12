use crate::string;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
pub fn validate_comparison(v: &Value) -> Result<()> {
    string(v, "left")?;
    string(v, "right")?;
    let files = v["files"]
        .as_array()
        .context("INVALID_PLUGIN_RESPONSE: files")?;
    if files.len() > 3000 {
        bail!("RESOURCE_LIMIT: files");
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    for f in files {
        let path = string(f, "path")?;
        string(f, "oldPath")?;
        string(f, "status")?;
        if !seen.insert(path) {
            bail!("INVALID_PLUGIN_RESPONSE: duplicate paths");
        }
        for side in ["left", "right"] {
            let c = &f[side];
            if c.is_null() {
                continue;
            }
            let kind = string(c, "kind")?;
            if !["text", "binary", "large", "submodule", "symlink"].contains(&kind) {
                bail!("INVALID_PLUGIN_RESPONSE: content kind");
            }
            if kind == "text" {
                let text = string(c, "text")?;
                total += text.len();
                if text.len() > 2 * 1024 * 1024 {
                    bail!("RESOURCE_LIMIT: file text");
                }
            }
        }
    }
    if total > 24 * 1024 * 1024 {
        bail!("RESOURCE_LIMIT: snapshot text");
    }
    Ok(())
}
pub fn persist_comparison(tx: &Transaction<'_>, comparison: &Value) -> Result<()> {
    let mut stored = comparison.clone();
    let mut hashes = std::collections::HashSet::new();
    for file in stored["files"].as_array_mut().context("INVALID_SNAPSHOT")? {
        for side in ["left", "right"] {
            if file[side].is_null() {
                continue;
            }
            let raw = file[side].to_string();
            let hash = crate::digest(raw.as_bytes());
            tx.execute(
                "INSERT OR IGNORE INTO contents(hash,data) VALUES(?,?)",
                params![hash, raw],
            )?;
            hashes.insert(hash.clone());
            file[side] =
                json!({"contentId":hash,"kind":file[side]["kind"],"size":file[side]["size"]});
        }
    }
    tx.execute(
        "INSERT INTO comparisons(id,review_id,data) VALUES(?,?,?)",
        params![
            string(&stored, "id")?,
            string(&stored, "reviewId")?,
            stored.to_string()
        ],
    )?;
    for hash in hashes {
        tx.execute(
            "INSERT INTO comparison_refs(comparison_id,hash) VALUES(?,?)",
            params![string(&stored, "id")?, hash],
        )?;
    }
    Ok(())
}
