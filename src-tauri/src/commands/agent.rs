//! Tauri command wrappers for CLI agent detection.
//!
//! The command surface includes:
//! - [`detect_agent`] — legacy boolean probe (kept for back-compat).
//! - [`detect_cli_catalog`] — bulk probe that captures version, path AND the
//!   resolution tier for every catalog entry.
//! - [`inspect_cli_launch`] — the same answer for a single command.
//! - [`cli_launch_diagnostics`] — a redacted, pasteable summary of all of it.
//! - [`inspect_packetcode_installation`] — compares the official installer
//!   target with the exact binary selected for new Workspace panes.
//!
//! Every one of these resolves through `core::agent::resolve_cli_launch`, the
//! same tier order `commands::pty` uses to spawn a pane. That is deliberate:
//! two implementations of one ladder drift, and a readout that disagrees with
//! what actually launches is worse than no readout at all.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use crate::core::agent;

/// One entry of a bulk detection request.
///
/// Frontend passes the catalog id (e.g. "claude-code") alongside the
/// binary name to look up on PATH (e.g. "claude"). Keeping both lets the
/// caller correlate results regardless of binary name collisions.
///
/// `manual_path` is the v0.8.7 manual-override hook: when set, detection
/// skips PATH lookup entirely and probes the supplied absolute path
/// directly. Useful for in-development CLIs (e.g. PacketCode) and bespoke
/// install locations the user has Browse-selected.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectCatalogItem {
    pub id: String,
    pub binary: String,
    #[serde(default)]
    pub manual_path: Option<String>,
}

/// Result for a single catalog entry.
///
/// `source` is the resolution tier that chose `path` — the same tier the PTY
/// launcher used, because both go through `core::agent::resolve_cli_launch*`.
/// Reporting it is the point: without it a user can see WHICH binary a pane
/// will spawn but never WHY, and cannot tell a Settings override from a PATH
/// hit from a binary found in a product's own install directory.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectCatalogResult {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: Option<String>,
}

/// Launch resolution for a single command, for surfaces that ask about one CLI
/// (a Workspace pane header) rather than sweeping the catalog.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliLaunchInspection {
    pub command: String,
    pub path: String,
    pub source: String,
    /// False when resolution fell through to the bare command name — i.e.
    /// nothing spawnable was found and the pane will fail loudly.
    pub resolved: bool,
    pub version: Option<String>,
    /// A configured Settings path that is missing or not executable.
    pub rejected_settings_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketCodeProviderSummary {
    pub configured: usize,
    pub ready: usize,
    pub warning: usize,
    pub failed: usize,
}

#[derive(Debug, Deserialize)]
struct PacketCodeDoctorReport {
    schema_version: u32,
    status: String,
    effective_home: Option<String>,
    home_source: Option<String>,
    provider_summary: PacketCodeProviderSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketCodeIntegrationProbe {
    pub healthy: bool,
    pub executable_path: String,
    pub version: String,
    pub exit_code: Option<i32>,
    pub schema_version: u32,
    pub doctor_status: String,
    pub effective_home: Option<String>,
    pub home_source: Option<String>,
    pub provider_summary: PacketCodeProviderSummary,
    pub doctor: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketCodeInstallationInspection {
    pub installer_executable_path: String,
    pub installer_version: Option<String>,
    pub active_executable_path: Option<String>,
    pub active_version: Option<String>,
    pub active_source: Option<String>,
    pub workspace_uses_installer: bool,
}

fn same_executable_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

/// Legacy boolean detection. Skips the version probe (back-compat callers
/// only care about the boolean) so it stays as cheap as the original
/// `where`/`which` check — never blocks on a hung `--version`.
#[tauri::command]
pub fn detect_agent(command: String) -> Result<bool, String> {
    Ok(agent::detect_agent(&command))
}

/// Bulk-detect a catalog of CLIs. Each entry's probe runs concurrently
/// (PATH lookup + version probe both async, no blocking the runtime);
/// version probes have a 3-second budget, PATH probes a 10-second budget,
/// so a hung binary cannot stall the whole sweep.
#[tauri::command]
pub async fn detect_cli_catalog(
    items: Vec<DetectCatalogItem>,
) -> Result<Vec<DetectCatalogResult>, String> {
    let futures = items
        .into_iter()
        .map(|item| async move { detect_one(item).await });
    Ok(futures::future::join_all(futures).await)
}

/// Detect one catalog entry through the SHARED launch resolver, so the card's
/// path is the path a Workspace pane would spawn.
async fn detect_one(item: DetectCatalogItem) -> DetectCatalogResult {
    if cfg!(windows)
        && crate::core::cli_registry::presets()
            .iter()
            .any(|preset| preset.id == item.id && preset.windows_runtime.as_deref() == Some("wsl"))
    {
        let command = item.manual_path.as_deref().unwrap_or(&item.binary);
        let probe = crate::core::cli_wsl::probe(command).await;
        return DetectCatalogResult {
            id: item.id,
            installed: probe.path.is_some(),
            version: probe.version,
            path: probe.path.or(item.manual_path),
            source: Some("wsl".into()),
        };
    }
    // `git-bash` is a terminal SHELL profile (see `useTerminalShellDetection`),
    // not a CLI agent, and its discovery genuinely differs: `where bash` can
    // resolve the legacy WSL launcher in System32, so the profile must prefer
    // Git for Windows' own install directories. Running it through the agent
    // ladder — where install directories come LAST — would flip the Git Bash
    // profile to "available" while pointing at WSL. `commands::pty` mirrors
    // this same exception on the launch side.
    if item.id == "git-bash" {
        let path = agent::resolve_catalog_path(&item.id, &item.binary).await;
        let version = match path.as_deref() {
            Some(path) => agent::probe_version_at(path).await,
            None => None,
        };
        return DetectCatalogResult {
            id: item.id,
            installed: path.is_some(),
            version,
            // No tier reported: this resolution did not come from the shared
            // ladder, and inventing a tier name for it would be exactly the
            // dishonest readout this work exists to remove. The Terminal Shell
            // settings surface does not render tiers.
            source: None,
            path,
        };
    }

    let spec = agent::CliLaunchSpec::new(&item.binary, item.manual_path.as_deref());
    let resolved = agent::resolve_cli_launch(&spec).await;

    // A Browse-pinned path that isn't there is reported back verbatim with
    // `installed: false` so the card can highlight the bad value, rather than
    // silently showing whatever PATH would have produced instead.
    if let Some(rejected) = resolved.rejected_settings_path {
        return DetectCatalogResult {
            id: item.id,
            installed: false,
            version: None,
            path: Some(rejected),
            source: Some(agent::CliLaunchSource::Settings.as_str().to_string()),
        };
    }

    if !resolved.is_resolved() {
        return DetectCatalogResult {
            id: item.id,
            installed: false,
            version: None,
            path: None,
            source: None,
        };
    }

    // Probe the *resolved* absolute path rather than the bare binary name. On
    // Windows the resolver returns the full `.cmd` wrapper (e.g.
    // `C:\Users\…\AppData\Roaming\npm\claude.cmd`), but `probe_version` would
    // re-invoke just `claude`, which `TokioCommand::new` resolves differently
    // than the shell would — yielding `None` and a card that reads
    // "installed, no version". On POSIX it is a no-op difference.
    let version = agent::probe_version_at(&resolved.path).await;
    let installed = if item.id == "packetcode" {
        // PacketCode's version contract is deliberately stricter: a binary is
        // not PacketCode merely because it prints something for `--version`.
        version.as_deref().is_some_and(agent::is_packetcode_version)
    } else if resolved.source == agent::CliLaunchSource::Settings {
        // A user-pinned binary has to actually respond; nothing else vouched
        // for it.
        version.is_some()
    } else {
        true
    };

    DetectCatalogResult {
        id: item.id,
        installed,
        version,
        path: Some(resolved.path),
        source: Some(resolved.source.as_str().to_string()),
    }
}

/// Resolve one CLI command the way a PTY pane would, and report the tier that
/// chose it. Backs the Workspace pane's launch-binary readout.
#[tauri::command]
pub async fn inspect_cli_launch(
    command: String,
    manual_path: Option<String>,
) -> Result<CliLaunchInspection, String> {
    if crate::core::cli_registry::uses_wsl(&command) {
        let probe = crate::core::cli_wsl::probe(manual_path.as_deref().unwrap_or(&command)).await;
        let resolved = probe.path.is_some();
        return Ok(CliLaunchInspection {
            path: probe.path.unwrap_or_else(|| command.clone()),
            command,
            source: "wsl".into(),
            resolved,
            version: probe.version,
            rejected_settings_path: if resolved { None } else { manual_path },
        });
    }
    let spec = agent::CliLaunchSpec::new(&command, manual_path.as_deref());
    let resolved = agent::resolve_cli_launch(&spec).await;
    let version = if resolved.is_resolved() {
        agent::probe_version_at(&resolved.path).await
    } else {
        None
    };
    Ok(CliLaunchInspection {
        command,
        source: resolved.source.as_str().to_string(),
        resolved: resolved.is_resolved(),
        path: resolved.path,
        version,
        rejected_settings_path: resolved.rejected_settings_path,
    })
}

/// Build a redacted, copy-to-clipboard diagnostics block naming, per CLI, the
/// binary a pane would launch and the tier that chose it.
///
/// Safe to paste into an issue **by construction**: the only values that reach
/// the output are the catalog id, the resolved path, the resolution tier and
/// the `--version` line. No API keys, no tokens, no environment dump — nothing
/// is read from the process environment except the host OS name, which is
/// needed to read the paths at all. Home directories are abbreviated to `~`
/// because they carry the user's real name and the tier already says where the
/// binary came from; the rest of every path is kept verbatim, since a custom
/// install directory is exactly what a bug report needs.
#[tauri::command]
pub async fn cli_launch_diagnostics(items: Vec<DetectCatalogItem>) -> Result<String, String> {
    let home = dirs::home_dir();
    let results = detect_cli_catalog(items).await?;
    Ok(render_cli_diagnostics(
        std::env::consts::OS,
        &results,
        home.as_deref(),
    ))
}

/// [`cli_launch_diagnostics`]'s formatting as a pure function, so the redaction
/// and the "nothing but these four fields" guarantee are testable.
fn render_cli_diagnostics(
    platform: &str,
    results: &[DetectCatalogResult],
    home: Option<&Path>,
) -> String {
    let mut out = String::from("PacketBench CLI launch resolution\n");
    out.push_str(&format!("platform: {platform}\n\n"));
    for result in results {
        let path = result
            .path
            .as_deref()
            .map(|path| agent::redact_home_in_path(path, home))
            .unwrap_or_else(|| "(not found)".to_string());
        out.push_str(&format!(
            "{} | {} | tier={} | version={}\n",
            result.id,
            path,
            result.source.as_deref().unwrap_or("unresolved"),
            result.version.as_deref().unwrap_or("unknown"),
        ));
    }
    out
}

/// Inspect both sides of an install/update transaction: the official
/// installer's deterministic destination and the resolver-selected binary a
/// new local Workspace pane would launch. They can differ when a Settings
/// override, legacy pin, or earlier PATH entry takes precedence.
#[tauri::command]
pub async fn inspect_packetcode_installation(
    manual_path: Option<String>,
) -> Result<PacketCodeInstallationInspection, String> {
    let installer_path = agent::packetcode_installer_target().ok_or_else(|| {
        "PacketCode's official installer destination is unavailable on this host".to_string()
    })?;
    let installer_path_string = installer_path.to_string_lossy().to_string();
    let installer_version = if agent::is_executable_file(&installer_path_string) {
        agent::probe_version_at(&installer_path_string)
            .await
            .filter(|version| agent::is_packetcode_version(version))
    } else {
        None
    };

    let active = agent::resolve_packetcode_launch(manual_path.as_deref())
        .await
        .ok();
    let workspace_uses_installer = active
        .as_ref()
        .is_some_and(|resolved| same_executable_path(Path::new(&resolved.path), &installer_path));
    let active_version = if workspace_uses_installer {
        installer_version.clone()
    } else if let Some(resolved) = active.as_ref() {
        agent::probe_version_at(&resolved.path)
            .await
            .filter(|version| agent::is_packetcode_version(version))
    } else {
        None
    };

    Ok(PacketCodeInstallationInspection {
        installer_executable_path: installer_path_string,
        installer_version,
        active_executable_path: active.as_ref().map(|resolved| resolved.path.clone()),
        active_version,
        active_source: active.map(|resolved| resolved.source.as_str().to_string()),
        workspace_uses_installer,
    })
}

/// Verify the complete PacketBench ↔ PacketCode integration contract:
/// executable identity, version handshake, isolated data home, and the
/// machine-readable doctor report. The doctor JSON is returned even when its
/// own status is `fail`, allowing the UI to present actionable findings.
#[tauri::command]
pub async fn probe_packetcode_integration(
    manual_path: Option<String>,
    data_home: Option<String>,
) -> Result<PacketCodeIntegrationProbe, String> {
    let executable_path = agent::resolve_packetcode_launch_path(manual_path.as_deref()).await?;

    let version = agent::probe_version_at(&executable_path)
        .await
        .filter(|version| agent::is_packetcode_version(version))
        .ok_or_else(|| {
            format!(
                "{} did not satisfy the PacketCode --version contract",
                executable_path
            )
        })?;

    let data_home = data_home
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(home) = data_home.as_deref() {
        if !Path::new(home).is_absolute() {
            return Err(format!(
                "PACKETCODE_HOME must be an absolute path: {}",
                home
            ));
        }
    }

    let mut command = TokioCommand::new(&executable_path);
    command.args(["doctor", "--json"]);
    if let Some(home) = data_home.as_deref() {
        command.env("PACKETCODE_HOME", home);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start PacketCode doctor: {}", error))?;
    let output = timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "PacketCode doctor timed out after 15 seconds".to_string())?
        .map_err(|error| format!("PacketCode doctor failed: {}", error))?;
    if output.stdout.len() > crate::commands::MAX_INPUT_SIZE {
        return Err("PacketCode doctor output exceeded the 1 MB safety limit".to_string());
    }

    let doctor_value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail: String = stderr.chars().take(500).collect();
            format!(
                "PacketCode doctor returned invalid JSON: {}{}",
                error,
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(" ({})", detail.trim())
                }
            )
        })?;
    let doctor: PacketCodeDoctorReport =
        serde_json::from_value(doctor_value.clone()).map_err(|error| {
            format!(
                "PacketCode doctor JSON is missing required integration fields: {}",
                error
            )
        })?;
    let healthy = output.status.success() && doctor.status != "fail";

    Ok(PacketCodeIntegrationProbe {
        healthy,
        executable_path,
        version,
        exit_code: output.status.code(),
        schema_version: doctor.schema_version,
        doctor_status: doctor.status,
        effective_home: doctor.effective_home,
        home_source: doctor.home_source,
        provider_summary: doctor.provider_summary,
        doctor: doctor_value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packetcode_doctor_contract_deserializes_additive_schema_one_report() {
        let report: PacketCodeDoctorReport = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "status": "warn",
            "effective_home": "C:\\PacketCodeData",
            "home_source": "environment",
            "provider_summary": {
                "configured": 2,
                "ready": 1,
                "warning": 1,
                "failed": 0
            },
            "checks": []
        }))
        .expect("doctor contract");
        assert_eq!(report.schema_version, 1);
        assert_eq!(report.provider_summary.ready, 1);
    }

    fn result(id: &str, path: Option<&str>, source: Option<&str>) -> DetectCatalogResult {
        DetectCatalogResult {
            id: id.to_string(),
            installed: path.is_some(),
            version: Some("1.2.3".to_string()),
            path: path.map(str::to_string),
            source: source.map(str::to_string),
        }
    }

    #[test]
    fn diagnostics_report_the_tier_and_abbreviate_the_home_directory() {
        let home = std::path::Path::new(if cfg!(windows) {
            r"C:\Users\ian"
        } else {
            "/home/ian"
        });
        let claude = if cfg!(windows) {
            r"C:\Users\ian\AppData\Roaming\npm\claude.cmd"
        } else {
            "/home/ian/.local/bin/claude"
        };
        let rendered = render_cli_diagnostics(
            "testos",
            &[
                result("claude-code", Some(claude), Some("path")),
                result("codex", None, None),
            ],
            Some(home),
        );

        assert!(rendered.contains("platform: testos"));
        assert!(rendered.contains("tier=path"));
        assert!(rendered.contains("version=1.2.3"));
        assert!(rendered.contains("codex | (not found) | tier=unresolved"));
        // The home directory carries the user's name; the tier already says
        // where the binary came from.
        assert!(!rendered.contains("ian"), "{rendered}");
        assert!(rendered.contains("~"));
    }

    /// The export is safe to paste by construction: nothing but id, path, tier
    /// and version can reach it. This pins the shape so a later "just add the
    /// env for context" edit has to argue with a test.
    #[test]
    fn diagnostics_carry_no_fields_beyond_the_documented_four() {
        let rendered = render_cli_diagnostics(
            "testos",
            &[result("claude-code", Some("/opt/claude"), Some("settings"))],
            None,
        );
        let line = rendered
            .lines()
            .find(|line| line.starts_with("claude-code"))
            .expect("entry line");
        let fields: Vec<&str> = line.split(" | ").collect();
        assert_eq!(
            fields,
            vec![
                "claude-code",
                "/opt/claude",
                "tier=settings",
                "version=1.2.3"
            ]
        );
    }

    /// The reporting command and the PTY launcher must name the same binary.
    /// `detect_one` is what feeds the Tools card; `resolve_cli_launch_sync` is
    /// what `commands::pty` spawns.
    #[tokio::test]
    async fn catalog_detection_names_the_binary_the_pty_would_spawn() {
        for binary in ["claude", "codex", "opencode", "packetcode"] {
            let reported = detect_one(DetectCatalogItem {
                id: binary.to_string(),
                binary: binary.to_string(),
                manual_path: None,
            })
            .await;
            let launched =
                agent::resolve_cli_launch_sync(&agent::CliLaunchSpec::from_command(binary));

            match reported.path {
                Some(path) => {
                    // The user-visible contract, and deterministic: whatever
                    // the card names is what the pane spawns.
                    assert_eq!(path, launched.path, "{binary}");

                    // The TIER label is only deterministic when the resolved
                    // file is reachable by exactly one tier.
                    //
                    // These two resolutions probe `where` differently on
                    // purpose: the async reporting path bounds it at
                    // PATH_PROBE_TIMEOUT so a hung `where` cannot stall the
                    // catalog sweep, while the sync launcher path does not.
                    // On a loaded machine the async probe can time out and
                    // fall through to the install-directory tier while the
                    // sync one still gets a PATH hit — landing on the SAME
                    // file, because npm's global bin is both on PATH and the
                    // documented install location. Asserting tier equality
                    // there fails on machine load rather than on a defect.
                    let reachable_two_ways = agent::install_dir_candidates(binary)
                        .iter()
                        .any(|candidate| same_executable_path(candidate, Path::new(&path)));
                    if !reachable_two_ways {
                        assert_eq!(
                            reported.source.as_deref(),
                            Some(launched.source.as_str()),
                            "{binary} is reachable by one tier only, so the label must agree"
                        );
                    }
                }
                None => assert!(
                    !launched.is_resolved(),
                    "{binary} reported as unresolved but the launcher picked {}",
                    launched.path
                ),
            }
        }
    }
}
