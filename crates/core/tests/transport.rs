use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    time::Duration,
};
use vividiff_core::transport;
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn real_service_mcp_and_security() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    fs::create_dir(&data).unwrap();
    let exe = env!("CARGO_BIN_EXE_vividiff-cli");
    let mut cmd = Command::new(exe);
    cmd.arg("serve").env("VIVIDIFF_DATA_DIR", &data);
    vividiff_core::process::hidden(&mut cmd);
    let mut server = Server(cmd.spawn().unwrap());
    for _ in 0..100 {
        if transport::request(&data, "health", &json!({}), false).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let info: Value =
        serde_json::from_slice(&fs::read(data.join("service.json")).unwrap()).unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{}/rpc", info["port"]);
    assert_eq!(
        client.post(&url).json(&json!({})).send().unwrap().status(),
        403
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(info["token"].as_str().unwrap())
            .header("Origin", "https://evil.example")
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        403
    );
    let repo = tmp.path().join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "Test"],
        vec!["config", "user.email", "test@localhost"],
    ] {
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    fs::write(repo.join("file.txt"), "new file\n").unwrap();
    let mut child = Command::new(exe)
        .arg("mcp")
        .env("VIVIDIFF_DATA_DIR", &data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut call = |method: &str, params: Value| -> Value {
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
        )
        .unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };
    assert_eq!(
        call("initialize", json!({}))["result"]["serverInfo"]["name"],
        "vividiff"
    );
    assert_eq!(
        call("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    let response = call(
        "tools/call",
        json!({"name":"review_create","arguments":{"repo":repo,"left":"HEAD","right":"WORKTREE","open":false,"idempotencyKey":"mcp-test"}}),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    let review: Value =
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let p = json!({"reviewId":review["id"]});
    assert!(transport::request(&data, "review_complete", &p, false).is_err());
    // A trusted non-Git provider must work without changes to the core.
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/fixture");
    transport::request(
        &data,
        "plugin_install",
        &json!({"path":fixture,"trusted":true}),
        true,
    )
    .unwrap();
    fs::write(repo.join("before.txt"), "before\n").unwrap();
    fs::write(repo.join("after.txt"), "after\n").unwrap();
    let external = transport::request(
        &data,
        "review_create",
        &json!({"repo":repo,"provider":"fixture","left":"before","right":"after"}),
        false,
    )
    .unwrap();
    let snapshots = transport::request(
        &data,
        "comparison_list",
        &json!({"reviewId":external["id"]}),
        true,
    )
    .unwrap();
    assert_eq!(snapshots[0]["provider"], "fixture");
    let cs = transport::request(&data, "comparison_list", &p, true).unwrap();
    transport::request(&data,"comment_save",&json!({"reviewId":review["id"],"comparisonId":cs[0]["id"],"path":"file.txt","side":"right","startLine":1,"endLine":1,"body":"Agent can read me"}),true).unwrap();
    transport::request(&data, "review_complete", &p, true).unwrap();
    let response = call("tools/call", json!({"name":"review_result","arguments":p}));
    let result: Value =
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(result["result"]["comments"][0]["body"], "Agent can read me");
    drop(input);
    let _ = child.kill();
    let _ = child.wait();
    // Simultaneous entry points reuse the service instead of replacing its credentials.
    let second = Command::new(exe)
        .arg("serve")
        .env("VIVIDIFF_DATA_DIR", &data)
        .output()
        .unwrap();
    assert!(second.status.success());
    let still: Value =
        serde_json::from_slice(&fs::read(data.join("service.json")).unwrap()).unwrap();
    assert_eq!(still["token"], info["token"]);
    // Restarting the service preserves completed feedback and changes ephemeral credentials.
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(cmd.spawn().unwrap());
    for _ in 0..100 {
        if transport::request(&data, "health", &json!({}), false).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        transport::request(&data, "review_result", &p, false).unwrap(),
        result
    );
    // Timeout stops waiting, not the review.
    let input_file = tmp.path().join("query.json");
    fs::write(
        &input_file,
        json!({"reviewId":external["id"],"timeoutSeconds":0}).to_string(),
    )
    .unwrap();
    let output = Command::new(exe)
        .args(["wait", "--input"])
        .arg(&input_file)
        .env("VIVIDIFF_DATA_DIR", &data)
        .output()
        .unwrap();
    let timed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(timed["timedOut"], true);
    assert_eq!(
        transport::request(
            &data,
            "review_status",
            &json!({"reviewId":external["id"]}),
            false
        )
        .unwrap()["status"],
        "in_progress"
    );
    drop(server);
}
