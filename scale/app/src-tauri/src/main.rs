// LabourLink Scale display shell. Deliberately thin: one full-screen,
// undecorated window showing the React UI, which talks only to the local
// labourlink-scaled service on 127.0.0.1. No Tauri commands or plugins are
// exposed to the page; the weighing keeps running in the service even if
// this window is closed or crashes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LabourLink Scale");
}
