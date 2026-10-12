use crate::{content, process};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut c = Command::new("git");
    c.arg("--no-optional-locks")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.external=",
            "-c",
            "core.hooksPath=",
        ])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    process::run(c, None, 30)
}
fn txt(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8(git(root, args)?)
        .context("UNSUPPORTED_ENCODING: Git metadata")?
        .trim()
        .into())
}
pub fn root(path: &str) -> Result<PathBuf> {
    let p = fs::canonicalize(path).context("REPOSITORY_NOT_FOUND")?;
    Ok(PathBuf::from(txt(&p, &["rev-parse", "--show-toplevel"])?))
}
pub fn resolve(root: &Path, rev: &str) -> Result<String> {
    if ["WORKTREE", "INDEX", "EMPTY"].contains(&rev) {
        return Ok(rev.into());
    }
    if rev.is_empty() || rev.starts_with('-') {
        bail!("INVALID_REVISION: {rev}");
    }
    match txt(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    ) {
        Ok(s) => Ok(s),
        Err(_) if rev == "HEAD" && git(root, &["symbolic-ref", "-q", "HEAD"]).is_ok() => {
            Ok("EMPTY".into())
        }
        Err(e) => Err(e),
    }
}
fn empty(root: &Path) -> Result<String> {
    txt(root, &["hash-object", "-t", "tree", "--stdin"])
}
pub fn revisions(root: &Path, offset: usize) -> Result<Value> {
    let mut items = vec![
        json!({"id":"WORKTREE","label":"WORKTREE"}),
        json!({"id":"INDEX","label":"INDEX"}),
        json!({"id":"EMPTY","label":"EMPTY"}),
    ];
    if offset == 0 {
        for line in txt(
            root,
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/tags",
            ],
        )?
        .lines()
        {
            items.push(json!({"id":line,"label":line}));
        }
    }
    if let Ok(log) = txt(
        root,
        &[
            "log",
            "--all",
            "--format=%H %s",
            "-100",
            &format!("--skip={offset}"),
        ],
    ) {
        for line in log.lines() {
            if let Some((id, label)) = line.split_once(' ') {
                items.push(json!({"id":id,"label":format!("{} {}",&id[..8],label)}));
            }
        }
    }
    Ok(json!({"items":items,"nextOffset":offset+100}))
}
pub fn safe_path(root: &Path, path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("INVALID_PATH: {path}");
    }
    // Do not follow symlinks/junctions outside the selected root.
    let full = root.join(p);
    if full.exists() && !fs::canonicalize(&full)?.starts_with(fs::canonicalize(root)?) {
        bail!("INVALID_PATH: outside source root");
    }
    Ok(full)
}
pub fn read_file(root: &Path, rev: &str, path: &str) -> Result<Value> {
    if rev == "EMPTY" {
        return Ok(Value::Null);
    }
    let full = safe_path(root, path)?;
    if rev == "WORKTREE" {
        let meta = match fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(e) => return Err(e.into()),
        };
        if meta.file_type().is_symlink() {
            return Ok(
                json!({"kind":"symlink","text":fs::read_link(&full)?.to_string_lossy(),"size":0}),
            );
        }
        if meta.is_dir() {
            return Ok(json!({"kind":"submodule","size":0}));
        }
        if meta.len() > 2 * 1024 * 1024 {
            return Ok(json!({"kind":"large","size":meta.len()}));
        }
        return Ok(content(&fs::read(full)?));
    }
    let spec = if rev == "INDEX" {
        format!(":{path}")
    } else {
        format!("{rev}:{path}")
    };
    let size = match txt(root, &["cat-file", "-s", &spec]) {
        Ok(n) => n.parse::<usize>()?,
        Err(_) => return Ok(Value::Null),
    };
    let kind = txt(root, &["cat-file", "-t", &spec])?;
    if kind != "blob" {
        return Ok(json!({"kind":"submodule","size":size}));
    }
    if size > 2 * 1024 * 1024 {
        return Ok(json!({"kind":"large","size":size}));
    }
    Ok(content(&git(root, &["cat-file", "blob", &spec])?))
}
fn names(root: &Path, left: &str, right: &str) -> Result<Vec<(String, String, String)>> {
    if left == right {
        return Ok(vec![]);
    }
    let (l, r, reverse) = if left == "WORKTREE" || (left == "INDEX" && right != "WORKTREE") {
        (right, left, true)
    } else {
        (left, right, false)
    };
    let empty_id = empty(root)?;
    let l = if l == "EMPTY" { empty_id.as_str() } else { l };
    let r = if r == "EMPTY" { empty_id.as_str() } else { r };
    let mut args = vec![
        "diff",
        "--name-status",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--ignore-submodules=none",
    ];
    if r == "WORKTREE" {
        if l != "INDEX" {
            args.push(l);
        }
    } else if r == "INDEX" {
        args.push("--cached");
        args.push(l);
    } else {
        args.push(l);
        args.push(r);
    }
    args.push("--");
    let data = git(root, &args)?;
    let entries: Vec<&str> = std::str::from_utf8(&data)
        .context("UNSUPPORTED_ENCODING: path")?
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect();
    let mut changes = BTreeMap::new();
    let mut i = 0;
    while i < entries.len() {
        let status = entries[i];
        i += 1;
        let a = *entries.get(i).context("INVALID_DIFF")?;
        i += 1;
        let b = if status.starts_with('R') || status.starts_with('C') {
            let b = *entries.get(i).context("INVALID_DIFF")?;
            i += 1;
            b
        } else {
            a
        };
        let (a, b, s) = if reverse {
            (
                b,
                a,
                match &status[..1] {
                    "A" => "D",
                    "D" => "A",
                    s => s,
                },
            )
        } else {
            (a, b, &status[..1])
        };
        changes.insert(b.to_owned(), (a.to_owned(), b.to_owned(), s.to_owned()));
    }
    if left == "WORKTREE" || right == "WORKTREE" {
        let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
        for p in std::str::from_utf8(&untracked)
            .context("UNSUPPORTED_ENCODING: path")?
            .split('\0')
            .filter(|p| !p.is_empty())
        {
            changes.entry(p.into()).or_insert((
                p.into(),
                p.into(),
                if left == "WORKTREE" { "D" } else { "A" }.into(),
            ));
        }
    }
    Ok(changes.into_values().collect())
}
fn read_many(root: &Path, rev: &str, paths: &[String]) -> Result<BTreeMap<String, Value>> {
    if rev == "WORKTREE" || rev == "EMPTY" {
        return paths
            .iter()
            .map(|p| Ok((p.clone(), read_file(root, rev, p)?)))
            .collect();
    }
    let spec = |p: &str| {
        if rev == "INDEX" {
            format!(":{p}")
        } else {
            format!("{rev}:{p}")
        }
    };
    let batch = |args: &[&str], input: Vec<u8>| -> Result<Vec<u8>> {
        let mut c = Command::new("git");
        c.args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        process::run(c, Some(input), 30)
    };
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(spec(p).as_bytes());
        input.push(0);
    }
    if input.is_empty() {
        return Ok(BTreeMap::new());
    }
    let checks = batch(&["cat-file", "--batch-check", "-Z"], input)?;
    let headers: Vec<_> = checks
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .collect();
    if headers.len() != paths.len() {
        bail!("INVALID_GIT_OUTPUT: batch-check");
    }
    let mut out = BTreeMap::new();
    let mut fetch = Vec::new();
    let mut input = Vec::new();
    for (p, h) in paths.iter().zip(headers) {
        let header = std::str::from_utf8(h)?;
        let parts: Vec<_> = header.split(' ').collect();
        if parts.last() == Some(&"missing") {
            out.insert(p.clone(), Value::Null);
            continue;
        }
        if parts.len() != 3 {
            bail!("INVALID_GIT_OUTPUT: object header");
        }
        let size: usize = parts[2].parse()?;
        if parts[1] != "blob" {
            out.insert(
                p.clone(),
                json!({"kind":"submodule","objectId":parts[0],"size":size}),
            );
        } else if size > 2 * 1024 * 1024 {
            out.insert(
                p.clone(),
                json!({"kind":"large","objectId":parts[0],"size":size}),
            );
        } else {
            fetch.push(p);
            input.extend_from_slice(parts[0].as_bytes());
            input.push(0);
        }
    }
    if !input.is_empty() {
        let bytes = batch(&["cat-file", "--batch", "-Z"], input)?;
        let mut cursor = 0;
        for p in fetch {
            let end = bytes[cursor..]
                .iter()
                .position(|b| *b == 0)
                .context("INVALID_GIT_OUTPUT: batch header")?
                + cursor;
            let header = std::str::from_utf8(&bytes[cursor..end])?;
            let size: usize = header
                .split(' ')
                .nth(2)
                .context("INVALID_GIT_OUTPUT: object size")?
                .parse()?;
            cursor = end + 1;
            let data = bytes
                .get(cursor..cursor + size)
                .context("INVALID_GIT_OUTPUT: object bytes")?;
            out.insert(p.clone(), content(data));
            cursor += size + 1;
        }
    }
    Ok(out)
}
pub fn compare(p: &Value) -> Result<Value> {
    let root = root(crate::string(p, "repo")?)?;
    let mut left = resolve(&root, crate::string(p, "left")?)?;
    let right = resolve(&root, crate::string(p, "right")?)?;
    if p["mode"] == "merge-base" {
        if [&left, &right]
            .iter()
            .any(|s| ["WORKTREE", "INDEX", "EMPTY"].contains(&s.as_str()))
        {
            bail!("UNSUPPORTED_COMPARISON: merge-base requires two commits");
        }
        left = txt(&root, &["merge-base", &left, &right]).context("NO_MERGE_BASE")?;
    }
    let capture = || -> Result<Value> {
        let paths = names(&root, &left, &right)?;
        if paths.len() > 3000 {
            bail!("RESOURCE_LIMIT: more than 3000 changed files; narrow the review");
        }
        let mut files = Vec::new();
        let mut total = 0;
        let left_paths = paths
            .iter()
            .filter(|(_, _, s)| s != "A")
            .map(|(a, _, _)| a.clone())
            .collect::<Vec<_>>();
        let right_paths = paths
            .iter()
            .filter(|(_, _, s)| s != "D")
            .map(|(_, b, _)| b.clone())
            .collect::<Vec<_>>();
        let mut left_files = read_many(&root, &left, &left_paths)?;
        let mut right_files = read_many(&root, &right, &right_paths)?;
        for (old, new, status) in paths {
            let a = left_files.remove(&old).unwrap_or(Value::Null);
            let b = right_files.remove(&new).unwrap_or(Value::Null);
            total += a["text"].as_str().map(str::len).unwrap_or(0)
                + b["text"].as_str().map(str::len).unwrap_or(0);
            if total > 24 * 1024 * 1024 {
                bail!("RESOURCE_LIMIT: comparison text exceeds 24 MiB");
            }
            files.push(json!({"oldPath":old,"path":new,"status":status,"left":a,"right":b}));
        }
        Ok(json!({"provider":"git","repo":root,"left":left,"right":right,"files":files}))
    };
    let first = capture()?;
    if (["INDEX", "WORKTREE"].contains(&left.as_str())
        || ["INDEX", "WORKTREE"].contains(&right.as_str()))
        && first != capture()?
    {
        bail!("SOURCE_CHANGED: source changed during capture; retry");
    }
    Ok(first)
}
pub fn dispatch(method: &str, p: &Value) -> Result<Value> {
    match method {
        "initialize" => Ok(
            json!({"protocolVersion":1,"id":"git","capabilities":["branches","tags","index","worktree","merge-base"]}),
        ),
        "detectRepository" => Ok(json!({"root":root(crate::string(p,"repo")?)?})),
        "getCapabilities" => Ok(json!({"index":true,"worktree":true,"mergeBase":true})),
        "listRevisions" => revisions(
            &root(crate::string(p, "repo")?)?,
            p["offset"].as_u64().unwrap_or(0) as usize,
        ),
        "resolveRevision" => Ok(
            json!({"revision":resolve(&root(crate::string(p,"repo")?)?,crate::string(p,"revision")?)?}),
        ),
        "readFile" => read_file(
            &root(crate::string(p, "repo")?)?,
            &resolve(
                &root(crate::string(p, "repo")?)?,
                crate::string(p, "revision")?,
            )?,
            crate::string(p, "path")?,
        ),
        "listChanges" => compare(p),
        "getMergeBase" => {
            let r = root(crate::string(p, "repo")?)?;
            Ok(
                json!({"revision":txt(&r,&["merge-base",&resolve(&r,crate::string(p,"left")?)?,&resolve(&r,crate::string(p,"right")?)?])?}),
            )
        }
        _ => bail!("METHOD_NOT_FOUND: {method}"),
    }
}
