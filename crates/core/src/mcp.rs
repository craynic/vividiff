use crate::transport;
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
};
pub fn handle(dir: &Path, request: &Value) -> Value {
    let id = request["id"].clone();
    let result = (|| -> Result<Value> {
        match request["method"].as_str().unwrap_or("") {
            "initialize" => Ok(
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"vividiff","version":"0.1.0"}}),
            ),
            "ping" => Ok(json!({})),
            "tools/list" => {
                let tools:Vec<Value>=[
                    ("review_create","Create a local read-only diff review. VCS writes are never supported."),
                    ("review_open","Open the desktop UI for an existing review."),
                    ("review_status","Read review state and latest completed submission sequence."),
                    ("review_comments","Read draft comments with original snapshot anchors; use result for completed feedback."),
                    ("review_result","Read an immutable completed submission. available=false means not yet submitted.")
                ].into_iter().map(|(name,description)|{
                    let properties=if name=="review_create" {
                        json!({"repo":{"type":"string"},"provider":{"type":"string","default":"git"},"source":{"type":"string","enum":["vcs","files"]},"left":{"type":"string"},"right":{"type":"string"},"mode":{"type":"string","enum":["direct","merge-base"]},"title":{"type":"string"},"description":{"type":"string"},"idempotencyKey":{"type":"string"},"open":{"type":"boolean","default":true}})
                    }else{json!({"reviewId":{"type":"string"},"sequence":{"type":"integer","minimum":1},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500},"status":{"type":"string","enum":["open","resolved"]}})};
                    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":if name=="review_create"{vec![]}else{vec!["reviewId"]},"additionalProperties":false}})
                }).collect();
                Ok(json!({"tools":tools}))
            }
            "tools/call" => {
                let name = crate::string(&request["params"], "name")?;
                if ![
                    "review_create",
                    "review_open",
                    "review_status",
                    "review_comments",
                    "review_result",
                ]
                .contains(&name)
                {
                    anyhow::bail!("METHOD_NOT_FOUND: {name}");
                }
                let args = &request["params"]["arguments"];
                let response = transport::request(dir, name, args, false);
                let (value, is_error) = match response {
                    Ok(mut v) => {
                        if name == "review_create" && args["open"] != false {
                            let opened = transport::request(
                                dir,
                                "review_open",
                                &json!({"reviewId":v["id"]}),
                                false,
                            );
                            v["desktop"] = opened.unwrap_or_else(
                                |e| json!({"opened":false,"error":crate::error(&e)}),
                            );
                        }
                        (v, false)
                    }
                    Err(e) => (crate::error(&e), true),
                };
                Ok(json!({"content":[{"type":"text","text":value.to_string()}],"isError":is_error}))
            }
            _ => anyhow::bail!("METHOD_NOT_FOUND"),
        }
    })();
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":e.to_string()}}),
    }
}
pub fn serve(dir: &Path) -> Result<()> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.len() > 2 * 1024 * 1024 {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                writeln!(
                    out,
                    "{}",
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})
                )?;
                out.flush()?;
                continue;
            }
        };
        if request.get("id").is_none() {
            continue;
        }
        writeln!(out, "{}", handle(dir, &request))?;
        out.flush()?;
    }
    Ok(())
}
