use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use vividiff_core::{git, mcp, transport};
fn main() {
    if let Err(e) = run() {
        eprintln!("{}", vividiff_core::error(&e));
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    if cmd == "git-plugin" {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        let r: Value = serde_json::from_str(&line)?;
        let result = git::dispatch(r["method"].as_str().unwrap_or(""), &r["params"]);
        let response = match result {
            Ok(v) => json!({"jsonrpc":"2.0","id":r["id"],"result":v}),
            Err(e) => json!({"jsonrpc":"2.0","id":r["id"],"error":vividiff_core::error(&e)}),
        };
        println!("{response}");
        std::io::stdout().flush()?;
        return Ok(());
    }
    if cmd == "help" || cmd == "--help" {
        println!("vividiff-cli 0.1.0\nCommands: create, open, status, comments, result, list, wait, mcp, serve\nPass a JSON object as the second argument (or --input FILE); output is always JSON.\nExample: vividiff-cli create --input review.json --json\nwait accepts timeoutSeconds (default 300). No source/VCS write operations exist.");
        return Ok(());
    }
    let dir = vividiff_core::data_dir()?;
    if cmd == "serve" {
        return transport::serve(&dir);
    }
    transport::ensure(&dir, &std::env::current_exe()?)?;
    if cmd == "mcp" {
        return mcp::serve(&dir);
    }
    let p: Value = if let Some(index) = args.iter().position(|a| a == "--input") {
        serde_json::from_slice(&std::fs::read(
            args.get(index + 1)
                .ok_or_else(|| anyhow::anyhow!("INVALID_ARGUMENT: input path"))?,
        )?)?
    } else {
        serde_json::from_str(
            args.iter()
                .skip(1)
                .find(|a| !a.starts_with("--"))
                .map(String::as_str)
                .unwrap_or("{}"),
        )?
    };
    if cmd == "wait" {
        let start = std::time::Instant::now();
        let timeout = p["timeoutSeconds"].as_u64().unwrap_or(300);
        loop {
            let status = transport::request(&dir, "review_status", &p, false)?;
            if status["status"] == "completed" {
                println!("{}", transport::request(&dir, "review_result", &p, false)?);
                return Ok(());
            }
            if status["status"] == "cancelled" {
                println!("{}", json!({"cancelled":true}));
                return Ok(());
            }
            if start.elapsed().as_secs() >= timeout {
                println!("{}", json!({"timedOut":true,"reviewId":p["reviewId"]}));
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    }
    let method = match cmd {
        "create" => "review_create",
        "open" => "review_open",
        "status" => "review_status",
        "comments" => "review_comments",
        "result" => "review_result",
        "list" => "review_list",
        _ => bail!("UNKNOWN_COMMAND: {cmd}"),
    };
    let mut result = transport::request(&dir, method, &p, false)?;
    if cmd == "create" && p["open"] != false {
        result["desktop"] = transport::request(
            &dir,
            "review_open",
            &json!({"reviewId":result["id"]}),
            false,
        )?;
    }
    println!("{result}");
    Ok(())
}
