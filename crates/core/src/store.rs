use crate::{
    id, now, plugins,
    snapshot::{persist_comparison, validate_comparison},
    string,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct Store {
    db: Connection,
    pub dir: PathBuf,
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let db = Connection::open(dir.join("vividiff.sqlite"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            bail!("INCOMPATIBLE_DATABASE: newer schema {version}");
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, request_key TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(review_id,sequence));
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contents(hash TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comparison_refs(comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES contents(hash), PRIMARY KEY(comparison_id,hash));
      PRAGMA user_version=1;")?;
        Ok(Self {
            db,
            dir: dir.into(),
        })
    }
    fn row(&self, table: &str, id: &str) -> Result<Value> {
        let raw: String = self
            .db
            .query_row(&format!("SELECT data FROM {table} WHERE id=?"), [id], |r| {
                r.get(0)
            })
            .optional()?
            .context("NOT_FOUND")?;
        let mut value: Value = serde_json::from_str(&raw)?;
        if table == "comparisons" {
            if let Some(files) = value["files"].as_array_mut() {
                for f in files {
                    for side in ["left", "right"] {
                        if let Some(key) = f[side]["contentId"].as_str() {
                            let data: String = self.db.query_row(
                                "SELECT data FROM contents WHERE hash=?",
                                [key],
                                |r| r.get(0),
                            )?;
                            f[side] = serde_json::from_str(&data)?;
                        }
                    }
                }
            }
        }
        Ok(value)
    }
    fn list(&self, table: &str, review: Option<&str>) -> Result<Vec<Value>> {
        let sql = if review.is_some() {
            format!("SELECT data FROM {table} WHERE review_id=? ORDER BY rowid")
        } else {
            format!("SELECT data FROM {table} ORDER BY rowid DESC")
        };
        let mut q = self.db.prepare(&sql)?;
        let rows = q.query_map(rusqlite::params_from_iter(review), |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    fn save(&self, table: &str, v: &Value) -> Result<()> {
        self.db.execute(
            &format!("UPDATE {table} SET data=? WHERE id=?"),
            params![v.to_string(), string(v, "id")?],
        )?;
        Ok(())
    }
    fn editable(&self, review: &str) -> Result<Value> {
        let r = self.row("reviews", review)?;
        if r["status"] == "completed" || r["status"] == "cancelled" {
            bail!("REVIEW_READ_ONLY: reopen the review first");
        }
        Ok(r)
    }
    fn touch(&self, review: &str) -> Result<()> {
        let mut r = self.row("reviews", review)?;
        r["updatedAt"] = json!(now());
        self.save("reviews", &r)
    }
    pub fn dispatch(&mut self, method: &str, p: &Value, desktop: bool) -> Result<Value> {
        let private = [
            "comparison_create",
            "comment_save",
            "comment_delete",
            "review_complete",
            "review_reopen",
            "review_cancel",
            "review_delete",
            "preferences_set",
            "plugin_install",
            "plugin_toggle",
        ];
        if private.contains(&method) && !desktop {
            bail!("FORBIDDEN: desktop-only operation");
        }
        match method {
            "health" => Ok(json!({"version":"0.1.0","schemaVersion":1})),
            "review_list" => Ok(json!(self.list("reviews", None)?)),
            "review_create" => self.create(p),
            "review_status" | "review_get" => self.row("reviews", string(p, "reviewId")?),
            "comparison_create" => {
                self.editable(string(p, "reviewId")?)?;
                self.compare(p)
            }
            "comparison_get" => self.row("comparisons", string(p, "comparisonId")?),
            "comparison_list" => {
                let mut values = self.list("comparisons", Some(string(p, "reviewId")?))?;
                for v in &mut values {
                    if let Some(files) = v["files"].as_array_mut() {
                        for f in files {
                            f.as_object_mut().unwrap().remove("left");
                            f.as_object_mut().unwrap().remove("right");
                        }
                    }
                }
                Ok(json!(values))
            }
            "review_comments" => {
                let r = self.row("reviews", string(p, "reviewId")?)?;
                let all = self.list("comments", Some(string(p, "reviewId")?))?;
                let offset = p["offset"].as_u64().unwrap_or(0) as usize;
                let limit = p["limit"].as_u64().unwrap_or(100).min(500) as usize;
                let filtered: Vec<_> = all
                    .into_iter()
                    .filter(|c| p["status"].is_null() || c["status"] == p["status"])
                    .collect();
                Ok(
                    json!({"items":filtered.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":filtered.len(),"draft":r["status"]!="completed","offset":offset}),
                )
            }
            "comment_save" => self.comment(p),
            "comment_delete" => {
                let c = self.row("comments", string(p, "commentId")?)?;
                self.editable(string(&c, "reviewId")?)?;
                self.db
                    .execute("DELETE FROM comments WHERE id=?", [string(p, "commentId")?])?;
                self.touch(string(&c, "reviewId")?)?;
                Ok(json!({"deleted":true}))
            }
            "review_complete" => self.complete(string(p, "reviewId")?),
            "review_reopen" | "review_cancel" => {
                let mut r = self.row("reviews", string(p, "reviewId")?)?;
                r["status"] = json!(if method == "review_reopen" {
                    "in_progress"
                } else {
                    "cancelled"
                });
                r["updatedAt"] = json!(now());
                self.save("reviews", &r)?;
                Ok(r)
            }
            "review_delete" => {
                let tx = self.db.transaction()?;
                tx.execute("DELETE FROM reviews WHERE id=?", [string(p, "reviewId")?])?;
                tx.execute(
                    "DELETE FROM contents WHERE hash NOT IN (SELECT hash FROM comparison_refs)",
                    [],
                )?;
                tx.commit()?;
                Ok(json!({"deleted":true}))
            }
            "review_result" => {
                let review = string(p, "reviewId")?;
                self.row("reviews", review)?;
                let values = self.list("submissions", Some(review))?;
                let result = values
                    .into_iter()
                    .rev()
                    .find(|v| p["sequence"].is_null() || v["sequence"] == p["sequence"]);
                Ok(json!({"available":result.is_some(),"result":result}))
            }
            "revisions" => plugins::call(
                &self.dir,
                p["provider"].as_str().unwrap_or("git"),
                "listRevisions",
                p,
            ),
            "provider_capabilities" => plugins::call(
                &self.dir,
                p["provider"].as_str().unwrap_or("git"),
                "getCapabilities",
                p,
            ),
            "providers" => {
                let mut v = vec![json!({"id":"git","kind":"vcs","enabled":true,"builtin":true})];
                v.extend(plugins::manifests(&self.dir)?);
                Ok(json!(v))
            }
            "plugin_install" => plugins::install(&self.dir, p),
            "plugin_toggle" => {
                let m = plugins::manifests(&self.dir)?
                    .into_iter()
                    .find(|v| v["id"] == p["id"])
                    .context("NOT_FOUND")?;
                let flag = Path::new(string(&m, "directory")?).join("disabled");
                if p["enabled"] == true {
                    if flag.exists() {
                        fs::remove_file(flag)?;
                    }
                } else {
                    fs::write(flag, b"")?;
                }
                Ok(json!({"ok":true}))
            }
            "assets" => plugins::assets(&self.dir),
            "locales" => plugins::locales(&self.dir),
            "preferences_get" => {
                let data: Option<String> = self
                    .db
                    .query_row("SELECT data FROM preferences WHERE key='ui'", [], |r| {
                        r.get(0)
                    })
                    .optional()?;
                Ok(data
                    .map(|s| serde_json::from_str::<Value>(&s))
                    .transpose()?
                    .unwrap_or(json!({"language":"system"})))
            }
            "preferences_set" => {
                self.db.execute("INSERT INTO preferences(key,data) VALUES('ui',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[p.to_string()])?;
                Ok(p.clone())
            }
            "data_directory" => Ok(json!({"path":self.dir})),
            _ => bail!("METHOD_NOT_FOUND: {method}"),
        }
    }
    fn create(&mut self, p: &Value) -> Result<Value> {
        if let Some(key) = p["idempotencyKey"].as_str() {
            let old: Option<String> = self
                .db
                .query_row("SELECT data FROM reviews WHERE request_key=?", [key], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(old) = old {
                return Ok(serde_json::from_str(&old)?);
            }
        }
        let source = p["source"].as_str().unwrap_or("vcs");
        if !["vcs", "files"].contains(&source) {
            bail!("INVALID_ARGUMENT: source");
        }
        let review = json!({"id":id(),"title":p["title"].as_str().unwrap_or("Review"),"description":p["description"].as_str().unwrap_or(""),"source":source,"provider":p["provider"].as_str().unwrap_or("git"),"repo":p["repo"],"status":"in_progress","createdAt":now(),"updatedAt":now(),"latestSequence":0});
        // Capture before inserting to avoid orphaned sessions on invalid source.
        let mut request = p.clone();
        request["reviewId"] = review["id"].clone();
        let comparison = self.capture(&review, &request)?;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO reviews(id,request_key,data) VALUES(?,?,?)",
            params![
                string(&review, "id")?,
                p["idempotencyKey"].as_str(),
                review.to_string()
            ],
        )?;
        persist_comparison(&tx, &comparison)?;
        tx.commit()?;
        Ok(review)
    }
    fn capture(&self, r: &Value, p: &Value) -> Result<Value> {
        let mut v = if r["source"] == "files" {
            let left = string(p, "left")?;
            let right = string(p, "right")?;
            let read = |s: &str| -> Result<Value> {
                let m = fs::metadata(s)?;
                if !m.is_file() {
                    bail!("INVALID_SOURCE: expected regular file");
                }
                if m.len() > 2 * 1024 * 1024 {
                    return Ok(json!({"kind":"large","size":m.len()}));
                }
                Ok(crate::content(&fs::read(s)?))
            };
            let a = read(left)?;
            let b = read(right)?;
            if a != read(left)? || b != read(right)? {
                bail!("SOURCE_CHANGED: retry");
            }
            json!({"provider":"files","left":left,"right":right,"files":[{"path":right,"oldPath":left,"status":"M","left":a,"right":b}]})
        } else {
            let provider = string(r, "provider")?;
            let info = plugins::call(&self.dir, provider, "initialize", &json!({}))?;
            if info["protocolVersion"] != 1 {
                bail!("INCOMPATIBLE_PLUGIN: initialize");
            }
            let mut args = p.clone();
            args["repo"] = r["repo"].clone();
            args["left"] = json!(p["left"].as_str().unwrap_or("HEAD"));
            args["right"] = json!(p["right"].as_str().unwrap_or("WORKTREE"));
            let value = plugins::call(&self.dir, provider, "listChanges", &args)?;
            validate_comparison(&value)?;
            value
        };
        if let Some(files) = v["files"].as_array_mut() {
            for f in files {
                for side in ["left", "right"] {
                    if let Some(text) = f[side]["text"].as_str() {
                        let hash = crate::digest(text.as_bytes());
                        f[side]["hash"] = json!(hash);
                    }
                }
            }
        }
        v["provider"] = if r["source"] == "files" {
            json!("files")
        } else {
            r["provider"].clone()
        };
        v["id"] = json!(id());
        v["reviewId"] = r["id"].clone();
        v["createdAt"] = json!(now());
        v["selection"] = json!({"left":p["left"].as_str().unwrap_or("HEAD"),"right":p["right"].as_str().unwrap_or("WORKTREE"),"mode":p["mode"].as_str().unwrap_or("direct")});
        Ok(v)
    }
    fn compare(&mut self, p: &Value) -> Result<Value> {
        let r = self.row("reviews", string(p, "reviewId")?)?;
        let c = self.capture(&r, p)?;
        let tx = self.db.transaction()?;
        persist_comparison(&tx, &c)?;
        tx.commit()?;
        self.touch(string(&r, "id")?)?;
        Ok(c)
    }
    fn comment(&mut self, p: &Value) -> Result<Value> {
        let review = string(p, "reviewId")?;
        self.editable(review)?;
        let body = string(p, "body")?;
        if body.trim().is_empty() || body.len() > 64 * 1024 {
            bail!("INVALID_ARGUMENT: comment body");
        }
        if let Some(cid) = p["id"].as_str() {
            let mut c = self.row("comments", cid)?;
            if c["reviewId"] != review {
                bail!("INVALID_ARGUMENT: reviewId");
            }
            c["body"] = json!(body);
            let status = p["status"].as_str().unwrap_or("open");
            if !["open", "resolved"].contains(&status) {
                bail!("INVALID_ARGUMENT: status");
            }
            c["status"] = json!(status);
            c["updatedAt"] = json!(now());
            self.save("comments", &c)?;
            self.touch(review)?;
            return Ok(c);
        }
        let comparison = self.row("comparisons", string(p, "comparisonId")?)?;
        if comparison["reviewId"] != review {
            bail!("INVALID_ARGUMENT: comparisonId");
        }
        let path = string(p, "path")?;
        let file = comparison["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .context("INVALID_ARGUMENT: file")?;
        let side = string(p, "side")?;
        if !["left", "right", "file"].contains(&side) {
            bail!("INVALID_ARGUMENT: side");
        }
        let mut anchor = json!({"comparisonId":comparison["id"],"provider":comparison["provider"],"leftRevision":comparison["left"],"rightRevision":comparison["right"],"path":path,"oldPath":file["oldPath"],"side":side});
        if side != "file" {
            let text = file[side]["text"]
                .as_str()
                .context("INVALID_ARGUMENT: non-text anchor")?;
            let lines: Vec<&str> = text.split('\n').collect();
            let start = p["startLine"]
                .as_u64()
                .context("INVALID_ARGUMENT: startLine")? as usize;
            let end = p["endLine"].as_u64().unwrap_or(start as u64) as usize;
            if start == 0 || end < start || end > lines.len() {
                bail!("INVALID_ARGUMENT: line range");
            }
            anchor["startLine"] = json!(start);
            anchor["endLine"] = json!(end);
            anchor["contentHash"] = file[side]["hash"].clone();
            anchor["selectedText"] = json!(lines[start - 1..end].join("\n"));
            anchor["context"] =
                json!(lines[start.saturating_sub(4)..(end + 3).min(lines.len())].join("\n"));
        }
        let c = json!({"id":id(),"reviewId":review,"body":body,"status":"open","anchor":anchor,"createdAt":now(),"updatedAt":now()});
        self.db.execute(
            "INSERT INTO comments(id,review_id,data) VALUES(?,?,?)",
            params![string(&c, "id")?, review, c.to_string()],
        )?;
        self.touch(review)?;
        Ok(c)
    }
    fn complete(&mut self, review: &str) -> Result<Value> {
        let mut r = self.editable(review)?;
        let seq = r["latestSequence"].as_u64().unwrap_or(0) + 1;
        let comments = self.list("comments", Some(review))?;
        let mut comparisons = self.list("comparisons", Some(review))?;
        for c in &mut comparisons {
            c.as_object_mut().unwrap().remove("files");
        }
        let result = json!({"schemaVersion":1,"id":id(),"submissionId":id(),"reviewId":review,"sequence":seq,"completedAt":now(),"repo":r["repo"],"title":r["title"],"description":r["description"],"comparisons":comparisons,"comments":comments});
        r["status"] = json!("completed");
        r["latestSequence"] = json!(seq);
        r["updatedAt"] = json!(now());
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO submissions(id,review_id,sequence,data) VALUES(?,?,?,?)",
            params![
                string(&result, "id")?,
                review,
                seq as i64,
                result.to_string()
            ],
        )?;
        tx.execute(
            "UPDATE reviews SET data=? WHERE id=?",
            params![r.to_string(), review],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
