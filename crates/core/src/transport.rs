use crate::{process, store::Store};
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

pub fn serve(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("service.lock"))?;
    if lock.try_lock_exclusive().is_err() {
        return Ok(());
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("{e}"))?;
    let addr = server.server_addr().to_ip().context("SERVICE_START")?;
    let token = crate::id();
    let desktop_token = crate::id();
    fs::write(dir.join("service.json"),json!({"port":addr.port(),"token":token,"desktopToken":desktop_token,"pid":std::process::id()}).to_string())?;
    let store = Arc::new(Mutex::new(Store::open(dir)?));
    for mut request in server.incoming_requests() {
        let store = store.clone();
        let token = token.clone();
        let desktop_token = desktop_token.clone();
        let dir = dir.to_path_buf();
        std::thread::spawn(move || {
            let authorization = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.as_str())
                .unwrap_or("");
            let desktop = authorization == format!("Bearer {desktop_token}");
            let valid = desktop || authorization == format!("Bearer {token}");
            let origin = request.headers().iter().any(|h| h.field.equiv("Origin"));
            if !valid
                || origin
                || request.method() != &tiny_http::Method::Post
                || request.url() != "/rpc"
            {
                let _ = request.respond(
                    tiny_http::Response::from_string("{\"error\":{\"code\":\"FORBIDDEN\"}}")
                        .with_status_code(403),
                );
                return;
            }
            let result = (|| -> Result<Value> {
                let mut input = Vec::new();
                request
                    .as_reader()
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut input)?;
                if input.len() > 2 * 1024 * 1024 {
                    bail!("RESOURCE_LIMIT: request");
                }
                let req: Value = serde_json::from_slice(&input)?;
                let method = crate::string(&req, "method")?;
                let p = &req["params"];
                if method == "health" {
                    return Ok(json!({"version":"0.1.0","schemaVersion":1}));
                }
                if method == "review_open" {
                    let review = crate::string(p, "reviewId")?;
                    store.lock().unwrap().dispatch("review_get", p, false)?;
                    fs::write(dir.join("open-review"), review)?;
                    let path = dir.join("desktop-path");
                    if path.exists() {
                        let exe = fs::read_to_string(path)?;
                        let mut c = Command::new(exe.trim());
                        c.arg("--review").arg(review);
                        process::hidden(&mut c);
                        c.spawn()?;
                        return Ok(json!({"opened":true,"reviewId":review}));
                    }
                    return Ok(
                        json!({"opened":false,"reviewId":review,"reason":"DESKTOP_NOT_REGISTERED"}),
                    );
                }
                if method == "desktop_pending" && desktop {
                    let p = dir.join("open-review");
                    let review = fs::read_to_string(&p).ok();
                    if review.is_some() {
                        let _ = fs::remove_file(p);
                    }
                    return Ok(json!({"reviewId":review}));
                }
                store.lock().unwrap().dispatch(method, p, desktop)
            })();
            let response = match result {
                Ok(v) => json!({"result":v}),
                Err(e) => json!({"error":crate::error(&e)}),
            };
            let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
            let _ = request.respond(
                tiny_http::Response::from_string(response.to_string()).with_header(header),
            );
        });
    }
    Ok(())
}
fn descriptor(dir: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(
        dir.join("service.json"),
    )?)?)
}
pub fn request(dir: &Path, method: &str, p: &Value, desktop: bool) -> Result<Value> {
    let info = descriptor(dir)?;
    let port = info["port"].as_u64().context("SERVICE_UNAVAILABLE")?;
    let token = crate::string(&info, if desktop { "desktopToken" } else { "token" })?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(150))
        .build()?;
    let response: Value = client
        .post(format!("http://127.0.0.1:{port}/rpc"))
        .bearer_auth(token)
        .json(&json!({"method":method,"params":p}))
        .send()?
        .error_for_status()?
        .json()?;
    if let Some(e) = response.get("error") {
        bail!(
            "{}: {}",
            e["code"].as_str().unwrap_or("INTERNAL"),
            e["message"].as_str().unwrap_or("")
        );
    }
    Ok(response["result"].clone())
}
pub fn ensure(dir: &Path, executable: &Path) -> Result<()> {
    if request(dir, "health", &json!({}), false).is_ok() {
        return Ok(());
    }
    let mut c = Command::new(executable);
    c.arg("serve")
        .env("VIVIDIFF_DATA_DIR", dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    process::hidden(&mut c);
    c.spawn()?;
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(100));
        if request(dir, "health", &json!({}), false).is_ok() {
            return Ok(());
        }
    }
    bail!("SERVICE_UNAVAILABLE: timed out starting local service")
}
pub fn sidecar() -> Result<PathBuf> {
    let current = std::env::current_exe()?;
    let name = if cfg!(windows) {
        "vividiff-cli.exe"
    } else {
        "vividiff-cli"
    };
    let nearby = current.parent().unwrap().join(name);
    if nearby.exists() {
        return Ok(nearby);
    }
    bail!("SIDECAR_NOT_FOUND: {}", nearby.display())
}
