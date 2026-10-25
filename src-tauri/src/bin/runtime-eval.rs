//! `runtime-eval` — offline-by-default H1 same-executor evaluation CLI.
//!
//! Runs versioned fixture cases through the production agent runner via the
//! deterministic fake lane. It is offline always: no provider, keyring, ambient
//! MCP server or real project is reachable from this binary. Live evaluation is
//! deliberately unimplemented, and `--live` refuses rather than running because
//! a credential happens to exist.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use packetbench_lib::runtime_eval::{
    load_cases, redact, run_case, Correctness, EvaluationCase, RunResult,
};

const USAGE: &str = "\
runtime-eval — offline same-executor evaluation lane (R8 / H1)

USAGE:
    runtime-eval [--cases <dir>] [--list | --all | --case <id> ...] [--out <path>]

OPTIONS:
    --cases <dir>   Directory of *.json EvaluationCase files
                    (default: src-tauri/testdata/runtime_eval)
    --list          Print the case catalog and exit (the default with no selector)
    --all           Run every case
    --case <id>     Run only the named case (repeatable)
    --out <path>    Write results.json and manifest.json into <path>
    --live          Refuse: live evaluation is not implemented in v1
    --help, -h      Show this help

Exits non-zero if any selected case fails correctness.";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match Options::parse(&args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("runtime-eval: {message}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    // Help wins over every other flag, so `--live --help` still explains itself.
    if options.help {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if options.live {
        eprintln!(
            "runtime-eval: --live is not implemented. Live evaluation requires an explicit \
             provider, account and target selection plus a declared spend policy; it must never \
             run merely because an API key exists on this machine. This build is offline-only."
        );
        return ExitCode::from(2);
    }

    let cases_dir = options
        .cases
        .clone()
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/runtime_eval"));

    let cases = match load_cases(&cases_dir) {
        Ok(cases) => cases,
        Err(error) => {
            eprintln!("runtime-eval: {error}");
            return ExitCode::from(2);
        }
    };

    let selecting = options.all || !options.case_ids.is_empty();
    if options.list || !selecting {
        print_catalog(&cases);
        return ExitCode::SUCCESS;
    }

    let selected = match select(&cases, &options) {
        Ok(selected) => selected,
        Err(message) => {
            eprintln!("runtime-eval: {message}");
            return ExitCode::from(2);
        }
    };

    let source_identity = std::env::var("PACKETBENCH_SOURCE_IDENTITY").unwrap_or_default();
    let mut results: Vec<RunResult> = Vec::with_capacity(selected.len());
    for case in &selected {
        let mut result = redact(&run_case(case).await);
        result.environment.source_identity = source_identity.clone();
        results.push(result);
    }

    print_table(&results);
    for result in results
        .iter()
        .filter(|result| result.correctness == Correctness::Fail)
    {
        let reason = result
            .failure_reason
            .as_deref()
            .unwrap_or("no reason recorded");
        eprintln!(
            "runtime-eval: {} FAILED ({}): {reason}",
            result.case_id,
            status_label(result.status)
        );
    }

    if let Some(out) = &options.out {
        if let Err(error) = write_artifacts(out, &results) {
            eprintln!("runtime-eval: {error}");
            return ExitCode::from(2);
        }
    }

    let failed = results
        .iter()
        .filter(|result| result.correctness == Correctness::Fail)
        .count();
    if failed > 0 {
        eprintln!("runtime-eval: {failed} case(s) failed");
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

#[derive(Default)]
struct Options {
    cases: Option<PathBuf>,
    list: bool,
    all: bool,
    case_ids: Vec<String>,
    out: Option<PathBuf>,
    live: bool,
    help: bool,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut options = Options::default();
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--help" | "-h" => options.help = true,
                "--list" => options.list = true,
                "--all" => options.all = true,
                "--live" => options.live = true,
                "--cases" => {
                    index += 1;
                    options.cases = Some(PathBuf::from(argument(args, index, "--cases")?));
                }
                "--case" => {
                    index += 1;
                    options
                        .case_ids
                        .push(argument(args, index, "--case")?.to_string());
                }
                "--out" => {
                    index += 1;
                    options.out = Some(PathBuf::from(argument(args, index, "--out")?));
                }
                other => return Err(format!("unknown argument: {other}")),
            }
            index += 1;
        }
        Ok(options)
    }
}

fn argument<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("{flag} needs a value"))
}

fn select<'a>(
    cases: &'a [EvaluationCase],
    options: &Options,
) -> Result<Vec<&'a EvaluationCase>, String> {
    if options.case_ids.is_empty() {
        return Ok(cases.iter().collect());
    }
    let mut selected = Vec::new();
    for id in &options.case_ids {
        let case = cases
            .iter()
            .find(|case| &case.case_id == id)
            .ok_or_else(|| format!("unknown case id: {id}"))?;
        selected.push(case);
    }
    Ok(selected)
}

fn print_catalog(cases: &[EvaluationCase]) {
    println!("{:<28} {:<4} {}", "CASE", "VER", "TITLE");
    for case in cases {
        println!("{:<28} {:<4} {}", case.case_id, case.version, case.title);
    }
    println!("\n{} case(s). Run with --all or --case <id>.", cases.len());
}

fn print_table(results: &[RunResult]) {
    println!(
        "{:<28} {:<10} {:<8} {:>7} {:>12}",
        "CASE", "STATUS", "CORRECT", "MS", "SPEND_USD_µ"
    );
    for result in results {
        println!(
            "{:<28} {:<10} {:<8} {:>7} {:>12}",
            result.case_id,
            status_label(result.status),
            match result.correctness {
                Correctness::Pass => "pass",
                Correctness::Fail => "fail",
            },
            result.duration_ms,
            result.spend.actual_usd_micros,
        );
    }
}

fn status_label(status: packetbench_lib::runtime_eval::RunStatus) -> &'static str {
    use packetbench_lib::runtime_eval::RunStatus;
    match status {
        RunStatus::Completed => "completed",
        RunStatus::Incomplete => "incomplete",
        RunStatus::Blocked => "blocked",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn write_artifacts(out: &Path, results: &[RunResult]) -> Result<(), String> {
    std::fs::create_dir_all(out).map_err(|error| format!("{}: {error}", out.display()))?;
    let results_json = serde_json::to_string_pretty(results).map_err(|error| error.to_string())?;
    std::fs::write(out.join("results.json"), results_json)
        .map_err(|error| format!("{}: {error}", out.display()))?;

    let passed = results
        .iter()
        .filter(|result| result.correctness == Correctness::Pass)
        .count();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "startedAt": now_iso8601(),
        "cases": results.len(),
        "passed": passed,
        "failed": results.len() - passed,
        "source": std::env::var("PACKETBENCH_SOURCE_IDENTITY").unwrap_or_default(),
    });
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    std::fs::write(out.join("manifest.json"), manifest_json)
        .map_err(|error| format!("{}: {error}", out.display()))?;
    Ok(())
}

fn now_iso8601() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
