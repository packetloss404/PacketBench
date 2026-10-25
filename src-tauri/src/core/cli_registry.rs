//! Workspace terminal presets shared with the frontend, embedded at build time.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
pub struct CliPreset {
    pub id: String,
    pub binary: String,
    #[serde(default, rename = "discovery")]
    pub discovery: Vec<String>,
    #[serde(default, rename = "windowsRuntime")]
    pub windows_runtime: Option<String>,
    #[serde(default, rename = "versionArgument")]
    pub version_argument: Option<String>,
}

pub fn presets() -> &'static [CliPreset] {
    static PRESETS: OnceLock<Vec<CliPreset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/workspace-cli-registry.json"))
            .expect("bundled Workspace CLI registry must be valid")
    })
}

pub fn is_preset_command(program: &str) -> bool {
    presets().iter().any(|preset| preset.binary == program)
}

pub fn wsl_preset(command: &str) -> Option<&'static CliPreset> {
    let program = super::agent::command_program_name(command);
    presets()
        .iter()
        .find(|preset| preset.binary == program && preset.windows_runtime.as_deref() == Some("wsl"))
}

pub fn uses_wsl(command: &str) -> bool {
    cfg!(windows) && wsl_preset(command).is_some()
}

pub fn discovery(program: &str) -> &'static [String] {
    presets()
        .iter()
        .find(|preset| preset.binary == program)
        .map(|preset| preset.discovery.as_slice())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_unique_ids_and_interactive_commands() {
        let mut ids = std::collections::HashSet::new();
        for preset in presets() {
            assert!(ids.insert(&preset.id));
            assert!(is_preset_command(&preset.binary));
        }
        assert!(is_preset_command("copilot"));
        assert!(is_preset_command("agy"));
        assert!(!is_preset_command("gh-copilot"));
    }
}
