//! Immutable independent-attempt landing, shared by SSH and hermetic fixtures.
use super::git::{validate_branch_name, MergeBranchOutcome};
use std::future::Future;

async fn checked<F, Fut>(run: &F, args: &[&str]) -> Result<String, String>
where
    F: Fn(Vec<String>) -> Fut + Send + Sync,
    Fut: Future<Output = Result<(String, i32), String>> + Send,
{
    let (output, code) = run(args.iter().map(|arg| (*arg).to_string()).collect()).await?;
    if code != 0 {
        return Err(format!(
            "Landing git {} failed ({code}): {}",
            args[0],
            output.trim()
        ));
    }
    Ok(output.trim().to_string())
}

/// The source is always an object ID. Keep source refs and worktrees: remote
/// cleanup cannot hold a ref transaction across filesystem removal, so deleting
/// either could erase a concurrently advanced checkout. Acceptance already
/// removes clean owned worktrees through its non-force cleanup contract.
pub(crate) async fn merge_at_ref<F, Fut>(
    run: F,
    base_branch: &str,
    source_branch: &str,
    expected_sha: &str,
    squash: bool,
) -> Result<MergeBranchOutcome, String>
where
    F: Fn(Vec<String>) -> Fut + Send + Sync,
    Fut: Future<Output = Result<(String, i32), String>> + Send,
{
    validate_branch_name(base_branch)?;
    validate_branch_name(source_branch)?;
    if base_branch == source_branch {
        return Err("An attempt cannot be landed into its own branch.".into());
    }
    if !matches!(expected_sha.len(), 40 | 64)
        || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The reviewed commit must be a full Git commit SHA.".into());
    }
    let expected_sha = expected_sha.to_ascii_lowercase();
    let source_ref = format!("refs/heads/{source_branch}^{{commit}}");
    checked(
        &run,
        &["check-ref-format", &format!("refs/heads/{base_branch}")],
    )
    .await?;
    checked(
        &run,
        &["check-ref-format", &format!("refs/heads/{source_branch}")],
    )
    .await?;
    if checked(&run, &["symbolic-ref", "--short", "HEAD"]).await? != base_branch {
        return Err(format!("Landing requires the saved base checkout on '{base_branch}'. Restore that branch before landing."));
    }
    if checked(&run, &["rev-parse", "--verify", &source_ref]).await? != expected_sha {
        return Err(
            "The retained attempt branch changed after review. Review it again before landing."
                .into(),
        );
    }
    let dirt = checked(
        &run,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "--",
            ".",
            ":(exclude).pkt-worktrees",
            ":(exclude).pkt-flight-integrations",
        ],
    )
    .await?;
    if !dirt.is_empty() {
        return Err(
            "Landing requires a clean base working tree. Commit or stash its changes first.".into(),
        );
    }
    let worktrees = checked(&run, &["worktree", "list", "--porcelain", "-z"]).await?;
    let branch_field = format!("branch refs/heads/{source_branch}");
    for record in worktrees.split("\0\0") {
        let fields: Vec<_> = record.split('\0').collect();
        if !fields.contains(&branch_field.as_str()) {
            continue;
        }
        let path = fields
            .iter()
            .find_map(|field| field.strip_prefix("worktree "))
            .ok_or("Cannot identify the attempt checkout; inspect it before landing.")?;
        if checked(&run, &["-C", path, "rev-parse", "HEAD"]).await? != expected_sha {
            return Err(
                "The attempt checkout advanced after review. Review it again before landing."
                    .into(),
            );
        }
        if !checked(
            &run,
            &[
                "-C",
                path,
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ],
        )
        .await?
        .is_empty()
        {
            return Err("The attempt worktree has uncommitted files. Inspect and commit them before landing.".into());
        }
    }
    let before = checked(&run, &["rev-parse", "HEAD"]).await?;
    // Recheck mutable names immediately before the immutable merge. A later
    // source advance can never change which object Git actually receives.
    if checked(&run, &["symbolic-ref", "--short", "HEAD"]).await? != base_branch
        || checked(&run, &["rev-parse", "--verify", &source_ref]).await? != expected_sha
    {
        return Err(
            "The base or attempt branch changed while preparing landing. Inspect it and retry."
                .into(),
        );
    }
    let mut args = vec!["merge".to_string()];
    if squash {
        args.push("--squash".into());
    } else {
        args.extend(["--no-ff".into(), "--no-edit".into()]);
    }
    args.push(expected_sha);
    let (output, code) = run(args).await?;
    if code != 0 {
        // --abort restores an ordinary merge when possible. Squash conflicts
        // have no MERGE_HEAD; leave those files visible for recovery rather
        // than guessing which raced edits a reset would discard.
        let _ = run(vec!["merge".into(), "--abort".into()]).await;
        return Err(format!("Landing merge failed; no delivery was recorded. Inspect the base checkout before retrying. The attempt branch and worktree were retained. {}", output.trim()));
    }
    if squash {
        let (output, code) = run(vec!["diff".into(), "--cached".into(), "--quiet".into()]).await?;
        if !matches!(code, 0 | 1) {
            return Err(format!(
                "Cannot inspect staged landing changes: {}",
                output.trim()
            ));
        }
        if code == 1 {
            let message = format!("Merge branch '{source_branch}' (squash)");
            let (output, code) = run(vec!["commit".into(), "-m".into(), message]).await?;
            if code != 0 {
                return Err(format!("Landing commit failed; no delivery was recorded. The staged result remains in the base checkout for inspection, and the attempt branch/worktree were retained. {}", output.trim()));
            }
        }
    }
    let head = checked(&run, &["rev-parse", "HEAD"]).await?;
    Ok(MergeBranchOutcome {
        nothing_to_land: head == before,
        commit_sha: head,
        branch_deleted: false,
        worktree_removed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    fn git_result(path: &Path, args: &[&str]) -> (String, i32) {
        let mut command = std::process::Command::new("git");
        crate::core::shared::hide_window(&mut command);
        let output = command.current_dir(path).args(args).output().unwrap();
        (
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            output.status.code().unwrap_or(-1),
        )
    }
    fn git(path: &Path, args: &[&str]) -> String {
        let (output, code) = git_result(path, args);
        assert_eq!(code, 0, "git {args:?}: {output}");
        output.trim().to_string()
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        base: PathBuf,
        source: PathBuf,
        reviewed: String,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().join("base with spaces");
            std::fs::create_dir(&base).unwrap();
            git(&base, &["init", "-b", "main"]);
            git(&base, &["config", "user.name", "Landing Fixture"]);
            git(&base, &["config", "user.email", "landing@example.invalid"]);
            git(&base, &["config", "commit.gpgsign", "false"]);
            git(&base, &["config", "core.autocrlf", "false"]);
            std::fs::write(base.join("base.txt"), "base\n").unwrap();
            git(&base, &["add", "base.txt"]);
            git(&base, &["commit", "-m", "initial"]);
            let source = base.join(".pkt-worktrees").join("attempt");
            git(
                &base,
                &[
                    "worktree",
                    "add",
                    "-b",
                    "pkt/attempt",
                    source.to_str().unwrap(),
                    "main",
                ],
            );
            std::fs::write(source.join("reviewed.txt"), "reviewed content\n").unwrap();
            git(&source, &["add", "reviewed.txt"]);
            git(&source, &["commit", "-m", "reviewed result"]);
            let reviewed = git(&source, &["rev-parse", "HEAD"]);
            Self {
                _temp: temp,
                base,
                source,
                reviewed,
            }
        }
        async fn land(&self, squash: bool) -> Result<MergeBranchOutcome, String> {
            let base = self.base.clone();
            merge_at_ref(
                move |args| {
                    let base = base.clone();
                    async move {
                        let refs: Vec<_> = args.iter().map(String::as_str).collect();
                        Ok(git_result(&base, &refs))
                    }
                },
                "main",
                "pkt/attempt",
                &self.reviewed,
                squash,
            )
            .await
        }
        fn assert_source_preserved(&self) {
            assert!(self.source.join("reviewed.txt").exists());
            assert_eq!(
                git(&self.base, &["rev-parse", "refs/heads/pkt/attempt"]),
                self.reviewed
            );
        }
    }

    #[tokio::test]
    async fn ssh_landing_driver_squashes_reviewed_sha_and_retains_source_checkout() {
        let fixture = Fixture::new();
        let before = git(&fixture.base, &["rev-parse", "HEAD"]);
        let outcome = fixture.land(true).await.unwrap();
        assert!(!outcome.nothing_to_land);
        assert!(!outcome.branch_deleted);
        assert!(!outcome.worktree_removed);
        assert_ne!(outcome.commit_sha, before);
        assert_eq!(
            std::fs::read_to_string(fixture.base.join("reviewed.txt")).unwrap(),
            "reviewed content\n"
        );
        assert_eq!(
            git(&fixture.base, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split_whitespace()
                .count(),
            2
        );
        fixture.assert_source_preserved();
    }

    #[tokio::test]
    async fn ssh_landing_driver_delivers_after_acceptance_removed_the_worktree() {
        let fixture = Fixture::new();
        git(
            &fixture.base,
            &["worktree", "remove", fixture.source.to_str().unwrap()],
        );
        let outcome = fixture.land(true).await.unwrap();
        assert!(!outcome.nothing_to_land);
        assert!(fixture.base.join("reviewed.txt").exists());
        assert!(!fixture.source.exists());
        assert_eq!(
            git(&fixture.base, &["rev-parse", "refs/heads/pkt/attempt"]),
            fixture.reviewed
        );
        assert!(!outcome.branch_deleted);
    }

    #[tokio::test]
    async fn ssh_landing_refuses_missing_or_empty_pins_before_any_ssh_execution() {
        let mut config: crate::core::execution::SshConfig = serde_json::from_value(serde_json::json!({"host":"not-contacted.invalid","port":1,"user":"fixture","remote_path":"/not-contacted"})).unwrap();
        for fingerprint in [None, Some("   ".to_string())] {
            config.host_fingerprint = fingerprint;
            let error = crate::core::worktree::land_remote_attempt_at_ref(
                &config,
                "/not-contacted",
                "main",
                "pkt/attempt",
                &"a".repeat(40),
                true,
            )
            .await
            .unwrap_err();
            assert!(error.contains("host key"));
        }
    }

    #[tokio::test]
    async fn ssh_landing_driver_honors_merge_mode_and_empty_repeat_is_not_delivery() {
        let fixture = Fixture::new();
        let outcome = fixture.land(false).await.unwrap();
        assert!(!outcome.nothing_to_land);
        assert_eq!(
            git(&fixture.base, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split_whitespace()
                .count(),
            3
        );
        let repeated = fixture.land(true).await.unwrap();
        assert!(repeated.nothing_to_land);
        assert_eq!(repeated.commit_sha, outcome.commit_sha);
        fixture.assert_source_preserved();
    }

    #[tokio::test]
    async fn ssh_landing_driver_refuses_wrong_base_branch_and_moved_source() {
        let fixture = Fixture::new();
        git(&fixture.base, &["checkout", "-b", "other"]);
        assert!(fixture.land(true).await.unwrap_err().contains("saved base"));
        git(&fixture.base, &["checkout", "main"]);
        std::fs::write(fixture.source.join("later.txt"), "not reviewed\n").unwrap();
        git(&fixture.source, &["add", "later.txt"]);
        git(&fixture.source, &["commit", "-m", "later"]);
        assert!(fixture
            .land(true)
            .await
            .unwrap_err()
            .contains("changed after review"));
        assert!(!fixture.base.join("reviewed.txt").exists());
        assert!(fixture.source.join("later.txt").exists());
    }

    #[tokio::test]
    async fn ssh_landing_driver_refuses_staged_unstaged_untracked_root_or_source_files() {
        for kind in ["staged", "unstaged", "untracked", "source"] {
            let fixture = Fixture::new();
            let path = if kind == "source" {
                fixture.source.join("uncommitted.txt")
            } else if kind == "untracked" {
                fixture.base.join("uncommitted.txt")
            } else {
                fixture.base.join("base.txt")
            };
            std::fs::write(&path, "keep my uncommitted files\n").unwrap();
            if kind == "staged" {
                git(&fixture.base, &["add", "base.txt"]);
            }
            let before = git(&fixture.base, &["rev-parse", "HEAD"]);
            let error = fixture.land(true).await.unwrap_err();
            assert!(
                error.contains(if kind == "source" {
                    "attempt worktree"
                } else {
                    "clean base"
                }),
                "{kind}: {error}"
            );
            assert_eq!(git(&fixture.base, &["rev-parse", "HEAD"]), before);
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                "keep my uncommitted files\n"
            );
            fixture.assert_source_preserved();
        }
    }

    #[tokio::test]
    async fn ssh_landing_driver_merges_pinned_sha_if_source_advances_during_merge() {
        let fixture = Fixture::new();
        let changed = Arc::new(AtomicBool::new(false));
        let base = fixture.base.clone();
        let source = fixture.source.clone();
        let switched = changed.clone();
        let outcome = merge_at_ref(
            move |args| {
                let base = base.clone();
                let source = source.clone();
                let switched = switched.clone();
                async move {
                    if args.first().is_some_and(|arg| arg == "merge")
                        && !switched.swap(true, Ordering::SeqCst)
                    {
                        std::fs::write(source.join("unreviewed.txt"), "later committed work\n")
                            .unwrap();
                        git(&source, &["add", "unreviewed.txt"]);
                        git(&source, &["commit", "-m", "concurrent advance"]);
                    }
                    let refs: Vec<_> = args.iter().map(String::as_str).collect();
                    Ok(git_result(&base, &refs))
                }
            },
            "main",
            "pkt/attempt",
            &fixture.reviewed,
            true,
        )
        .await
        .unwrap();
        assert!(changed.load(Ordering::SeqCst));
        assert!(!outcome.nothing_to_land);
        assert!(fixture.base.join("reviewed.txt").exists());
        assert!(!fixture.base.join("unreviewed.txt").exists());
        assert!(fixture.source.join("unreviewed.txt").exists());
        assert_ne!(
            git(&fixture.base, &["rev-parse", "refs/heads/pkt/attempt"]),
            fixture.reviewed
        );
        assert!(!outcome.branch_deleted);
        assert!(!outcome.worktree_removed);
    }

    #[tokio::test]
    async fn ssh_landing_driver_preserves_staged_output_on_commit_failure() {
        let fixture = Fixture::new();
        let before = git(&fixture.base, &["rev-parse", "HEAD"]);
        let hooks = fixture.base.join(".git").join("failing-hooks");
        std::fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(
            &fixture.base,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        assert!(fixture
            .land(true)
            .await
            .unwrap_err()
            .contains("staged result remains"));
        assert_eq!(git(&fixture.base, &["rev-parse", "HEAD"]), before);
        assert!(git(&fixture.base, &["diff", "--cached", "--name-only"]).contains("reviewed.txt"));
        assert!(fixture.base.join("reviewed.txt").exists());
        fixture.assert_source_preserved();
    }
}
