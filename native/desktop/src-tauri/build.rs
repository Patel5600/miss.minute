const APP_COMMANDS: &[&str] = &[
    "agent_status",
    "agent_stream_open",
    "agent_events_after",
    "agent_stream_close",
    "agent_enroll",
    "agent_start",
    "agent_stop",
    "agent_recent_decisions",
    "authorize_note_root",
    "revoke_note_root",
    "set_auto_note_creation",
    "pending_actions",
    "approve_action",
    "reject_action",
    "set_startup",
    "get_startup",
    "toggle_avatar",
    "show_dashboard",
    "set_avatar_bounds",
    "set_avatar_dragging",
    "avatar_speak",
];

fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(APP_COMMANDS),
    );

    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("failed to build the Miss Minutes Tauri application manifest: {error}");
    }
}
