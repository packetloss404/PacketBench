use super::shared::SKIP_DIRS;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;
use tracing::info;

#[derive(Clone, Serialize)]
pub struct LanguageStats {
    pub name: String,
    pub extension: String,
    pub files: u32,
    pub code_lines: u32,
    pub comment_lines: u32,
    pub blank_lines: u32,
    pub total_lines: u32,
}

#[derive(Clone, Serialize)]
pub struct FileComplexity {
    pub path: String,
    pub language: String,
    pub lines: u32,
    pub complexity: u32,
}

#[derive(Clone, Serialize)]
pub struct CodeQualityReport {
    pub total_files: u32,
    pub total_code_lines: u32,
    pub total_lines: u32,
    pub total_comment_lines: u32,
    pub total_blank_lines: u32,
    pub language_count: u32,
    pub languages: Vec<LanguageStats>,
    pub avg_complexity: f64,
    pub test_files: u32,
    pub test_lines: u32,
    pub top_complex_files: Vec<FileComplexity>,
    pub comment_ratio: f64,
    pub test_ratio: f64,
    pub org_score: u32,
}

fn get_language(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "rs" => Some("rust"),
        "py" => Some("python"),
        "go" => Some("go"),
        "java" => Some("java"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" => Some("cpp"),
        "cs" => Some("csharp"),
        "rb" => Some("ruby"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "kt" | "kts" => Some("kotlin"),
        "lua" => Some("lua"),
        "sh" | "bash" | "zsh" => Some("shell"),
        "ps1" => Some("powershell"),
        "sql" => Some("sql"),
        "html" | "htm" => Some("html"),
        "css" | "scss" | "sass" | "less" => Some("css"),
        "json" => Some("json"),
        "yaml" | "yml" => Some("yaml"),
        "toml" => Some("toml"),
        "xml" => Some("xml"),
        "md" | "mdx" => Some("markdown"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "dart" => Some("dart"),
        "r" | "R" => Some("r"),
        "ex" | "exs" => Some("elixir"),
        "zig" => Some("zig"),
        _ => None,
    }
}

fn is_comment_lang(lang: &str) -> bool {
    !matches!(lang, "json" | "yaml" | "toml" | "xml" | "markdown" | "html")
}

/// Count complexity keywords in a line for supported languages
fn line_complexity(line: &str, lang: &str) -> u32 {
    if matches!(
        lang,
        "json" | "yaml" | "toml" | "xml" | "markdown" | "html" | "css" | "sql"
    ) {
        return 0;
    }
    let trimmed = line.trim();
    let mut score: u32 = 0;
    // Simple keyword-based complexity: each branch/loop adds 1
    let keywords = [
        "if ", "if(", "else ", "else{", "for ", "for(", "while ", "while(", "switch ", "switch(",
        "match ", "match{", "case ", "catch ", "catch(", "? ", "&&", "||", "try ", "try{",
    ];
    for kw in &keywords {
        if trimmed.contains(kw) {
            score += 1;
        }
    }
    score
}

fn is_test_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    if normalized.starts_with("tests/")
        || normalized.starts_with("__tests__/")
        || normalized.contains("/tests/")
        || normalized.contains("/__tests__/")
    {
        return true;
    }

    let file_name = normalized.rsplit('/').next().unwrap_or("");
    file_name.contains(".test.") || file_name.contains(".spec.")
}

fn analyze_file(path: &Path, lang: &str) -> (u32, u32, u32, u32, u32) {
    // Returns: (code_lines, comment_lines, blank_lines, total_lines, complexity)
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (0, 0, 0, 0, 0),
    };

    let mut code = 0u32;
    let mut comments = 0u32;
    let mut blanks = 0u32;
    let mut total = 0u32;
    let mut complexity = 0u32;
    let mut in_block_comment = false;
    let can_comment = is_comment_lang(lang);

    for line in content.lines() {
        total += 1;
        let trimmed = line.trim();

        if trimmed.is_empty() {
            blanks += 1;
            continue;
        }

        if can_comment {
            // Block comments
            if in_block_comment {
                comments += 1;
                if trimmed.contains("*/") {
                    in_block_comment = false;
                }
                continue;
            }

            if trimmed.starts_with("/*") {
                comments += 1;
                if !trimmed.contains("*/") {
                    in_block_comment = true;
                }
                continue;
            }

            // Line comments
            if trimmed.starts_with("//")
                || (trimmed.starts_with('#')
                    && matches!(lang, "python" | "ruby" | "shell" | "r" | "yaml" | "toml"))
            {
                comments += 1;
                continue;
            }

            // Python/Rust doc comments
            if (trimmed.starts_with("///") || trimmed.starts_with("//!")) && matches!(lang, "rust")
            {
                comments += 1;
                continue;
            }
        }

        code += 1;
        complexity += line_complexity(line, lang);
    }

    (code, comments, blanks, total, complexity)
}

/// Calculate organization score based on directory structure heuristics
fn calc_org_score(files: &[(String, String)]) -> u32 {
    if files.is_empty() {
        return 50;
    }

    let mut score: f64 = 50.0;

    // Check for source directory organization
    let has_src = files.iter().any(|(p, _)| {
        p.contains("/src/")
            || p.contains("\\src\\")
            || p.starts_with("src/")
            || p.starts_with("src\\")
    });
    if has_src {
        score += 10.0;
    }

    // Check for config files at root
    let has_config = files.iter().any(|(p, _)| {
        let name = p.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
        matches!(
            name,
            "package.json" | "Cargo.toml" | "pyproject.toml" | "go.mod" | "tsconfig.json"
        )
    });
    if has_config {
        score += 5.0;
    }

    // Check for test organization
    let has_test_dir = files.iter().any(|(p, _)| {
        p.contains("/tests/")
            || p.contains("\\tests\\")
            || p.contains("/__tests__/")
            || p.contains("\\__tests__\\")
    });
    if has_test_dir {
        score += 10.0;
    }

    // Check for consistent naming (no mixed case styles in same dir)
    let has_readme = files.iter().any(|(p, _)| {
        let name = p
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or("")
            .to_lowercase();
        name == "readme.md" || name == "readme"
    });
    if has_readme {
        score += 5.0;
    }

    // Check average directory depth (shallow = better organized)
    let avg_depth: f64 = files
        .iter()
        .map(|(p, _)| p.matches('/').count() + p.matches('\\').count())
        .sum::<usize>() as f64
        / files.len() as f64;

    if avg_depth < 3.0 {
        score += 10.0;
    } else if avg_depth < 5.0 {
        score += 5.0;
    }

    // Check for types/interfaces directory
    let has_types = files
        .iter()
        .any(|(p, _)| p.contains("/types/") || p.contains("\\types\\"));
    if has_types {
        score += 5.0;
    }

    // Check for components directory
    let has_components = files
        .iter()
        .any(|(p, _)| p.contains("/components/") || p.contains("\\components\\"));
    if has_components {
        score += 5.0;
    }

    score.min(100.0) as u32
}

const MAX_DEPTH: usize = 20;
const MAX_FILES: usize = 10_000;

fn walk_dir(dir: &Path, base: &Path, files: &mut Vec<(String, String)>) {
    walk_dir_inner(dir, base, files, 0);
}

fn walk_dir_inner(dir: &Path, base: &Path, files: &mut Vec<(String, String)>, depth: usize) {
    if depth >= MAX_DEPTH || files.len() >= MAX_FILES {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if files.len() >= MAX_FILES {
            return;
        }

        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip symlinks to prevent traversal attacks
        if let Ok(metadata) = entry.metadata() {
            if metadata.file_type().is_symlink() {
                continue;
            }
        }

        if path.is_dir() {
            if SKIP_DIRS.contains(&file_name.as_str()) || file_name.starts_with('.') {
                continue;
            }
            walk_dir_inner(&path, base, files, depth + 1);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if let Some(lang) = get_language(&ext_str) {
                    let rel_path = path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    files.push((rel_path, lang.to_string()));
                }
            }
        }
    }
}

#[tauri::command]
pub fn analyze_code_quality(project_path: String) -> Result<CodeQualityReport, String> {
    super::validate_project_path(&project_path)?;

    let base = Path::new(&project_path);

    // Collect all recognized files
    let mut files: Vec<(String, String)> = Vec::new();
    walk_dir(base, base, &mut files);

    // Per-language aggregation
    let mut lang_map: HashMap<String, LanguageStats> = HashMap::new();
    let mut all_complexities: Vec<FileComplexity> = Vec::new();
    let mut total_complexity: u64 = 0;
    let mut complexity_file_count: u32 = 0;
    let mut test_files: u32 = 0;
    let mut test_lines: u32 = 0;

    for (rel_path, lang) in &files {
        let full_path = base.join(rel_path);
        let (code, comments, blanks, total, complexity) = analyze_file(&full_path, lang);

        let ext = full_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        let entry = lang_map.entry(lang.clone()).or_insert(LanguageStats {
            name: lang.clone(),
            extension: ext.clone(),
            files: 0,
            code_lines: 0,
            comment_lines: 0,
            blank_lines: 0,
            total_lines: 0,
        });

        entry.files += 1;
        entry.code_lines += code;
        entry.comment_lines += comments;
        entry.blank_lines += blanks;
        entry.total_lines += total;

        if is_test_file(rel_path) {
            test_files += 1;
            test_lines += total;
        }

        if complexity > 0 || is_comment_lang(lang) {
            total_complexity += complexity as u64;
            complexity_file_count += 1;
            all_complexities.push(FileComplexity {
                path: rel_path.clone(),
                language: lang.clone(),
                lines: total,
                complexity,
            });
        }
    }

    // Sort complexities descending, take top 20
    all_complexities.sort_by(|a, b| b.complexity.cmp(&a.complexity));
    let top_complex: Vec<FileComplexity> = all_complexities.into_iter().take(20).collect();

    // Aggregate totals
    let mut languages: Vec<LanguageStats> = lang_map.into_values().collect();
    languages.sort_by(|a, b| b.total_lines.cmp(&a.total_lines));

    let total_files: u32 = languages.iter().map(|l| l.files).sum();
    let total_code: u32 = languages.iter().map(|l| l.code_lines).sum();
    let total_comments: u32 = languages.iter().map(|l| l.comment_lines).sum();
    let total_blanks: u32 = languages.iter().map(|l| l.blank_lines).sum();
    let total_lines: u32 = languages.iter().map(|l| l.total_lines).sum();
    let language_count = languages.len() as u32;

    let avg_complexity = if complexity_file_count > 0 {
        total_complexity as f64 / complexity_file_count as f64
    } else {
        0.0
    };

    let comment_ratio = if total_code + total_comments > 0 {
        total_comments as f64 / (total_code + total_comments) as f64
    } else {
        0.0
    };

    let test_ratio = if total_files > 0 {
        test_files as f64 / total_files as f64
    } else {
        0.0
    };

    let org_score = calc_org_score(&files);

    Ok(CodeQualityReport {
        total_files,
        total_code_lines: total_code,
        total_lines,
        total_comment_lines: total_comments,
        total_blank_lines: total_blanks,
        language_count,
        languages,
        avg_complexity,
        test_files,
        test_lines,
        top_complex_files: top_complex,
        comment_ratio,
        test_ratio,
        org_score,
    })
}

// =============================================================================
// v0.8.8 quality ai
// -----------------------------------------------------------------------------
// AI-powered actions for the Code Quality modal. The caller pre-allocates a
// session id, subscribes to `api-agent:chunk:<sid>` / `api-agent:done:<sid>` /
// `api-agent:error:<sid>`, then invokes; we resolve an auxiliary route and hand
// the prompt envelope from `core::code_quality_ai_prompts` to
// `core::aux_llm::spawn_aux_stream`, which emits that same event triple.
//
// WI-1 (`dev/oauth-removal-plan.md`): these used to fire
// `SidecarManager::forward_start("claude-oauth")`, routing the user's Claude
// subscription credentials for an action they never picked a provider for.
// Provider + model now come from the routing layer (Settings → AI Provider
// Routing), defaulting to the cheapest configured API key. With no configured
// provider the command returns a clear error; it never falls back to OAuth.
//
// Coordinated with q1 (runner) + q3 (autofix) by living at the end of this
// file behind a single, clearly-marked section header so unrelated diffs
// don't fight each other.
// =============================================================================

/// Maximum bytes per individual check output handed to the summarizer.
/// Each check is independently capped so one extremely noisy check (e.g.
/// a stack-trace-heavy test runner) can't crowd out the others.
const SUMMARIZE_PER_CHECK_CAP_BYTES: usize = 32 * 1024;

/// Total bytes across all check outputs. If the per-check caps already
/// trim things below this, no extra work happens.
const SUMMARIZE_TOTAL_CAP_BYTES: usize = 96 * 1024;

/// Task classes for the routing layer. Provider and model come from
/// `core::aux_llm` — there are no provider/model constants here, by design.
const AI_QUALITY_SUMMARIZE_TASK: crate::core::aux_llm::AuxTaskClass =
    crate::core::aux_llm::AuxTaskClass::CodeQualitySummarize;

/// Cut `text` to at most `cap` bytes ending on a UTF-8 boundary. Returns
/// `(text, was_truncated, original_byte_len)`. Mirrors the helper in
/// `commands::github` — duplicated rather than re-exported so the two
/// AI feature surfaces stay decoupled.
fn truncate_for_model_ai(text: &str, cap: usize) -> (String, bool, usize) {
    let original_len = text.len();
    if original_len <= cap {
        return (text.to_string(), false, original_len);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
    s.push_str(&format!(
        "\n\n... (truncated, original size {} bytes)\n",
        original_len
    ));
    (s, true, original_len)
}

/// `code_quality_ai_summarize` — kick off a one-shot auxiliary LLM turn
/// that produces a structured Markdown summary of every failing check in a
/// run. Uses the configured auxiliary API route and streams scoped session events.
///
/// `run_id` is opaque to the backend (the frontend uses it to cache the
/// final markdown locally so re-opening the modal doesn't re-stream the
/// same summary). `project_name` is a label for the prompt header; we
/// don't open the project on disk.
///
/// `check_outputs` is a string→string map (`{"lint": "…", "build": "…"}`).
/// Each value is independently capped at `SUMMARIZE_PER_CHECK_CAP_BYTES`;
/// after that the whole envelope is capped at
/// `SUMMARIZE_TOTAL_CAP_BYTES` (caller-friendly: oversized payloads still
/// get a useful summary, just with explicit truncation markers).
///
/// `check_exit_codes` is parallel to `check_outputs` (keyed by the same
/// names). Missing entries default to `1` (treated as "failing" by the
/// prompt header).
#[tauri::command]
pub async fn code_quality_ai_summarize(
    app_handle: tauri::AppHandle,
    routing: State<'_, crate::core::aux_llm::AuxRoutingState>,
    run_id: String,
    project_name: String,
    check_outputs: HashMap<String, String>,
    check_exit_codes: Option<HashMap<String, i32>>,
    session_id_override: Option<String>,
) -> Result<String, String> {
    if check_outputs.is_empty() {
        return Err("check_outputs cannot be empty".to_string());
    }

    // Stable ordering: lint → typecheck → tests → build → anything else
    // alphabetically. Keeps the model's "Priority order" section
    // deterministic across re-runs and matches how the modal lists checks
    // in the failed-checks panel.
    fn check_sort_key(name: &str) -> (u8, String) {
        let lower = name.to_lowercase();
        let bucket = match lower.as_str() {
            "lint" => 0,
            "typecheck" | "tsc" | "type-check" => 1,
            "test" | "tests" => 2,
            "build" => 3,
            _ => 4,
        };
        (bucket, lower)
    }

    let mut entries: Vec<(String, String)> = check_outputs.into_iter().collect();
    entries.sort_by(|a, b| check_sort_key(&a.0).cmp(&check_sort_key(&b.0)));

    let exit_codes = check_exit_codes.unwrap_or_default();

    // Truncate per-check, then in a second pass enforce the total cap by
    // re-truncating the longest outputs in order until the envelope fits.
    let mut prepared: Vec<(String, i32, String, bool, usize)> = Vec::with_capacity(entries.len());
    let mut running_total: usize = 0;
    for (name, raw_output) in &entries {
        let (capped, truncated, original) =
            truncate_for_model_ai(raw_output, SUMMARIZE_PER_CHECK_CAP_BYTES);
        running_total += capped.len();
        let exit = exit_codes.get(name).copied().unwrap_or(1);
        prepared.push((name.clone(), exit, capped, truncated, original));
    }

    if running_total > SUMMARIZE_TOTAL_CAP_BYTES {
        // Second pass: re-truncate the longest outputs proportionally.
        // The pathological case (one giant log + several small ones) is
        // the common one, so attacking the largest first is sufficient.
        let mut over = running_total.saturating_sub(SUMMARIZE_TOTAL_CAP_BYTES);
        // indices sorted longest-first
        let mut idx: Vec<usize> = (0..prepared.len()).collect();
        idx.sort_by_key(|&i| std::cmp::Reverse(prepared[i].2.len()));
        for i in idx {
            if over == 0 {
                break;
            }
            let cur_len = prepared[i].2.len();
            // shrink this one by up to half its current size or `over`,
            // whichever is smaller. Min floor 2 KiB so we never starve a
            // check entirely.
            let target = cur_len.saturating_sub(over).max(2 * 1024).min(cur_len);
            if target < cur_len {
                let (recapped, _t, _o) = truncate_for_model_ai(&prepared[i].2, target);
                let shrunk = cur_len - recapped.len();
                prepared[i].2 = recapped;
                // Force-mark as truncated even if `truncate_for_model_ai`
                // didn't (e.g. byte-boundary nudge); we'd rather over-warn
                // the model than under-warn.
                prepared[i].3 = true;
                over = over.saturating_sub(shrunk);
            }
        }
    }

    let check_inputs: Vec<crate::core::code_quality_ai_prompts::CheckOutputInput<'_>> = prepared
        .iter()
        .map(|(name, exit, output, truncated, original)| {
            crate::core::code_quality_ai_prompts::CheckOutputInput {
                name: name.as_str(),
                exit_code: *exit,
                output: output.as_str(),
                truncated: *truncated,
                original_bytes: *original,
            }
        })
        .collect();

    let user_turn =
        crate::core::code_quality_ai_prompts::summarize_run_user_turn(&project_name, &check_inputs);

    let route = routing.resolve(AI_QUALITY_SUMMARIZE_TASK)?;

    let session_id = session_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("quality-ai-summary-{}", uuid::Uuid::new_v4()));

    info!(
        run_id = %run_id,
        project = %project_name,
        checks = entries.len(),
        session_id = %session_id,
        provider = %route.provider,
        model = %route.model,
        "code quality AI summarize session started"
    );

    crate::core::aux_llm::spawn_aux_stream(
        app_handle,
        AI_QUALITY_SUMMARIZE_TASK,
        route,
        session_id.clone(),
        crate::core::code_quality_ai_prompts::SUMMARIZE_RUN_SYSTEM_PROMPT.to_string(),
        user_turn,
    );

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-{}-{}", prefix, unique));
        fs::create_dir_all(&dir).expect("failed to create temp test directory");
        dir
    }

    fn normalize(path: &str) -> String {
        path.replace('\\', "/")
    }

    #[test]
    fn is_test_file_matches_strict_test_patterns() {
        assert!(is_test_file("src/foo.test.ts"));
        assert!(is_test_file("src/foo.spec.tsx"));
        assert!(is_test_file("tests/integration.ts"));
        assert!(is_test_file("src\\__tests__\\suite.ts"));
    }

    #[test]
    fn is_test_file_rejects_substring_false_positives() {
        assert!(!is_test_file("src/specification.ts"));
        assert!(!is_test_file("src/latestest.ts"));
        assert!(!is_test_file("src/testimony.ts"));
    }

    #[test]
    fn line_complexity_ignores_non_code_languages() {
        assert_eq!(line_complexity(r#"{"if":true}"#, "json"), 0);
        assert_eq!(line_complexity("if (x) {}", "css"), 0);
    }

    #[test]
    fn analyze_file_counts_code_comments_and_complexity() {
        let dir = temp_test_dir("code-quality-analyze-file");
        let path = dir.join("sample.rs");
        fs::write(&path, "// comment\nlet x = 1;\nif x > 0 {\n}\n")
            .expect("failed to write fixture");

        let (code, comments, blanks, total, complexity) = analyze_file(&path, "rust");
        assert_eq!(code, 3);
        assert_eq!(comments, 1);
        assert_eq!(blanks, 0);
        assert_eq!(total, 4);
        assert_eq!(complexity, 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn walk_dir_skips_known_directories() {
        let dir = temp_test_dir("code-quality-walk-dir");
        fs::create_dir_all(dir.join("src")).expect("failed to create src dir");
        fs::create_dir_all(dir.join("node_modules/pkg"))
            .expect("failed to create node_modules dir");

        fs::write(dir.join("src/app.ts"), "export const x = 1;\n").expect("failed to write app.ts");
        fs::write(
            dir.join("node_modules/pkg/index.ts"),
            "export const y = 2;\n",
        )
        .expect("failed to write node_modules fixture");

        let mut files = Vec::new();
        walk_dir(&dir, &dir, &mut files);
        let normalized: Vec<String> = files.iter().map(|(p, _)| normalize(p)).collect();

        assert!(normalized.iter().any(|p| p.ends_with("src/app.ts")));
        assert!(!normalized.iter().any(|p| p.contains("node_modules")));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn analyze_code_quality_counts_only_strict_test_files() {
        let dir = temp_test_dir("code-quality-report-tests");
        fs::create_dir_all(dir.join("src")).expect("failed to create src dir");
        fs::create_dir_all(dir.join("tests")).expect("failed to create tests dir");

        fs::write(dir.join("src/main.ts"), "export const main = true;\n")
            .expect("failed to write main.ts");
        fs::write(
            dir.join("src/specification.ts"),
            "export const spec = true;\n",
        )
        .expect("failed to write specification.ts");
        fs::write(dir.join("src/app.test.ts"), "describe('x', () => {});\n")
            .expect("failed to write app.test.ts");
        fs::write(
            dir.join("tests/integration.ts"),
            "describe('i', () => {});\n",
        )
        .expect("failed to write tests/integration.ts");

        let report = analyze_code_quality(dir.to_string_lossy().to_string())
            .expect("analysis should succeed");

        // 4 recognized TypeScript files; only *.test.* and /tests/ should count as test files.
        assert_eq!(report.total_files, 4);
        assert_eq!(report.test_files, 2);

        let _ = fs::remove_dir_all(dir);
    }

    // ===== v0.8.8 quality ai helpers =====

    #[test]
    fn truncate_for_model_ai_no_op_when_under_cap() {
        let (out, truncated, original) = truncate_for_model_ai("hello", 100);
        assert_eq!(out, "hello");
        assert!(!truncated);
        assert_eq!(original, 5);
    }

    #[test]
    fn truncate_for_model_ai_emits_marker() {
        let (out, truncated, original) = truncate_for_model_ai(&"x".repeat(200), 50);
        assert!(truncated);
        assert_eq!(original, 200);
        assert!(out.contains("(truncated, original size 200 bytes)"));
    }

    #[test]
    fn truncate_for_model_ai_respects_utf8_boundary() {
        // 3-byte UTF-8 sequence — cap at 4 should land on the boundary.
        let s = "abc\u{1F600}def"; // a b c 😀 d e f
        let (out, truncated, _) = truncate_for_model_ai(s, 4);
        assert!(truncated);
        // No invalid UTF-8 (would panic otherwise).
        assert!(!out.is_empty());
    }
}
