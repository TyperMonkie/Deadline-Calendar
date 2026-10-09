#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:ddl-calendar.db", vec![])
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running DDL Calendar");
}
