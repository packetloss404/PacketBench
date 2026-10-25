use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

/// Budget for one `where`/`which` probe.
///
/// It exists so a hung lookup cannot stall a whole catalog sweep, NOT to hurry
/// a healthy one along — `where.exe` answers in milliseconds when the machine
/// is idle. The old two-second value was tight enough to expire under ordinary
/// load, and expiring is not harmless: the resolver treats "no PATH hit" as a
/// fact and descends to a lower tier, so a busy machine could report a
/// different launch tier — or a bare name against a real binary — than the one
/// the PTY would actually spawn. Reporting and launch disagreeing is precisely
/// what the shared resolver exists to prevent, so the budget is set well clear
/// of contention.
///
/// Known limit: the synchronous launcher probe has no timeout at all, so the
/// two paths still degrade differently in the pathological hung-`where` case.
/// `catalog_detection_names_the_binary_the_pty_would_spawn` documents where
/// that leaves the tier label ambiguous.
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_MAX_LEN: usize = 60;

/// Program name for a command that may already be an absolute path — the key
/// every per-CLI rule (allowlist, app pin, install directory) is stated in
/// terms of. Lowercased so Windows comparisons are case-insensitive.
pub fn command_program_name(command: &str) -> String {
    std::path::Path::new(command)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase()
}

/// Whether a command string is a path rather than a bare program name. A
/// path-shaped command IS the Settings-selected executable: that is how the
/// Workspace hands a Browse-pinned binary to the PTY.
fn looks_like_path(command: &str) -> bool {
    command.contains('/') || command.contains('\\') || std::path::Path::new(command).is_absolute()
}

/// Read PacketBench's legacy app pin for a CLI. Detection, integration probes,
/// and PTY launch all call this one implementation so the pin cannot select a
/// different binary on one surface than another.
pub fn app_pinned_cli_binary_in(home: &std::path::Path, command: &str) -> Option<String> {
    let key = command_program_name(command);
    let pin = home
        .join(crate::core::brand::DATA_DIR_NAME)
        .join(format!("{key}-bin"));
    let contents = std::fs::read_to_string(&pin).ok()?;
    let path = contents.trim();
    if path.is_empty() {
        tracing::warn!(command, pin = %pin.display(), "App pin file is empty; ignoring");
        return None;
    }
    if !is_executable_file(path) {
        tracing::warn!(
            command,
            pin = %pin.display(),
            pinned = path,
            "App-pinned CLI binary is unavailable; falling through to normal resolution"
        );
        return None;
    }
    tracing::info!(command, pinned = path, "Using app-pinned CLI binary");
    Some(path.to_string())
}

pub fn app_pinned_cli_binary(command: &str) -> Option<String> {
    app_pinned_cli_binary_in(&dirs::home_dir()?, command)
}

/// Which tier of [`resolve_cli_launch_with`] chose a CLI's launch binary.
///
/// Reported verbatim to the frontend (`as_str`), so a user can always see WHY
/// a particular executable is the one a pane will spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliLaunchSource {
    Settings,
    LegacyPin,
    Path,
    InstallerLocation,
    /// Nothing resolved. The bare command is handed back so the eventual spawn
    /// fails loudly, naming the program the user actually asked for.
    BareName,
}

impl CliLaunchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::LegacyPin => "legacyPin",
            Self::Path => "path",
            Self::InstallerLocation => "installerLocation",
            Self::BareName => "bareName",
        }
    }
}

/// A CLI launch resolution: the exact binary, and the tier that chose it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCliLaunch {
    pub path: String,
    pub source: CliLaunchSource,
    /// A configured Settings path that was skipped because nothing executable
    /// is there. Reporting surfaces turn this into an error or a highlighted
    /// bad value; the launcher carries on down the remaining tiers so a stale
    /// override cannot brick a pane.
    pub rejected_settings_path: Option<String>,
}

impl ResolvedCliLaunch {
    /// True when a real binary was found. `false` means the bare-name tier.
    pub fn is_resolved(&self) -> bool {
        self.source != CliLaunchSource::BareName
    }
}

/// Everything launch resolution needs to know about one CLI.
#[derive(Debug, Clone)]
pub struct CliLaunchSpec {
    command: String,
    settings_path: Option<String>,
    home: Option<PathBuf>,
}

impl CliLaunchSpec {
    /// A command exactly as the Workspace hands it to the PTY: either a bare
    /// program name (`claude`) or the absolute path a Settings override has
    /// already baked into `AgentConfig.command`.
    pub fn from_command(command: &str) -> Self {
        let settings_path = if looks_like_path(command) {
            Some(command.to_string())
        } else {
            None
        };
        Self {
            command: command.to_string(),
            settings_path,
            home: None,
        }
    }

    /// A catalog binary plus the Settings override held alongside it (the
    /// Browse-for-binary path, or PacketCode's `manual_path`).
    pub fn new(command: &str, settings_path: Option<&str>) -> Self {
        let mut spec = Self::from_command(command);
        if let Some(explicit) = settings_path.map(str::trim).filter(|p| !p.is_empty()) {
            spec.settings_path = Some(explicit.to_string());
        }
        spec
    }

    /// Override the home directory the legacy app pin is read from. Tests use
    /// this so pin behaviour is provable without touching the real home.
    pub fn with_home(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn program(&self) -> String {
        command_program_name(&self.command)
    }
}

/// Documented off-`PATH` install directories for `program`.
///
/// The tier exists because "on `PATH`" is not the same claim as "on the `PATH`
/// this process inherited". A desktop app launched from Explorer or a Start
/// menu shortcut routinely gets a narrower environment than the user's shell,
/// and an agent that is detected but not launchable is the worst outcome: the
/// card offers it and the pane dies on open.
///
/// Each entry is evidence-backed, not a guess:
///
/// - `packetcode` — its installer declines to touch `PATH`; `install.ps1` says
///   so in as many words.
/// - `claude` — Claude Code's native installer targets `~/.local/bin`, which
///   is not on a default Windows `PATH`.
/// - `codex`, `opencode` — npm packages, so npm's documented default global
///   prefix.
///
/// A CLI with no such documented location gets nothing here and falls through
/// to the bare name; `no_cli_resolves_through_another_products_install_directories`
/// pins the rule that every candidate must be named for the CLI that asked.
///
/// Git Bash's `git_bash_fallback_candidates` are deliberately NOT wired in
/// here. `bash` is a terminal shell, not a CLI agent, and its candidates are
/// consulted at a different point on Windows (ahead of `PATH`, because `where
/// bash` can resolve the System32 WSL launcher). Folding it in would silently
/// change which bash launches.
pub fn install_dir_candidates(program: &str) -> Vec<PathBuf> {
    let mut candidates = match program {
        "packetcode" => packetcode_fallback_candidates(),
        "claude" => claude_fallback_candidates(),
        "codex" | "opencode" => npm_global_bin_candidates(program),
        _ => Vec::new(),
    };
    for location in crate::core::cli_registry::discovery(program) {
        if location == "npmGlobal" {
            candidates.extend(npm_global_bin_candidates(program));
        } else if let Some(home) = dirs::home_dir() {
            let bin = match location.as_str() {
                "localBin" => home.join(".local").join("bin"),
                "grokBin" => home.join(".grok").join("bin"),
                _ => continue,
            };
            #[cfg(windows)]
            candidates.extend([
                bin.join(format!("{program}.exe")),
                bin.join(format!("{program}.cmd")),
            ]);
            #[cfg(not(windows))]
            candidates.push(bin.join(program));
        }
    }
    candidates
}

/// Claude Code's installer target.
///
/// Its native installer drops the binary in `~/.local/bin` on every platform
/// and does not edit `PATH` — verified on this machine, where `where claude`
/// only finds it because that directory happens to be on `PATH`
/// (`C:\Users\…\.local\bin\claude.exe`). A GUI app frequently inherits a
/// `PATH` without it, which is exactly the gap this tier closes.
fn claude_fallback_candidates() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let bin = home.join(".local").join("bin");
    #[cfg(target_os = "windows")]
    {
        vec![bin.join("claude.exe"), bin.join("claude.cmd")]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![bin.join("claude")]
    }
}

/// npm's global bin directory, for the CLIs distributed as npm packages.
///
/// npm documents its default prefix as `%APPDATA%\npm` on Windows and
/// `/usr/local` on POSIX, with the binaries in `<prefix>` and `<prefix>/bin`
/// respectively. On Windows only the `.cmd` shim is spawnable — the
/// extensionless sibling is a shell script — so it is the only Windows
/// candidate offered here.
///
/// Deliberately NOT exhaustive: an nvm- or Volta-managed prefix is versioned
/// and unguessable, and inventing paths for it would be the kind of
/// speculative widening this tier is supposed to avoid. Those users are served
/// by `PATH` (tier 3) or by pointing Settings at the binary.
fn npm_global_bin_candidates(program: &str) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(|app_data| {
                vec![PathBuf::from(app_data)
                    .join("npm")
                    .join(format!("{program}.cmd"))]
            })
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut candidates = vec![PathBuf::from("/usr/local/bin").join(program)];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join(program));
        }
        candidates
    }
}

/// The ONE tier order for choosing a CLI's launch binary.
///
/// Both the PTY launcher (`commands::pty`) and every reporting surface
/// (`commands::agent`) go through this function, so a readout can never
/// disagree with what actually spawns. `path_lookup` supplies tier 3 and is
/// called lazily — an earlier tier that wins costs no `where`/`which` probe.
///
/// 1. **Settings** — an explicit executable the user selected. Outranks the
///    legacy hidden pin precisely because it is the visible choice.
/// 2. **LegacyPin** — `~/<DATA_DIR>/<program>-bin`.
/// 3. **Path** — resolved to an ABSOLUTE path. This matters: panes spawn with
///    the project cwd and the PTY layer resolves a relative program against
///    cwd first, so a same-named file or directory there would shadow the real
///    CLI.
/// 4. **InstallerLocation** — the product's own documented install directory,
///    for the CLIs that have one. Deliberately last: an app pin is an explicit
///    override and a `PATH` hit is the user's own environment, and neither
///    should lose to a directory nobody named.
/// 5. **BareName** — hand the command back unchanged and let the spawn fail
///    loudly. Never fabricate an extension: that hides the real executable
///    name behind a misleading "*.cmd not found".
pub fn resolve_cli_launch_with(
    spec: &CliLaunchSpec,
    path_lookup: impl FnOnce(&str) -> Option<String>,
) -> ResolvedCliLaunch {
    let mut rejected_settings_path: Option<String> = None;

    if let Some(settings) = spec.settings_path.as_deref() {
        if is_executable_file(settings) {
            return ResolvedCliLaunch {
                path: settings.to_string(),
                source: CliLaunchSource::Settings,
                rejected_settings_path: None,
            };
        }
        tracing::warn!(
            command = %spec.command,
            settings_path = settings,
            "Settings-selected CLI executable is missing or not executable; continuing down the launch tiers"
        );
        rejected_settings_path = Some(settings.to_string());
    }

    let program = spec.program();
    let finish = |path: String, source: CliLaunchSource| ResolvedCliLaunch {
        path,
        source,
        rejected_settings_path: rejected_settings_path.clone(),
    };

    let pinned = match spec.home.as_deref() {
        Some(home) => app_pinned_cli_binary_in(home, &program),
        None => app_pinned_cli_binary(&program),
    };
    if let Some(pinned) = pinned {
        return finish(pinned, CliLaunchSource::LegacyPin);
    }

    if let Some(hit) = path_lookup(&spec.command) {
        return finish(hit, CliLaunchSource::Path);
    }

    if let Some(installed) = install_dir_candidates(&program)
        .into_iter()
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .find(|candidate| is_executable_file(candidate))
    {
        tracing::info!(
            command = %spec.command,
            resolved = %installed,
            "Using CLI binary from its documented install directory"
        );
        return finish(installed, CliLaunchSource::InstallerLocation);
    }

    finish(spec.command.clone(), CliLaunchSource::BareName)
}

/// [`resolve_cli_launch_with`] as the PTY launcher runs it: synchronous,
/// on the spawn path.
pub fn resolve_cli_launch_sync(spec: &CliLaunchSpec) -> ResolvedCliLaunch {
    resolve_cli_launch_with(spec, path_lookup_sync)
}

/// [`resolve_cli_launch_with`] as the reporting commands run it.
///
/// Tier 3 is the only step that wants to be asynchronous (a catalog sweep fans
/// `where`/`which` out over a dozen entries under a timeout). It is resolved
/// up front — and skipped entirely when tiers 1-2 already decided — then handed
/// to the single ordering implementation above, so this function CANNOT encode
/// a different tier order than the launcher's.
pub async fn resolve_cli_launch(spec: &CliLaunchSpec) -> ResolvedCliLaunch {
    let without_path = resolve_cli_launch_with(spec, |_| None);
    match without_path.source {
        CliLaunchSource::Settings | CliLaunchSource::LegacyPin => without_path,
        _ => {
            let hit = path_lookup_async(spec.command()).await;
            resolve_cli_launch_with(spec, move |_| hit)
        }
    }
}

/// Tier 3, synchronously.
///
/// On POSIX this is a pure `PATH` walk — no subprocess, so nothing can hang.
/// On Windows it is `where.exe` plus [`select_windows_command_candidate`],
/// which is what filters the unspawnable Windows Store Codex package out of
/// the results.
fn path_lookup_sync(command: &str) -> Option<String> {
    #[cfg(windows)]
    {
        select_windows_command_candidate(command, &windows_where_lines_sync(command))
    }
    #[cfg(not(windows))]
    {
        posix_path_lookup(command)
    }
}

/// Tier 3, asynchronously. Selection rules are identical to
/// [`path_lookup_sync`] — on POSIX it is literally the same function, and on
/// Windows both feed the same candidate selector; only the probe's timeout
/// guard differs.
async fn path_lookup_async(command: &str) -> Option<String> {
    #[cfg(windows)]
    {
        select_windows_command_candidate(command, &windows_where_lines_async(command).await)
    }
    #[cfg(not(windows))]
    {
        posix_path_lookup(command)
    }
}

#[cfg(not(windows))]
fn posix_path_lookup(command: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(command);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(windows)]
fn parse_where_lines(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

#[cfg(windows)]
fn windows_where_lines_sync(command: &str) -> Vec<String> {
    let mut cmd = std::process::Command::new("where");
    cmd.arg(command);
    crate::core::shared::hide_window(&mut cmd);
    match cmd.output() {
        Ok(output) if output.status.success() => parse_where_lines(&output.stdout),
        _ => Vec::new(),
    }
}

#[cfg(windows)]
async fn windows_where_lines_async(command: &str) -> Vec<String> {
    let mut cmd = TokioCommand::new("where");
    cmd.arg(command);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(child) = cmd.spawn() else {
        return Vec::new();
    };
    match timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => parse_where_lines(&output.stdout),
        _ => Vec::new(),
    }
}

/// Is this `where.exe` hit a packaged-app (MSIX/Store) entry rather than a
/// real executable we can spawn?
///
/// Both shapes live under a `WindowsApps` directory and neither works from a
/// PTY child:
///
/// - `%LOCALAPPDATA%\Microsoft\WindowsApps\<name>.exe` — an app-execution
///   alias. A zero-length reparse point that only the shell resolves; spawning
///   it directly fails with `Access is denied`. This is the form `where`
///   usually prints, and the one the old `\windowsapps\openai.codex_` check
///   MISSED, so a Store-only Codex was handed to the launcher as if valid.
/// - `C:\Program Files\WindowsApps\<Publisher>.<App>_<ver>_<arch>__<id>\…` —
///   the package payload itself, ACL'd against ordinary processes.
///
/// Matching on the directory rather than on a publisher name generalises past
/// Codex, which matters: this machine has a `WindowsApps\bash.exe` WSL alias,
/// and `bash` is on the PTY allowlist.
#[cfg(windows)]
fn is_packaged_app_alias(candidate_lower: &str) -> bool {
    candidate_lower.contains("\\windowsapps\\")
}

/// Select a spawnable Windows command candidate from `where.exe` output.
///
/// Packaged-app entries are dropped outright rather than ranked last. Returning
/// `None` is the useful answer: it lets the later tiers — the product's
/// documented install directory, then the bare name — get their turn. Handing
/// back an alias that is guaranteed to fail with `Access is denied` would
/// instead end resolution on a binary that cannot run.
///
/// Codex keeps one extra rule. npm installs three siblings next to each other
/// (`codex`, `codex.cmd`, `codex.ps1`) and only the `.cmd` is spawnable by
/// Windows; `where` lists the extensionless shell shim FIRST, so preferring
/// `.exe`-then-`.cmd` like the general case would pick a file Windows cannot
/// execute. Verified against the real layout on this machine.
///
/// Lives here, next to the tier order, because BOTH the launcher and the
/// reporting sweep must apply the same rule — otherwise the card could name a
/// binary the pane would refuse to spawn.
#[cfg(windows)]
pub fn select_windows_command_candidate<S: AsRef<str>>(
    command: &str,
    lines: &[S],
) -> Option<String> {
    let requested = command.to_ascii_lowercase();
    let is_codex = std::path::Path::new(&requested)
        .file_stem()
        .and_then(|stem| stem.to_str())
        == Some("codex");

    // One filtered view, applied to every branch below, so no lookup path can
    // accidentally reintroduce an unspawnable alias.
    let spawnable: Vec<&S> = lines
        .iter()
        .filter(|line| !is_packaged_app_alias(&line.as_ref().to_ascii_lowercase()))
        .collect();
    let lower = |line: &&&S| line.as_ref().to_ascii_lowercase();

    if is_codex {
        if let Some(cmd_file) = spawnable.iter().find(|line| lower(line).ends_with(".cmd")) {
            return Some(cmd_file.as_ref().to_string());
        }
        return spawnable
            .iter()
            .find(|line| lower(line).ends_with(".exe"))
            .map(|line| line.as_ref().to_string());
    }

    if let Some(exe) = spawnable.iter().find(|line| lower(line).ends_with(".exe")) {
        return Some(exe.as_ref().to_string());
    }
    if let Some(cmd_file) = spawnable.iter().find(|line| lower(line).ends_with(".cmd")) {
        return Some(cmd_file.as_ref().to_string());
    }
    spawnable
        .iter()
        .find(|line| {
            line.as_ref()
                .rsplit('\\')
                .next()
                .map(|file| file.contains('.'))
                .unwrap_or(false)
        })
        .or_else(|| spawnable.first())
        .map(|line| line.as_ref().to_string())
}

/// The destination used by PacketCode's official installer when PacketBench
/// invokes it without an explicit install directory.
pub fn packetcode_installer_target() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|local_app_data| {
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("PacketCode")
                .join("bin")
                .join("packetcode.exe")
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(PathBuf::from("/usr/local/bin/packetcode"))
    }
}

/// Resolve the exact PacketCode executable used by both launch-time doctor
/// probing and the Workspace PTY.
///
/// A thin `Result` shell over the shared [`resolve_cli_launch`]: PacketCode's
/// callers (`probe_packetcode_integration`) want a hard failure rather than a
/// bare name they cannot spawn. The tier order itself is not restated here.
pub async fn resolve_packetcode_launch(
    manual_path: Option<&str>,
) -> Result<ResolvedCliLaunch, String> {
    let spec = CliLaunchSpec::new("packetcode", manual_path);
    let resolved = resolve_cli_launch(&spec).await;
    if let Some(rejected) = resolved.rejected_settings_path.as_deref() {
        return Err(format!(
            "PacketCode executable is missing or not executable: {}",
            rejected
        ));
    }
    if !resolved.is_resolved() {
        return Err(
            "PacketCode was not found on PATH or in a documented install location".to_string(),
        );
    }
    Ok(resolved)
}

pub async fn resolve_packetcode_launch_path(manual_path: Option<&str>) -> Result<String, String> {
    resolve_packetcode_launch(manual_path)
        .await
        .map(|resolved| resolved.path)
}

/// Synchronous PATH check kept for legacy callers (used by `detect_agent`
/// command). Does NOT run the version probe — back-compat callers only
/// care about the boolean. New code should use [`resolve_path`].
pub fn detect_agent(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        if sync_where_lookup(command).is_some() {
            return true;
        }
        sync_where_lookup(&format!("{}.cmd", command)).is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        Command::new("which")
            .arg(command)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| first_nonempty_line(&o.stdout))
            .is_some()
    }
}

#[cfg(target_os = "windows")]
fn sync_where_lookup(name: &str) -> Option<String> {
    use std::process::Command;
    let mut cmd = Command::new("where");
    cmd.arg(name);
    crate::core::shared::hide_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    first_nonempty_line(&output.stdout)
}

/// Resolve a binary on PATH and return its absolute path.
///
/// CLI agents do NOT come through here — they go through
/// [`resolve_cli_launch`], which applies the Settings/pin/install-directory
/// tiers as well and is the same ladder the PTY spawns through. This remains
/// for terminal-shell resolution and the legacy `detect_agent` probe.
///
/// Uses `where` on Windows (also probing the `.cmd` wrapper if needed)
/// and `which` on POSIX. Each probe is wrapped in a 2-second timeout so
/// a hijacked `which`/`where` cannot stall the whole sweep.
pub async fn resolve_path(command: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = where_lookup_async(command).await {
            return Some(p);
        }
        let cmd_name = format!("{}.cmd", command);
        if let Some(p) = where_lookup_async(&cmd_name).await {
            return Some(p);
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = TokioCommand::new("which");
        cmd.arg(command);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());
        cmd.kill_on_drop(true);
        let child = cmd.spawn().ok()?;
        match timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) if output.status.success() => first_nonempty_line(&output.stdout),
            _ => None,
        }
    }
}

/// Resolve a TERMINAL SHELL to an absolute executable.
///
/// CLI agents do NOT come through here — they go through
/// [`resolve_cli_launch`], the tier order the PTY launcher also uses. This is
/// kept separate because Git Bash's discovery rules genuinely differ: its
/// documented install directories outrank a bare `PATH` hit (see
/// `git_bash_fallback_candidates`), which is the opposite of the agent tier
/// order, and folding the two together would change which `bash` launches.
pub async fn resolve_catalog_path(id: &str, command: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    if id == "git-bash" {
        // `where bash` may resolve the legacy WSL launcher in System32. A Git
        // Bash profile must point at Git for Windows, so prefer its documented
        // install locations and only accept a PATH hit that is clearly under a
        // Git directory.
        if let Some(path) = resolve_path(command).await {
            let normalized = path.replace('/', "\\").to_ascii_lowercase();
            if normalized.contains("\\git\\") {
                return Some(path);
            }
        }
        return git_bash_fallback_candidates()
            .into_iter()
            .find(|path| is_executable_file(&path.to_string_lossy()))
            .map(|path| path.to_string_lossy().to_string());
    }

    let _ = id;
    resolve_path(command).await
}

#[cfg(target_os = "windows")]
pub fn git_bash_fallback_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
}

pub fn packetcode_fallback_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("PacketCode")
                    .join("bin")
                    .join("packetcode.exe"),
            );
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join("packetcode.exe"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join("packetcode"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/packetcode"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/packetcode"));
    }
    candidates
}

#[cfg(target_os = "windows")]
async fn where_lookup_async(name: &str) -> Option<String> {
    let mut cmd = TokioCommand::new("where");
    cmd.arg(name);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().ok()?;
    match timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => first_nonempty_line(&output.stdout),
        _ => None,
    }
}

fn first_nonempty_line(buf: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(buf);
    for line in s.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Probe a binary's version by trying `--version` then `-v`, each capped at 3s.
/// Returns the first non-empty line of stdout (falling back to stderr), trimmed
/// and truncated to [`VERSION_MAX_LEN`] characters.
pub async fn probe_version(binary: &str) -> Option<String> {
    for arg in ["--version", "-v"] {
        if let Some(v) = run_version_probe(binary, arg).await {
            return Some(clamp_version(&v));
        }
    }
    None
}

/// Variant of [`probe_version`] that targets an absolute path instead of
/// resolving on PATH. Used by the manual-override detection branch — the
/// user has pointed us at a specific binary and we want to honour that
/// exact path without round-tripping through `where`/`which`.
pub async fn probe_version_at(path: &str) -> Option<String> {
    for arg in ["--version", "-v"] {
        if let Some(v) = run_version_probe(path, arg).await {
            return Some(clamp_version(&v));
        }
    }
    None
}

/// PacketCode's stable version contract is deliberately stricter than the
/// generic CLI detector. A binary is not considered PacketCode merely because
/// it prints any line for `--version`.
pub fn is_packetcode_version(version: &str) -> bool {
    version
        .trim()
        .to_ascii_lowercase()
        .starts_with("packetcode ")
}

async fn run_version_probe(binary: &str, arg: &str) -> Option<String> {
    let mut cmd = TokioCommand::new(binary);
    cmd.arg(arg);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Ensure a hung probe is killed when the future is dropped on timeout.
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        // Avoid flashing a console window on Windows for the probe.
        // `tokio::process::Command::creation_flags` is available natively
        // on the Windows target without importing `CommandExt`.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().ok()?;
    match timeout(VERSION_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            if let Some(line) = first_nonempty_line(&output.stdout) {
                return Some(line);
            }
            if let Some(line) = first_nonempty_line(&output.stderr) {
                return Some(line);
            }
            None
        }
        Ok(Err(_)) => None,
        Err(_) => {
            // Timed out — the dropped future + kill_on_drop reaps the child.
            None
        }
    }
}

/// True iff the path exists and points at a regular file. On POSIX, also
/// verifies that at least one execute bit is set on the file mode — a
/// non-executable file at a user-supplied "manual path" is almost certainly
/// a misconfiguration and we'd rather flag it than silently probe-fail.
/// On Windows file permissions don't gate exec the same way, so we only
/// require the regular-file check there.
pub fn is_executable_file(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(meta) => meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Abbreviate the user's home directory to `~` inside a path.
///
/// Used only by the copy-to-clipboard diagnostics block. A home directory
/// almost always contains the user's real name, and the resolution tier
/// already says WHERE a binary came from, so the literal home prefix carries
/// no diagnostic value. Everything else in the path is kept verbatim — a
/// custom install directory is exactly what a bug report needs.
pub fn redact_home_in_path(path: &str, home: Option<&std::path::Path>) -> String {
    let Some(home) = home else {
        return path.to_string();
    };
    let home = home.to_string_lossy();
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return path.to_string();
    }
    // Windows paths are case-insensitive and mix separators; compare on a
    // normalized copy but splice the ORIGINAL text so nothing else is altered.
    let normalize = |value: &str| {
        if cfg!(windows) {
            value.replace('/', "\\").to_ascii_lowercase()
        } else {
            value.to_string()
        }
    };
    let normalized_path = normalize(path);
    let normalized_home = normalize(home);
    if !normalized_path.starts_with(&normalized_home) {
        return path.to_string();
    }
    let rest = &path[home.len()..];
    if !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\') {
        // `C:\Users\ian-backup` must not be rewritten as `~-backup`.
        return path.to_string();
    }
    format!("~{}", rest)
}

fn clamp_version(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= VERSION_MAX_LEN {
        return trimmed.to_string();
    }
    trimmed.chars().take(VERSION_MAX_LEN).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packetcode_version_contract_rejects_unrelated_output() {
        assert!(is_packetcode_version("packetcode v0.3.0 (abc123)"));
        assert!(is_packetcode_version("PacketCode dev (none)"));
        assert!(!is_packetcode_version("node v24.0.0"));
        assert!(!is_packetcode_version("packetcode"));
    }

    #[test]
    fn packetcode_fallbacks_are_specific_binary_paths() {
        for candidate in packetcode_fallback_candidates() {
            let name = candidate
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            assert_eq!(name, "packetcode");
        }
    }

    #[test]
    fn packetcode_app_pin_uses_the_shared_brand_data_directory() {
        let home = tempfile::tempdir().expect("home");
        let data_dir = home.path().join(crate::core::brand::DATA_DIR_NAME);
        std::fs::create_dir_all(&data_dir).expect("data dir");
        let binary = home.path().join(if cfg!(windows) {
            "packetcode.exe"
        } else {
            "packetcode"
        });
        std::fs::write(&binary, b"test").expect("binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
                .expect("permissions");
        }
        std::fs::write(
            data_dir.join("packetcode-bin"),
            binary.to_string_lossy().as_bytes(),
        )
        .expect("pin");

        assert_eq!(
            app_pinned_cli_binary_in(home.path(), "packetcode").as_deref(),
            Some(binary.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn packetcode_installer_target_matches_the_official_default() {
        let target = packetcode_installer_target().expect("installer target");
        #[cfg(target_os = "windows")]
        assert!(target.ends_with(
            PathBuf::from("Programs")
                .join("PacketCode")
                .join("bin")
                .join("packetcode.exe")
        ));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(target, PathBuf::from("/usr/local/bin/packetcode"));
    }

    #[tokio::test]
    async fn settings_path_reports_its_resolution_source() {
        let home = tempfile::tempdir().expect("home");
        let binary = executable(home.path(), "packetcode");

        let resolved = resolve_packetcode_launch(binary.to_str())
            .await
            .expect("resolved");
        assert_eq!(resolved.path, binary.to_string_lossy());
        assert_eq!(resolved.source, CliLaunchSource::Settings);
    }

    // === Shared launch resolver ===

    /// Create an executable file named `name` (plus `.exe` on Windows).
    fn executable(dir: &std::path::Path, name: &str) -> PathBuf {
        let path = dir.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        });
        std::fs::write(&path, b"#!/bin/sh\n").expect("binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("permissions");
        }
        path
    }

    fn write_pin(home: &std::path::Path, program: &str, target: &std::path::Path) {
        let data_dir = home.join(crate::core::brand::DATA_DIR_NAME);
        std::fs::create_dir_all(&data_dir).expect("data dir");
        std::fs::write(
            data_dir.join(format!("{program}-bin")),
            target.to_string_lossy().as_ref(),
        )
        .expect("pin");
    }

    /// The tier order has to hold for EVERY CLI, not just PacketCode — the pin
    /// fault that motivated this work was cross-CLI.
    #[test]
    fn tier_order_holds_for_a_non_packetcode_cli() {
        let home = tempfile::tempdir().expect("home");
        let settings = executable(home.path(), "settings-claude");
        let pinned = executable(home.path(), "pinned-claude");
        let on_path = executable(home.path(), "path-claude");
        write_pin(home.path(), "claude", &pinned);

        let spec = |settings_path: Option<&str>| {
            CliLaunchSpec::new("claude", settings_path).with_home(Some(home.path().to_path_buf()))
        };
        let path_hit = || Some(on_path.to_string_lossy().into_owned());

        // 1. Settings outranks the legacy hidden pin.
        let resolved = resolve_cli_launch_with(&spec(settings.to_str()), |_| path_hit());
        assert_eq!(resolved.source, CliLaunchSource::Settings);
        assert_eq!(resolved.path, settings.to_string_lossy());

        // 2. Pin outranks PATH.
        let resolved = resolve_cli_launch_with(&spec(None), |_| path_hit());
        assert_eq!(resolved.source, CliLaunchSource::LegacyPin);
        assert_eq!(resolved.path, pinned.to_string_lossy());

        // 3. PATH wins once the pin is gone.
        let bare = tempfile::tempdir().expect("bare home");
        let no_pin = CliLaunchSpec::new("claude", None).with_home(Some(bare.path().to_path_buf()));
        let resolved = resolve_cli_launch_with(&no_pin, |_| path_hit());
        assert_eq!(resolved.source, CliLaunchSource::Path);
        assert_eq!(resolved.path, on_path.to_string_lossy());

        // 4. With no PATH hit and no documented install directory, resolution
        //    ends at the bare name. Uses a CLI that genuinely has no install
        //    tier: `claude`'s candidates are real paths on a developer machine
        //    (`~/.local/bin/claude.exe`), so asserting the fallthrough with
        //    `claude` would pass or fail depending on whose machine ran it.
        let unknown =
            CliLaunchSpec::new("gh-copilot", None).with_home(Some(bare.path().to_path_buf()));
        assert!(install_dir_candidates("gh-copilot").is_empty());
        let resolved = resolve_cli_launch_with(&unknown, |_| None);
        assert_eq!(resolved.source, CliLaunchSource::BareName);
        assert_eq!(resolved.path, "gh-copilot");
    }

    /// The install-directory tier is last, behind PATH — for the one CLI that
    /// has one.
    #[test]
    fn install_directory_tier_sits_behind_path() {
        let home = tempfile::tempdir().expect("home");
        let on_path = executable(home.path(), "path-packetcode");
        let spec =
            CliLaunchSpec::new("packetcode", None).with_home(Some(home.path().to_path_buf()));

        let resolved =
            resolve_cli_launch_with(&spec, |_| Some(on_path.to_string_lossy().into_owned()));
        assert_eq!(resolved.source, CliLaunchSource::Path);

        assert!(!install_dir_candidates("packetcode").is_empty());
        for candidate in install_dir_candidates("packetcode") {
            assert_eq!(
                candidate.file_stem().and_then(|name| name.to_str()),
                Some("packetcode")
            );
        }
    }

    /// A Settings path that is not there must not silently become the launch
    /// binary, and must not vanish either: resolution continues down the tiers
    /// and the rejected path is carried out so a reporting surface can show
    /// exactly which configured value was ignored.
    #[test]
    fn a_dangling_settings_path_is_reported_and_falls_through() {
        let home = tempfile::tempdir().expect("home");
        let on_path = executable(home.path(), "path-codex");
        let missing = home.path().join("gone").join("codex");
        let spec = CliLaunchSpec::new("codex", missing.to_str())
            .with_home(Some(home.path().to_path_buf()));

        let resolved =
            resolve_cli_launch_with(&spec, |_| Some(on_path.to_string_lossy().into_owned()));
        assert_eq!(resolved.source, CliLaunchSource::Path);
        assert_eq!(
            resolved.rejected_settings_path.as_deref(),
            Some(missing.to_string_lossy().as_ref())
        );
    }

    /// A path-shaped command IS the Settings choice — that is how the
    /// Workspace hands a Browse-pinned binary to the PTY.
    #[test]
    fn a_path_shaped_command_is_treated_as_the_settings_tier() {
        let home = tempfile::tempdir().expect("home");
        let binary = executable(home.path(), "opencode");
        let spec = CliLaunchSpec::from_command(binary.to_string_lossy().as_ref())
            .with_home(Some(home.path().to_path_buf()));

        let resolved = resolve_cli_launch_with(&spec, |_| panic!("PATH must not be probed"));
        assert_eq!(resolved.source, CliLaunchSource::Settings);
        assert_eq!(resolved.path, binary.to_string_lossy());
        assert_eq!(spec.program(), "opencode");
    }

    /// THE deliverable: the reporting entry point and the launch entry point
    /// select the identical binary for identical inputs. They are two
    /// functions only because tier 3 is async on one side; if either ever
    /// grew its own tier order, this would catch it.
    #[tokio::test]
    async fn reporting_and_launch_resolve_to_the_same_binary() {
        let home = tempfile::tempdir().expect("home");
        let settings = executable(home.path(), "settings-claude");
        let pinned = executable(home.path(), "pinned-claude");
        write_pin(home.path(), "claude", &pinned);
        write_pin(home.path(), "opencode", &pinned);

        let cases = [
            // Settings tier.
            CliLaunchSpec::new("claude", settings.to_str()),
            // Legacy pin tier.
            CliLaunchSpec::new("claude", None),
            // Rejected settings path, then the pin.
            CliLaunchSpec::new("claude", Some("/definitely/not/here/claude")),
            // A path-shaped command that resolves to the Settings tier.
            CliLaunchSpec::from_command(settings.to_string_lossy().as_ref()),
            // A CLI with no pin, no settings, and (on a clean test host) no
            // PATH entry — exercises PATH + bare-name agreement.
            CliLaunchSpec::new("packetbench-nonexistent-cli", None),
            // A pin keyed on the program name of a different CLI.
            CliLaunchSpec::new("opencode", None),
        ];

        for spec in cases {
            let spec = spec.with_home(Some(home.path().to_path_buf()));
            let launched = resolve_cli_launch_sync(&spec);
            let reported = resolve_cli_launch(&spec).await;
            assert_eq!(
                launched,
                reported,
                "reporting and launch disagreed for {:?}",
                spec.command()
            );
        }
    }

    /// Real PATH resolution, both entry points, on whatever host runs the
    /// tests. `cargo` is on PATH wherever these tests can run at all.
    #[tokio::test]
    async fn reporting_and_launch_agree_on_a_real_path_binary() {
        let home = tempfile::tempdir().expect("home");
        let spec = CliLaunchSpec::new("cargo", None).with_home(Some(home.path().to_path_buf()));

        let launched = resolve_cli_launch_sync(&spec);
        let reported = resolve_cli_launch(&spec).await;
        assert_eq!(launched, reported);
        assert_eq!(launched.source, CliLaunchSource::Path);
        assert!(is_executable_file(&launched.path));
    }

    #[test]
    fn diagnostics_abbreviate_the_home_directory_only_at_a_boundary() {
        let home = std::path::Path::new(if cfg!(windows) {
            r"C:\Users\ian"
        } else {
            "/home/ian"
        });
        let inside = if cfg!(windows) {
            r"C:\Users\ian\AppData\Roaming\npm\claude.cmd"
        } else {
            "/home/ian/.local/bin/claude"
        };
        let sibling = if cfg!(windows) {
            r"C:\Users\ian-backup\claude.exe"
        } else {
            "/home/ian-backup/claude"
        };

        assert!(!redact_home_in_path(inside, Some(home)).contains("ian"));
        assert!(redact_home_in_path(inside, Some(home)).starts_with('~'));
        // A sibling directory that merely shares the prefix is left alone.
        assert_eq!(redact_home_in_path(sibling, Some(home)), sibling);
        // No home known — nothing is rewritten.
        assert_eq!(redact_home_in_path(inside, None), inside);
    }
}
