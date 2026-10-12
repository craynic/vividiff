#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::Value;
use tauri::Manager;
#[tauri::command]
async fn rpc(method: String, params: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = vividiff_core::data_dir().map_err(|e| e.to_string())?;
        vividiff_core::transport::request(&dir, &method, &params, true).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(i) = args.iter().position(|s| s == "--review") {
                if let Some(id) = args.get(i + 1) {
                    if let Ok(dir) = vividiff_core::data_dir() {
                        let _ = std::fs::write(dir.join("open-review"), id);
                    }
                }
            }
        }))
        .setup(|_| {
            let dir = vividiff_core::data_dir()?;
            std::fs::write(
                dir.join("desktop-path"),
                std::env::current_exe()?.to_string_lossy().as_bytes(),
            )?;
            vividiff_core::transport::ensure(&dir, &vividiff_core::transport::sidecar()?)?;
            let args: Vec<String> = std::env::args().collect();
            if let Some(i) = args.iter().position(|s| s == "--review") {
                if let Some(id) = args.get(i + 1) {
                    std::fs::write(dir.join("open-review"), id)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("vividiff desktop startup failed");
}
