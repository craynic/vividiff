use crate::{process, string};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub fn manifests(dir: &Path) -> Result<Vec<Value>> {
    let folder = dir.join("plugins");
    fs::create_dir_all(&folder)?;
    let mut result = vec![];
    let mut entries = fs::read_dir(folder)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path().join("plugin.json");
        if !path.is_file() {
            continue;
        }
        let loaded = (|| -> Result<Value> {
            if fs::metadata(&path)?.len() > 65536 {
                bail!("RESOURCE_LIMIT");
            }
            let mut v: Value = serde_json::from_slice(&fs::read(&path)?)?;
            validate(&v)?;
            v["directory"] = json!(path.parent().unwrap());
            v["enabled"] = json!(!path.parent().unwrap().join("disabled").exists());
            Ok(v)
        })();
        match loaded{Ok(v)=>result.push(v),Err(e)=>result.push(json!({"id":path.parent().unwrap().file_name().unwrap().to_string_lossy(),"kind":"invalid","error":e.to_string(),"enabled":false}))}
    }
    Ok(result)
}
fn validate(v: &Value) -> Result<()> {
    let id = string(v, "id")?;
    if id == "git"
        || id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("INVALID_PLUGIN: id");
    }
    if v["protocolVersion"] != 1 {
        bail!("INCOMPATIBLE_PLUGIN: protocolVersion");
    }
    if !["vcs", "grammar", "theme"].contains(&string(v, "kind")?) {
        bail!("INVALID_PLUGIN: kind");
    }
    Ok(())
}
fn copy_dir(src: &Path, dst: &Path, budget: &mut u64) -> Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let m = e.file_type()?;
        if m.is_symlink() {
            bail!("INVALID_PLUGIN: symlinks are not allowed");
        }
        let meta = fs::symlink_metadata(e.path())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                bail!("INVALID_PLUGIN: reparse points are not allowed");
            }
        }
        if m.is_dir() {
            copy_dir(&e.path(), &dst.join(e.file_name()), budget)?;
        } else if m.is_file() {
            *budget += meta.len();
            if *budget > 32 * 1024 * 1024 {
                bail!("RESOURCE_LIMIT: plugin exceeds 32 MiB");
            }
            fs::copy(e.path(), dst.join(e.file_name()))?;
        }
    }
    Ok(())
}
pub fn install(dir: &Path, p: &Value) -> Result<Value> {
    let src = fs::canonicalize(string(p, "path")?)?;
    let v: Value = serde_json::from_slice(&fs::read(src.join("plugin.json"))?)?;
    validate(&v)?;
    if v["kind"] == "vcs" && p["trusted"] != true {
        bail!("TRUST_REQUIRED: executable plugins run with your user permissions");
    }
    let dst = dir.join("plugins").join(string(&v, "id")?);
    if dst.exists() {
        bail!("PLUGIN_EXISTS: remove the existing plugin directory first");
    }
    fs::create_dir_all(dir.join("plugins"))?;
    if fs::canonicalize(dir)?.starts_with(&src) {
        bail!("INVALID_PLUGIN: source directory cannot contain the installation directory");
    }
    let tmp = dir.join(format!(".install-{}", crate::id()));
    let result = copy_dir(&src, &tmp, &mut 0);
    if let Err(e) = result {
        let _ = fs::remove_dir_all(tmp);
        return Err(e);
    }
    fs::rename(tmp, &dst)?;
    Ok(json!({"id":v["id"]}))
}
fn resource(manifest: &Value, key: &str) -> Result<PathBuf> {
    crate::git::safe_path(
        Path::new(string(manifest, "directory")?),
        string(manifest, key)?,
    )
}
pub fn assets(dir: &Path) -> Result<Value> {
    let mut grammars = vec![];
    let mut themes = vec![];
    let mut errors = vec![];
    for m in manifests(dir)?.into_iter().filter(|m| m["enabled"] == true) {
        let kind = m["kind"].as_str().unwrap_or("");
        if kind != "grammar" && kind != "theme" {
            continue;
        }
        let r = (|| -> Result<Value> {
            let path = resource(&m, "resource")?;
            if fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
                bail!("RESOURCE_LIMIT: resource");
            }
            let value: Value = serde_json::from_slice(&fs::read(path)?)?;
            Ok(json!({"id":m["id"],"extensions":m["extensions"],"value":value}))
        })();
        match r {
            Ok(v) => {
                if kind == "grammar" {
                    grammars.push(v)
                } else {
                    themes.push(v)
                }
            }
            Err(e) => errors.push(json!({"id":m["id"],"message":e.to_string()})),
        }
    }
    Ok(json!({"grammars":grammars,"themes":themes,"errors":errors}))
}
pub fn call(dir: &Path, provider: &str, method: &str, p: &Value) -> Result<Value> {
    let mut command = if provider == "git" {
        let mut c = Command::new(std::env::current_exe()?);
        c.arg("git-plugin");
        c
    } else {
        let m = manifests(dir)?
            .into_iter()
            .find(|m| m["id"] == provider && m["enabled"] == true && m["kind"] == "vcs")
            .context("PROVIDER_NOT_FOUND")?;
        let entry = resource(&m, "entry")?;
        let runtime = m["runtime"].as_str().unwrap_or("native");
        let mut c = match runtime {
            "node" => {
                let mut c = Command::new("node");
                c.arg(&entry);
                c
            }
            "native" => Command::new(&entry),
            _ => bail!("INVALID_PLUGIN: runtime"),
        };
        c.current_dir(string(&m, "directory")?);
        c
    };
    command.env("VIVIDIFF_PLUGIN_PROTOCOL", "1");
    let request = json!({"jsonrpc":"2.0","id":1,"method":method,"params":p});
    let mut data = serde_json::to_vec(&request)?;
    data.push(b'\n');
    let bytes = process::run(command, Some(data), 120)?;
    let response: Value = serde_json::from_slice(&bytes).context("INVALID_PLUGIN_RESPONSE")?;
    if response["jsonrpc"] != "2.0" || response["id"] != 1 {
        bail!("INVALID_PLUGIN_RESPONSE: envelope");
    }
    if !response["error"].is_null() {
        bail!("PLUGIN_ERROR: {}", response["error"]);
    }
    response
        .get("result")
        .cloned()
        .context("INVALID_PLUGIN_RESPONSE: missing result")
}
pub fn locales(dir: &Path) -> Result<Value> {
    let folder = dir.join("locales");
    fs::create_dir_all(&folder)?;
    let mut packs = vec![];
    let mut errors = vec![];
    let mut used = std::collections::HashSet::from(["en".to_string(), "zh-cn".to_string()]);
    let mut entries = fs::read_dir(folder)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let r = (|| -> Result<Value> {
            if fs::metadata(&path)?.len() > 1024 * 1024 {
                bail!("RESOURCE_LIMIT: locale exceeds 1 MiB");
            }
            let v: Value = serde_json::from_slice(&fs::read(&path)?)?;
            if v["schemaVersion"] != 1 || !v["translations"].is_object() {
                bail!("INVALID_LOCALE: schema");
            }
            let locale = string(&v, "locale")?;
            let parts: Vec<_> = locale.split('-').collect();
            if locale.len() > 40
                || parts[0].len() < 2
                || parts[0].len() > 8
                || !parts[0].bytes().all(|b| b.is_ascii_alphabetic())
                || parts.iter().skip(1).any(|s| {
                    s.is_empty() || s.len() > 8 || !s.bytes().all(|b| b.is_ascii_alphanumeric())
                })
            {
                bail!("INVALID_LOCALE: locale");
            }
            if string(&v, "nativeName")?.is_empty() {
                bail!("INVALID_LOCALE: nativeName");
            }
            if !used.insert(locale.to_ascii_lowercase()) {
                bail!("DUPLICATE_LOCALE: {locale}");
            }
            Ok(v)
        })();
        match r {
            Ok(v) => packs.push(v),
            Err(e) => errors
                .push(json!({"file":entry.file_name().to_string_lossy(),"message":e.to_string()})),
        }
    }
    Ok(json!({"packs":packs,"errors":errors}))
}
