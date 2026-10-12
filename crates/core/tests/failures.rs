use serde_json::json;
use std::{fs, process::Command};
use vividiff_core::{plugins, process, snapshot};

#[test]
fn plugin_crash_timeout_and_bad_response_are_bounded() {
    let mut timeout = Command::new("node");
    timeout.args(["-e", "setTimeout(()=>{},10000)"]);
    let started = std::time::Instant::now();
    assert!(process::run(timeout, None, 1)
        .unwrap_err()
        .to_string()
        .contains("TIMEOUT"));
    assert!(started.elapsed().as_secs() < 8);

    let mut crash = Command::new("node");
    crash.args([
        "-e",
        "process.stderr.write('plugin crashed');process.exit(2)",
    ]);
    assert!(process::run(crash, None, 5)
        .unwrap_err()
        .to_string()
        .contains("PROCESS_FAILED"));

    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    let data = tmp.path().join("data");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(
        source.join("plugin.json"),
        json!({"id":"broken","protocolVersion":1,"kind":"vcs","runtime":"node","entry":"main.mjs"})
            .to_string(),
    )
    .unwrap();
    fs::write(source.join("main.mjs"), "console.log('not json')").unwrap();
    plugins::install(&data, &json!({"path":source,"trusted":true})).unwrap();
    assert!(plugins::call(&data, "broken", "initialize", &json!({}))
        .unwrap_err()
        .to_string()
        .contains("INVALID_PLUGIN_RESPONSE"));
}

#[test]
fn plugin_validation_rejects_unsupported_protocol_and_invalid_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("plugin.json"),
        json!({"id":"incompatible","protocolVersion":99,"kind":"vcs"}).to_string(),
    )
    .unwrap();
    assert!(plugins::install(
        &tmp.path().join("data"),
        &json!({"path":source,"trusted":true})
    )
    .is_err());
    assert!(snapshot::validate_comparison(&json!({"left":"a","right":"b","files":[{"path":"x","oldPath":"x","status":"M","left":{"kind":"text","text":7},"right":null}]})).is_err());
    assert!(snapshot::validate_comparison(&json!({"left":"a","right":"b","files":[{"path":"x","oldPath":"x","status":"M"},{"path":"x","oldPath":"x","status":"M"}]})).is_err());
}
