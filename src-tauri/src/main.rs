// Stops an extra console window from popping up on Windows release builds - please don't remove this!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    minibee_viewer_lib::run()
}
