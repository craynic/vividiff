use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};
use vividiff_core::{git, store::Store};
fn git_cmd(dir: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8_lossy(&result.stdout).trim().into()
}
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git_cmd(dir.path(), &["init", "-q"]);
    git_cmd(dir.path(), &["config", "user.name", "Test"]);
    git_cmd(dir.path(), &["config", "user.email", "test@localhost"]);
    git_cmd(dir.path(), &["config", "core.autocrlf", "false"]);
    dir
}
#[test]
fn git_read_only_matrix() {
    let dir = repo();
    let p = dir.path();
    fs::write(p.join("中文 space.txt"), "one\ntwo\n").unwrap();
    fs::write(p.join("empty"), "").unwrap();
    git_cmd(p, &["add", "."]);
    git_cmd(p, &["commit", "-qm", "initial"]);
    let base = git_cmd(p, &["rev-parse", "HEAD"]);
    fs::write(p.join("中文 space.txt"), "one\nstaged\n").unwrap();
    git_cmd(p, &["add", "."]);
    fs::write(p.join("中文 space.txt"), "one\nworking\n").unwrap();
    fs::write(p.join("untracked"), "new").unwrap();
    let index = fs::read(p.join(".git/index")).unwrap();
    let head = fs::read(p.join(".git/HEAD")).unwrap();
    for (left, right, text) in [
        ("HEAD", "INDEX", "staged"),
        ("INDEX", "WORKTREE", "working"),
        ("HEAD", "WORKTREE", "working"),
    ] {
        let c = git::compare(&json!({"repo":p,"left":left,"right":right})).unwrap();
        let f = c["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == "中文 space.txt")
            .unwrap();
        assert!(f["right"]["text"].as_str().unwrap().contains(text));
    }
    let reversed = git::compare(&json!({"repo":p,"left":"WORKTREE","right":"HEAD"})).unwrap();
    assert!(reversed["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["path"] == "untracked" && f["status"] == "D"));
    assert_eq!(head, fs::read(p.join(".git/HEAD")).unwrap());
    assert_eq!(index, fs::read(p.join(".git/index")).unwrap());
    assert_eq!(base, git_cmd(p, &["rev-parse", "HEAD"]));
    assert_eq!(
        fs::read_to_string(p.join("中文 space.txt")).unwrap(),
        "one\nworking\n"
    );
    assert!(git::resolve(p, "--help").is_err());
    assert!(git::safe_path(p, "../secret").is_err());
}
#[test]
fn git_empty_rename_mergebase_binary() {
    let dir = repo();
    let p = dir.path();
    fs::write(p.join("a.txt"), "hello\nworld\n").unwrap();
    let c = git::compare(&json!({"repo":p,"left":"HEAD","right":"WORKTREE"})).unwrap();
    assert_eq!(c["left"], "EMPTY");
    assert_eq!(c["files"][0]["status"], "A");
    git_cmd(p, &["add", "."]);
    git_cmd(p, &["commit", "-qm", "first"]);
    let base = git_cmd(p, &["rev-parse", "HEAD"]);
    fs::rename(p.join("a.txt"), p.join("b.txt")).unwrap();
    fs::write(p.join("binary"), [0, 1, 2, 3]).unwrap();
    git_cmd(p, &["add", "."]);
    git_cmd(p, &["commit", "-qm", "second"]);
    let c =
        git::compare(&json!({"repo":p,"left":base,"right":"HEAD","mode":"merge-base"})).unwrap();
    assert!(c["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["status"] == "R" && f["oldPath"] == "a.txt"));
    assert!(c["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["right"]["kind"] == "binary"));
    assert!(
        git::compare(&json!({"repo":p,"left":"HEAD","right":"WORKTREE","mode":"merge-base"}))
            .is_err()
    );
}
#[test]
fn review_lifecycle_snapshots_and_results() {
    let tmp = tempfile::tempdir().unwrap();
    let left = tmp.path().join("left.txt");
    let right = tmp.path().join("right.txt");
    fs::write(&left, "a\nb\n").unwrap();
    fs::write(&right, "a\nc\n").unwrap();
    let mut s = Store::open(&tmp.path().join("data")).unwrap();
    let input =
        json!({"source":"files","left":left,"right":right,"title":"test","idempotencyKey":"same"});
    let r = s.dispatch("review_create", &input, false).unwrap();
    let rid = r["id"].as_str().unwrap();
    assert_eq!(r, s.dispatch("review_create", &input, false).unwrap());
    let p = json!({"reviewId":rid});
    let cs = s.dispatch("comparison_list", &p, true).unwrap();
    let cid = cs[0]["id"].as_str().unwrap();
    let comment = json!({"reviewId":rid,"comparisonId":cid,"path":right.to_str().unwrap(),"side":"right","startLine":2,"endLine":2,"body":"fix this"});
    assert!(s.dispatch("comment_save", &comment, false).is_err());
    let c = s.dispatch("comment_save", &comment, true).unwrap();
    assert_eq!(c["anchor"]["selectedText"], "c");
    fs::write(&right, "changed\n").unwrap();
    let snapshot = s
        .dispatch("comparison_get", &json!({"comparisonId":cid}), true)
        .unwrap();
    assert_eq!(snapshot["files"][0]["right"]["text"], "a\nc\n");
    assert!(s.dispatch("review_complete", &p, false).is_err());
    let submission = s.dispatch("review_complete", &p, true).unwrap();
    assert_eq!(submission["sequence"], 1);
    assert_eq!(submission["comments"][0]["body"], "fix this");
    assert!(s.dispatch("comment_save", &comment, true).is_err());
    drop(s);
    let mut s = Store::open(&tmp.path().join("data")).unwrap();
    assert_eq!(
        s.dispatch("review_result", &p, false).unwrap()["result"],
        submission
    );
    s.dispatch("review_reopen", &p, true).unwrap();
    s.dispatch(
        "comment_save",
        &json!({"id":c["id"],"reviewId":rid,"body":"revised","status":"resolved"}),
        true,
    )
    .unwrap();
    let second = s.dispatch("review_complete", &p, true).unwrap();
    assert_eq!(second["sequence"], 2);
    assert_eq!(
        s.dispatch(
            "review_result",
            &json!({"reviewId":rid,"sequence":1}),
            false
        )
        .unwrap()["result"],
        submission
    );
    s.dispatch("review_delete", &p, true).unwrap();
    assert!(s.dispatch("review_status", &p, false).is_err());
}
#[test]
fn invalid_anchors_and_empty_submission() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("a"), "x").unwrap();
    let mut s = Store::open(&tmp.path().join("data")).unwrap();
    let r = s
        .dispatch(
            "review_create",
            &json!({"source":"files","left":tmp.path().join("a"),"right":tmp.path().join("a")}),
            false,
        )
        .unwrap();
    let p = json!({"reviewId":r["id"]});
    let cs = s.dispatch("comparison_list", &p, true).unwrap();
    let bad = json!({"reviewId":r["id"],"comparisonId":cs[0]["id"],"path":tmp.path().join("a"),"side":"right","startLine":0,"body":"bad"});
    assert!(s.dispatch("comment_save", &bad, true).is_err());
    assert_eq!(
        s.dispatch("review_result", &p, false).unwrap()["available"],
        false
    );
    assert_eq!(
        s.dispatch("review_complete", &p, true).unwrap()["comments"],
        json!([])
    );
}
#[test]
fn encoding_limits_and_language_files() {
    assert_eq!(vividiff_core::content(&[0xff, 0xfe, 65, 0])["text"], "A");
    assert_eq!(vividiff_core::content(&[0, 1])["kind"], "binary");
    assert_eq!(
        vividiff_core::content(&vec![65; 2 * 1024 * 1024 + 1])["kind"],
        "large"
    );
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join("locales")).unwrap();
    fs::write(tmp.path().join("locales/fr.json"),json!({"schemaVersion":1,"locale":"fr","nativeName":"Français","translations":{"common":{"cancel":"Annuler"}}}).to_string()).unwrap();
    fs::write(tmp.path().join("locales/bad.json"), "{").unwrap();
    let packs = vividiff_core::plugins::locales(tmp.path()).unwrap();
    assert_eq!(packs["packs"].as_array().unwrap().len(), 1);
    assert_eq!(packs["errors"].as_array().unwrap().len(), 1);
}
#[test]
fn thousand_file_snapshot_is_bounded_and_read_only() {
    let dir = repo();
    let p = dir.path();
    for n in 0..1000 {
        fs::write(p.join(format!("file-{n}.txt")), "baseline\n").unwrap();
    }
    git_cmd(p, &["add", "."]);
    git_cmd(p, &["commit", "-qm", "large baseline"]);
    let index = fs::read(p.join(".git/index")).unwrap();
    for n in 0..1000 {
        fs::write(p.join(format!("file-{n}.txt")), "changed\n").unwrap();
    }
    let start = std::time::Instant::now();
    let c = git::compare(&json!({"repo":p,"left":"HEAD","right":"WORKTREE"})).unwrap();
    eprintln!("1000 changed files captured in {:?}", start.elapsed());
    assert_eq!(c["files"].as_array().unwrap().len(), 1000);
    assert!(start.elapsed().as_secs() < 60);
    assert_eq!(index, fs::read(p.join(".git/index")).unwrap());
}
#[test]
fn rejects_newer_database_schema() {
    let tmp = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(tmp.path().join("vividiff.sqlite")).unwrap();
    db.execute_batch("PRAGMA user_version=99").unwrap();
    drop(db);
    assert!(Store::open(tmp.path()).is_err());
}
#[test]
fn plugins_trust_toggle_and_assets() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("plugin.json"),json!({"id":"fixture","kind":"vcs","protocolVersion":1,"entry":"plugin.js","runtime":"node"}).to_string()).unwrap();
    fs::write(source.join("plugin.js"), "console.log('unused');").unwrap();
    let data = tmp.path().join("data");
    fs::create_dir(&data).unwrap();
    assert!(vividiff_core::plugins::install(&data, &json!({"path":source})).is_err());
    vividiff_core::plugins::install(&data, &json!({"path":source,"trusted":true})).unwrap();
    let mut s = Store::open(&data).unwrap();
    s.dispatch(
        "plugin_toggle",
        &json!({"id":"fixture","enabled":false}),
        true,
    )
    .unwrap();
    assert_eq!(
        vividiff_core::plugins::manifests(&data).unwrap()[0]["enabled"],
        false
    );
    assert!(vividiff_core::plugins::call(&data, "fixture", "initialize", &Value::Null).is_err());
}
