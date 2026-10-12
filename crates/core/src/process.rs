use anyhow::{bail, Context, Result};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;

pub fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
}
pub fn run(mut cmd: Command, input: Option<Vec<u8>>, timeout: u64) -> Result<Vec<u8>> {
    hidden(&mut cmd);
    let started = Instant::now();
    let budget = Duration::from_secs(timeout);
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("PROCESS_START")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (out_tx, out) = mpsc::channel();
    let (err_tx, err) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let result = stdout
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut b)
            .map(|_| b);
        let _ = out_tx.send(result);
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let result = stderr.take(1024 * 1024).read_to_end(&mut b).map(|_| b);
        let _ = err_tx.send(result);
    });
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(data) = input {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            });
        }
    }
    let status = match child.wait_timeout(Duration::from_secs(timeout))? {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("TIMEOUT: process exceeded {timeout}s");
        }
    };
    // A plugin descendant may retain inherited pipes after its parent exits.
    // The overall request deadline must also bound pipe draining.
    let bytes = out
        .recv_timeout(budget.saturating_sub(started.elapsed()))
        .context("TIMEOUT: stdout did not close")??;
    let errors = err
        .recv_timeout(budget.saturating_sub(started.elapsed()))
        .context("TIMEOUT: stderr did not close")??;
    if !status.success() {
        bail!("PROCESS_FAILED: {}", String::from_utf8_lossy(&errors));
    }
    if bytes.len() > 64 * 1024 * 1024 {
        bail!("RESOURCE_LIMIT: process output exceeds 64 MiB");
    }
    Ok(bytes)
}
