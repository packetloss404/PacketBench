#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report-only");
// Executing the gates is the point of the section, but a status snapshot taken
// during release setup should not take half an hour. --report-only implies it.
const skipGates =
  args.has("--skip-gates") || reportOnly || process.env.PACKETBENCH_RELEASE_SKIP_GATES === "1";
const gateTimeoutMs = Number(process.env.PACKETBENCH_RELEASE_GATE_TIMEOUT_MS ?? 45 * 60 * 1000);

/**
 * The quality gates, executed in order and gated on exit code.
 *
 * These ten are exactly what `pnpm run check` runs, one level down:
 * `check` = preflight + e2e + sidecar:check + check:tauri-schema + rust:check +
 * rust:test, and `preflight` = format:check + lint:src + test + build +
 * remoteagents:check. So
 * `check` is reported as a row derived from these results rather than executed
 * — executing the composite too would run everything a second time.
 * `compositeGateRow` re-derives that relationship from package.json on every
 * run and refuses to claim the composite if the scripts have drifted.
 */
const requiredQualityScripts = [
  ["format:check", "pnpm run format:check"],
  ["lint:src", "pnpm run lint:src"],
  ["test", "pnpm test"],
  ["build", "pnpm run build"],
  ["e2e", "pnpm run e2e"],
  ["sidecar:check", "pnpm run sidecar:check"],
  ["check:tauri-schema", "pnpm run check:tauri-schema"],
  ["rust:check", "pnpm run rust:check"],
  ["rust:test", "pnpm run rust:test"],
  // Added to `preflight` (and so to `check`) by d6238633 on 2026-09-01 but
  // never listed here, which left the composite-gate derivation below
  // permanently unresolvable: it reported `remoteagents:check` as an
  // unexpected leaf and downgraded itself to a warning on every run.
  ["remoteagents:check", "pnpm run remoteagents:check"],
];

const compositeGate = ["check", "pnpm run check"];

const artifactGlobsByTarget = {
  windows: ["release/bundle/nsis/*setup.exe", "release/bundle/msi/*.msi"],
  macos: ["release/bundle/dmg/*.dmg"],
  linux: ["release/bundle/deb/*.deb", "release/bundle/appimage/*.AppImage"],
};

function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function envPresent(names) {
  return names.filter((name) => Boolean(process.env[name]));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function hostTarget() {
  switch (os.platform()) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

/**
 * WSL reports platform "linux", so host detection asks for Linux bundles even
 * though the build that produced them ran on the Windows side. Detecting it
 * lets the artifact check explain itself instead of just going red.
 */
function isWsl() {
  return (
    os.platform() === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()))
  );
}

/**
 * Translate a Windows path to its WSL mount when we are running under WSL, so
 * a `target-dir` written for the Windows-side build is reachable from here.
 * Returns the input unchanged when it is not a drive-letter path.
 */
function toWslPath(candidate) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(candidate);
  if (!drive || !isWsl()) return candidate;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
}

/**
 * Read Cargo's `build.target-dir` out of src-tauri/.cargo/config.toml.
 *
 * `cargo metadata` reports this correctly, but it needs Cargo on PATH — and on
 * this project's WSL side Cargo is the Windows MSVC toolchain and is not.
 * Parsing the key directly keeps the bundle root correct without Cargo, which
 * matters because the file is git-excluded and machine-local: nothing else in
 * the repo records where builds actually land.
 *
 * Deliberately targeted matches rather than a TOML parser, but both spellings
 * Cargo accepts are handled: a `[build]` table, and the dotted `build.target-dir`
 * form. Missing the dotted form would send readiness back to the default root
 * and fail a correct release build.
 */
function cargoConfigTargetDir() {
  const configPath = path.join(root, "src-tauri", ".cargo", "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, "utf8");

    const buildSection = /^\s*\[build\]\s*$([\s\S]*?)(?=^\s*\[|\s*$(?![\s\S]))/m.exec(text);
    if (buildSection) {
      const key = /^\s*target[-_]dir\s*=\s*["']([^"']+)["']/m.exec(buildSection[1]);
      if (key) return key[1];
    }

    // Dotted form, valid only in the top-level preamble — after a [section]
    // header the key would belong to that table, not to `build`.
    const preamble = text.split(/^\s*\[/m)[0];
    const dotted = /^\s*build\.target[-_]dir\s*=\s*["']([^"']+)["']/m.exec(preamble);
    return dotted ? dotted[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve where Cargo/Tauri actually write bundles, and record how we know.
 *
 * The provenance matters: this repo redirects output to a machine-local
 * directory, so a readiness run that silently searched the default
 * `src-tauri/target` would report "no artifacts" after a perfectly good release
 * build — a false negative, and the mirror image of the false positives this
 * script was fixed to stop producing.
 */
function resolveBundleRoot() {
  if (process.env.CARGO_TARGET_DIR?.trim()) {
    return {
      dir: path.resolve(root, toWslPath(process.env.CARGO_TARGET_DIR.trim())),
      source: "CARGO_TARGET_DIR",
    };
  }

  const configured = cargoConfigTargetDir();
  if (configured) {
    return {
      dir: path.resolve(root, toWslPath(configured)),
      source: "src-tauri/.cargo/config.toml [build] target-dir",
    };
  }

  try {
    const output = execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
      ],
      {
        // Cargo discovers `.cargo/config.toml` from its working directory,
        // not from `--manifest-path`, so run where Tauri invokes Cargo.
        cwd: path.join(root, "src-tauri"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const metadata = JSON.parse(output);
    if (typeof metadata.target_directory === "string") {
      return { dir: path.resolve(toWslPath(metadata.target_directory)), source: "cargo metadata" };
    }
  } catch {
    // Keep readiness usable on machines where Cargo is not on PATH.
  }

  return { dir: path.join(root, "src-tauri", "target"), source: "default (src-tauri/target)" };
}

function displayPath(absolutePath) {
  const relative = path.relative(root, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll("\\", "/")
    : absolutePath;
}

const bundleRoot = resolveBundleRoot();
const cargoTarget = bundleRoot.dir;

function findFiles(globPattern) {
  const normalized = globPattern.replaceAll("\\", "/");
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex === -1) {
    const absolutePath = path.join(cargoTarget, normalized);
    return existsSync(absolutePath) ? [absolutePath] : [];
  }

  const directory = normalized.slice(0, wildcardIndex);
  const filePattern = normalized.slice(wildcardIndex);
  const directoryPath = path.join(cargoTarget, directory);
  if (!existsSync(directoryPath)) return [];

  const suffix = filePattern.slice(1);
  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => path.join(directoryPath, entry));
}

function latestByMtime(files) {
  return files
    .map((file) => ({
      file,
      mtimeMs: statSync(file).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ file }) => file);
}

function printSection(title, items) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  for (const item of items) {
    const suffix = item.detail ? ` - ${item.detail}` : "";
    console.log(`[${item.status}] ${item.label}${suffix}`);
  }
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoVersion =
  readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8").match(
    /^version\s*=\s*"([^"]+)"/m,
  )?.[1] ?? null;
const releaseVersion = String(packageJson.version ?? "").trim();
const scripts = packageJson.scripts ?? {};
const bundle = tauriConfig.bundle ?? {};
const macosBundle = bundle.macOS ?? {};
const windowsBundle = bundle.windows ?? {};
const updaterConfig = tauriConfig.plugins?.updater ?? {};
const knownTargets = Object.keys(artifactGlobsByTarget);
const targetOverride = process.env.PACKETBENCH_RELEASE_TARGET?.trim();
const target = targetOverride || hostTarget();
const targetIsKnown = knownTargets.includes(target);
const targetSource = targetOverride
  ? "PACKETBENCH_RELEASE_TARGET"
  : `host detection (${os.platform()}${isWsl() ? ", WSL" : ""})`;

const metadata = [
  {
    // Cargo.toml is the third manifest Tauri reads; release-gate.mjs has always
    // checked all three, so check all three here too.
    status:
      packageJson.version === tauriConfig.version && packageJson.version === cargoVersion
        ? "PASS"
        : "FAIL",
    label: "package.json, tauri.conf.json, and Cargo.toml versions match",
    detail: `${packageJson.version} / ${tauriConfig.version} / ${cargoVersion ?? "(missing)"}`,
  },
  {
    status: bundle.active ? "PASS" : "FAIL",
    label: "Tauri bundle output is enabled",
    detail: `bundle.active=${String(bundle.active)}`,
  },
  {
    status: bundle.targets ? "PASS" : "FAIL",
    label: "Tauri bundle targets are configured",
    detail: `targets=${JSON.stringify(bundle.targets)}`,
  },
];

const windowsSigningSignals = [
  windowsBundle.certificateThumbprint,
  windowsBundle.certificatePath,
  windowsBundle.signCommand,
  ...envPresent([
    "WINDOWS_CERTIFICATE_THUMBPRINT",
    "WINDOWS_CERTIFICATE_PATH",
    "WINDOWS_CODESIGN_CERTIFICATE_PATH",
    "TAURI_BUNDLER_SIGN_COMMAND",
    "TAURI_SIGNTOOL_PATH",
  ]),
];

const macosSigningSignals = [
  macosBundle.signingIdentity,
  macosBundle.providerShortName,
  ...envPresent([
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PATH",
  ]),
];

const macosNotarySignals = envPresent([
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
]);

const updaterSigningSignals = envPresent([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

const signing = [
  {
    status: windowsSigningSignals.some(hasValue) ? "PASS" : "WARN",
    label: "Windows Authenticode signing signal",
    detail: windowsSigningSignals.some(hasValue)
      ? "config/env present"
      : "no signing identity signal found",
  },
  {
    status: macosSigningSignals.some(hasValue) ? "PASS" : "WARN",
    label: "macOS code-signing signal",
    detail: macosSigningSignals.some(hasValue)
      ? "config/env present"
      : "no Developer ID signal found",
  },
  {
    status: macosNotarySignals.length >= 2 ? "PASS" : "WARN",
    label: "macOS notarization signal",
    detail: macosNotarySignals.length
      ? `${macosNotarySignals.join(", ")} present`
      : "no notarization env signal found",
  },
  {
    status: updaterSigningSignals.length === 2 ? "PASS" : "WARN",
    label: "Tauri updater signing env",
    detail:
      updaterSigningSignals.length === 2
        ? "private key and password env present"
        : "TAURI_SIGNING_PRIVATE_KEY and password not both present",
  },
];

const manifestCandidates = [
  process.env.PACKETBENCH_UPDATER_MANIFEST,
  path.join(cargoTarget, "release", "bundle", "latest.json"),
  path.join(cargoTarget, "release", "bundle", "nsis", "latest.json"),
  path.join(cargoTarget, "release", "bundle", "dmg", "latest.json"),
]
  .filter(Boolean)
  .map((candidate) => (path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)));

const existingManifest = manifestCandidates.find((candidate) => existsSync(candidate));

let manifestDetail = "no latest.json found in known bundle locations";
let manifestStatus = "WARN";
if (existingManifest) {
  try {
    const manifest = JSON.parse(readFileSync(existingManifest, "utf8"));
    const hasRequiredFields =
      Boolean(manifest.version) &&
      Boolean(manifest.pub_date) &&
      typeof manifest.platforms === "object";
    manifestStatus = hasRequiredFields ? "PASS" : "FAIL";
    manifestDetail = hasRequiredFields
      ? displayPath(existingManifest)
      : `${displayPath(existingManifest)} is missing version, pub_date, or platforms`;
  } catch (error) {
    manifestStatus = "FAIL";
    manifestDetail = `${displayPath(existingManifest)} is not valid JSON: ${error.message}`;
  }
}

const updater = [
  {
    status:
      updaterConfig.active &&
      hasValue(updaterConfig.pubkey) &&
      Array.isArray(updaterConfig.endpoints) &&
      updaterConfig.endpoints.length > 0
        ? "PASS"
        : "WARN",
    label: "Tauri updater config",
    detail:
      updaterConfig.active === true
        ? "plugins.updater is active"
        : "plugins.updater is not active in tauri.conf.json",
  },
  {
    status: manifestStatus,
    label: "Updater manifest",
    detail: manifestDetail,
  },
];

// An unrecognised target used to fall back to every platform's globs at once,
// so a typo'd override (or an undetectable host) could be satisfied by a stale
// bundle for the wrong OS. Refuse to guess instead.
const artifactPatterns = targetIsKnown ? artifactGlobsByTarget[target] : [];
const allArtifacts = latestByMtime(
  artifactPatterns.flatMap(findFiles).filter((file) => {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0;
  }),
);
// Tauri separates product, version and architecture with underscores. Match
// the complete version field: 0.14.80 and 0.14.8-beta.1 are not 0.14.8.
const artifacts = allArtifacts.filter((file) =>
  path.basename(file).includes(`_${releaseVersion}_`),
);

// Host detection under WSL asks for Linux bundles for a build that ran on the
// Windows side. Say so, rather than leaving a red line nobody can act on.
const wslHint =
  !targetOverride && isWsl() && target === "linux"
    ? ". Running under WSL, where Node reports linux — if the bundle was produced by the " +
      "Windows-side build, set PACKETBENCH_RELEASE_TARGET=windows"
    : "";

const artifactSection = [
  !targetIsKnown
    ? {
        status: "FAIL",
        label: `Bundle artifacts for ${target}`,
        detail: targetOverride
          ? `PACKETBENCH_RELEASE_TARGET="${target}" is not one of ${knownTargets.join(", ")} — refusing to search every platform's artifacts, which can pass on a bundle for the wrong OS`
          : `could not map host platform ${os.platform()} to a bundle target; set PACKETBENCH_RELEASE_TARGET to one of ${knownTargets.join(", ")}`,
      }
    : {
        status: artifacts.length > 0 ? "PASS" : "FAIL",
        label: `Bundle artifacts for ${target}`,
        detail: artifacts.length
          ? artifacts.slice(0, 4).map(displayPath).join(", ")
          : allArtifacts.length
            ? `found artifacts, but none match version ${releaseVersion}: ${allArtifacts.slice(0, 4).map(displayPath).join(", ")}${wslHint}`
            : `expected nonempty version ${releaseVersion} installer file under ${cargoTarget} (bundle root from ${bundleRoot.source}) matching one of ${artifactPatterns.join(", ")}${wslHint}`,
      },
];

/** Script names a package script shells out to, e.g. `pnpm run lint:src`. */
function referencedScripts(body) {
  return [...String(body ?? "").matchAll(/\bpnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/g)].map(
    (m) => m[1],
  );
}

/**
 * Report `pnpm run check` from the results of the gates that constitute it,
 * but only when package.json still says it is constituted that way.
 */
function compositeGateRow(executed) {
  const [scriptName, command] = compositeGate;
  if (!scripts[scriptName]) {
    return { status: "FAIL", label: command, detail: `package script "${scriptName}" is missing` };
  }

  const leaves = new Set();
  for (const name of referencedScripts(scripts[scriptName])) {
    if (name === "preflight" && scripts.preflight) {
      for (const inner of referencedScripts(scripts.preflight)) leaves.add(inner);
    } else {
      leaves.add(name);
    }
  }
  const expected = new Set(requiredQualityScripts.map(([name]) => name));
  const missing = [...expected].filter((name) => !leaves.has(name));
  const extra = [...leaves].filter((name) => !expected.has(name));
  if (missing.length || extra.length) {
    return {
      status: "WARN",
      label: command,
      detail:
        `cannot be derived — "${scriptName}" no longer expands to the gates above ` +
        `(unrun: ${extra.join(", ") || "none"}; not in check: ${missing.join(", ") || "none"}). ` +
        `Update requiredQualityScripts in scripts/release-readiness.mjs.`,
    };
  }

  if (executed.some((row) => row.status === "WARN")) {
    return {
      status: "WARN",
      label: command,
      detail: "composite of the gates above; not evaluated because some were not executed",
    };
  }
  const failed = executed.filter((row) => row.status === "FAIL");
  return failed.length
    ? { status: "FAIL", label: command, detail: `${failed.length} constituent gate(s) failed` }
    : {
        status: "PASS",
        label: command,
        detail: "composite of the gates above (not re-executed — it runs exactly these)",
      };
}

/** Execute one gate and gate on its exit code. */
function runGate(scriptName, command) {
  if (!scripts[scriptName]) {
    return { status: "FAIL", label: command, detail: `package script "${scriptName}" is missing` };
  }
  if (skipGates) {
    return {
      status: "WARN",
      label: command,
      detail: `NOT EXECUTED (${reportOnly ? "--report-only" : "--skip-gates"}) — "${scriptName}" is defined but unverified`,
    };
  }

  process.stdout.write(`  ${command} ... `);
  const startedAt = Date.now();
  const result = spawnSync("pnpm", ["run", scriptName], {
    cwd: root,
    encoding: "utf8",
    timeout: gateTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.error) {
    process.stdout.write(`ERROR (${seconds}s)\n`);
    return {
      status: "FAIL",
      label: command,
      detail: `could not run (${seconds}s): ${result.error.message}`,
    };
  }
  if (result.status === 0) {
    process.stdout.write(`ok (${seconds}s)\n`);
    return { status: "PASS", label: command, detail: `exit 0 in ${seconds}s` };
  }

  process.stdout.write(`FAILED (${seconds}s)\n`);
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.trim())
    .slice(-25)
    .join("\n");
  if (tail) {
    console.log(tail.replace(/^/gm, "    | "));
  }
  const how = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
  return { status: "FAIL", label: command, detail: `${how} after ${seconds}s` };
}

console.log("PacketBench Release Readiness");
console.log(`Target: ${target} (from ${targetSource})`);
console.log(`Bundle root: ${cargoTarget} (from ${bundleRoot.source})`);
console.log(`Mode: ${reportOnly ? "report-only" : "gate"}`);

if (skipGates) {
  console.log(
    `\nQuality gates: NOT EXECUTED — pass no flags to run them (they are the ` +
      `only evidence the build is actually green).`,
  );
} else {
  console.log(`\nExecuting ${requiredQualityScripts.length} quality gates (this takes a while):`);
}
const executedGates = requiredQualityScripts.map(([scriptName, command]) =>
  runGate(scriptName, command),
);
const gates = [...executedGates, compositeGateRow(executedGates)];

const sections = [
  ["Release Metadata", metadata],
  ["Signing Signals", signing],
  ["Updater Readiness", updater],
  ["Bundle Artifacts", artifactSection],
  ["Required Quality Gates", gates],
];

for (const [title, items] of sections) {
  printSection(title, items);
}

const allItems = sections.flatMap(([, items]) => items);
const failCount = allItems.filter((item) => item.status === "FAIL").length;
const warnCount = allItems.filter((item) => item.status === "WARN").length;

console.log(`\nSummary: ${failCount} fail, ${warnCount} warn`);

if (failCount > 0 && !reportOnly) {
  process.exit(1);
}
