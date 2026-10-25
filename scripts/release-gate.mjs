#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { resolveTarget, sidecarPlatformPackage } from "./target-triple.js";
import { NODE_VERSION, nodeArchiveSha256, nodeBinaryRelPath } from "./node-runtime.js";
import { APP_NAME_LOWER } from "../src/lib/brand.ts";
import { assertCargoBundleTargets } from "./cargo-bundle-targets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const requireClean =
  args.has("--require-clean") || process.env.PACKETBENCH_RELEASE_REQUIRE_CLEAN === "1";
const requireSigning =
  args.has("--require-signing") || process.env.PACKETBENCH_RELEASE_REQUIRE_SIGNING === "1";
const requireUpdater =
  args.has("--require-updater") || process.env.PACKETBENCH_RELEASE_REQUIRE_UPDATER === "1";

const checks = [];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
}

function warn(name, detail) {
  checks.push({ ok: null, name, detail });
}

function envAny(names) {
  return names.some((name) => process.env[name]?.trim());
}

function envAll(names) {
  return names.every((name) => process.env[name]?.trim());
}

const pkg = readJson("package.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;

try {
  const manifestPath = path.join(root, "src-tauri/Cargo.toml");
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    ),
  );
  const targets = assertCargoBundleTargets(
    metadata,
    manifestPath,
    tauri.mainBinaryName ?? APP_NAME_LOWER,
  );
  pass(
    "Cargo installer targets",
    `${targets.application} is the only binary; ${targets.example} is a gated developer example`,
  );
} catch (error) {
  fail("Cargo installer targets", error instanceof Error ? error.message : String(error));
}

if (pkg.version === tauri.version && pkg.version === cargoVersion) {
  pass("Version alignment", `package.json, tauri.conf.json, and Cargo.toml are ${pkg.version}`);
} else {
  fail(
    "Version alignment",
    `package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion ?? "(missing)"}`,
  );
}

if (tauri.bundle?.active === true) {
  pass("Tauri bundling enabled");
} else {
  fail("Tauri bundling enabled", "src-tauri/tauri.conf.json bundle.active must be true");
}

const beforeBuild = String(tauri.build?.beforeBuildCommand ?? "");
if (beforeBuild.includes("prebundle") && beforeBuild.includes("build")) {
  pass("Before-build pipeline", beforeBuild);
} else {
  fail("Before-build pipeline", "beforeBuildCommand should run prebundle and frontend build");
}

const resources = tauri.bundle?.resources ?? {};
const resourceValues = Object.values(resources).join("\n");
if (
  resourceValues.includes("agent-sidecar/dist") &&
  resourceValues.includes("agent-sidecar/node_modules")
) {
  pass("Sidecar resources bundled");
} else {
  fail(
    "Sidecar resources bundled",
    "agent-sidecar dist and node_modules must be included as resources",
  );
}

if (
  Array.isArray(tauri.bundle?.externalBin) &&
  tauri.bundle.externalBin.includes("binaries/node")
) {
  pass("Bundled Node runtime configured");
} else {
  fail("Bundled Node runtime configured", "bundle.externalBin must include binaries/node");
}

if (exists("agent-sidecar/dist/index.js")) {
  pass("Sidecar dist exists", "agent-sidecar/dist/index.js");
} else {
  fail("Sidecar dist exists", "Run pnpm run prebundle or pnpm run sidecar:build before packaging");
}

// Cross-arch consistency: the staged Node runtime and the installed sidecar
// native platform package must both match the resolved build target.
let releaseTarget = null;
try {
  releaseTarget = resolveTarget({ argv: process.argv, env: process.env });
  pass("Build target resolved", releaseTarget);
} catch (err) {
  fail("Build target resolved", err instanceof Error ? err.message : String(err));
}

if (releaseTarget) {
  const isWindowsTarget = releaseTarget.includes("-windows-");
  const platformPkg = sidecarPlatformPackage(releaseTarget);
  const platformDirName = platformPkg.split("/")[1];
  const claudeRel = path.join(
    "agent-sidecar",
    "node_modules",
    "@anthropic-ai",
    platformDirName,
    isWindowsTarget ? "claude.exe" : "claude",
  );
  const claudeAbs = path.join(root, claudeRel);
  if (fs.existsSync(claudeAbs) && fs.statSync(claudeAbs).size > 0) {
    pass("Sidecar native platform package matches target", `${platformPkg} (${claudeRel})`);
  } else {
    fail(
      "Sidecar native platform package matches target",
      `${claudeRel} missing or empty — run pnpm run sidecar:prune for target ${releaseTarget}`,
    );
  }

  const scopeAbs = path.join(root, "agent-sidecar", "node_modules", "@anthropic-ai");
  let foreign = [];
  try {
    foreign = fs
      .readdirSync(scopeAbs)
      .filter((name) => /^claude-agent-sdk-/.test(name) && name !== platformDirName);
  } catch (err) {
    fail(
      "No foreign sidecar platform packages",
      `could not read ${scopeAbs}: ${err instanceof Error ? err.message : String(err)}`,
    );
    foreign = null;
  }
  if (foreign !== null) {
    if (foreign.length === 0) {
      pass("No foreign sidecar platform packages");
    } else {
      fail(
        "No foreign sidecar platform packages",
        `found ${foreign.join(", ")} alongside target ${releaseTarget} — the bundle would ship the wrong native sidecar`,
      );
    }
  }

  // The staged Node runtime is embedded in the installer as an externalBin and
  // is code-signed along with it, so "the file exists" is not a useful gate —
  // any binary sitting at that path would ship. Re-verify it against the
  // reviewed digest pinned in scripts/node-runtime.js.
  verifyStagedNodeRuntime(releaseTarget);
}

function verifyStagedNodeRuntime(triple) {
  const label = "Bundled Node runtime verified";
  const nodeRel = nodeBinaryRelPath(triple);
  const nodeAbs = path.join(root, nodeRel);
  const markerRel = `${nodeRel}.sha256`;
  const markerAbs = `${nodeAbs}.sha256`;

  if (!fs.existsSync(nodeAbs)) {
    fail(label, `${nodeRel} missing — run pnpm run fetch-node for ${triple}`);
    return;
  }
  if (!fs.existsSync(markerAbs)) {
    fail(
      label,
      `${markerRel} missing — cannot prove ${nodeRel} is the reviewed Node ` +
        `${NODE_VERSION} runtime; re-run pnpm run fetch-node`,
    );
    return;
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerAbs, "utf8"));
  } catch (err) {
    fail(label, `${markerRel} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const pinnedArchiveSha = nodeArchiveSha256(triple);
  const onDiskSha = createHash("sha256").update(fs.readFileSync(nodeAbs)).digest("hex");
  const problems = [];

  if (marker.nodeVersion !== NODE_VERSION) {
    problems.push(`marker records Node ${marker.nodeVersion}, pinned version is ${NODE_VERSION}`);
  }
  if (marker.target !== triple) {
    problems.push(`marker records target ${marker.target}, build target is ${triple}`);
  }
  if (marker.archiveSha256 !== pinnedArchiveSha) {
    problems.push(
      `runtime was extracted from an archive with sha256 ` +
        `${String(marker.archiveSha256).slice(0, 16)}..., not the pinned ` +
        `${pinnedArchiveSha.slice(0, 16)}...`,
    );
  }
  if (onDiskSha !== marker.sha256) {
    problems.push(
      `on-disk sha256 ${onDiskSha.slice(0, 16)}... does not match the marker's ` +
        `${String(marker.sha256).slice(0, 16)}... — the binary changed after it was fetched`,
    );
  }

  if (problems.length === 0) {
    pass(label, `${nodeRel} — Node ${NODE_VERSION}, sha256 ${onDiskSha.slice(0, 16)}...`);
  } else {
    fail(label, `${problems.join("; ")}. Delete ${nodeRel} and re-run pnpm run fetch-node`);
  }
}

if (exists("dev/updater-setup.md")) {
  pass("Updater runbook present", "dev/updater-setup.md");
} else {
  warn("Updater runbook present", "dev/updater-setup.md is missing");
}

if (requireClean) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (status.length === 0) pass("Git tree clean");
    else fail("Git tree clean", status.split("\n").slice(0, 12).join("\n"));
  } catch (err) {
    fail("Git tree clean", err instanceof Error ? err.message : String(err));
  }
}

if (requireSigning) {
  // Installer code-signing (Windows Authenticode / Apple Developer ID) and
  // updater signing (Tauri's minisign keypair) are unrelated credentials that
  // protect different things. TAURI_SIGNING_PRIVATE_KEY is the *updater* key;
  // it signs the update manifest and says nothing about whether the installer
  // will carry a trusted publisher signature. Counting it here produced a
  // "Signing credentials present" PASS on a build with zero Authenticode
  // configuration — so it is deliberately excluded. Updater signing has its own
  // check under --require-updater.
  const windowsBundle = tauri.bundle?.windows ?? {};
  const macBundle = tauri.bundle?.macOS ?? {};

  const authenticodeConfig = ["certificateThumbprint", "certificatePath", "signCommand"].filter(
    (key) => typeof windowsBundle[key] === "string" && windowsBundle[key].trim(),
  );
  const authenticodeEnv = [
    "WINDOWS_SIGNTOOL_CERT_SHA1",
    "WINDOWS_SIGNING_CERT_PATH",
    "WINDOWS_CERTIFICATE_THUMBPRINT",
    "WINDOWS_CERTIFICATE_PATH",
    "WINDOWS_CODESIGN_CERTIFICATE_PATH",
    "TAURI_BUNDLER_SIGN_COMMAND",
    "TAURI_SIGNTOOL_PATH",
  ].filter((name) => process.env[name]?.trim());
  const hasAuthenticode = authenticodeConfig.length > 0 || authenticodeEnv.length > 0;
  const authenticodeDetail = [
    ...authenticodeConfig.map((key) => `bundle.windows.${key}`),
    ...authenticodeEnv,
  ].join(", ");

  const appleConfig = ["signingIdentity", "providerShortName"].filter(
    (key) => typeof macBundle[key] === "string" && macBundle[key].trim(),
  );
  const appleEnv = [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PATH",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
  ].filter((name) => process.env[name]?.trim());
  const hasApple = appleConfig.length > 0 || appleEnv.length > 0;
  const appleDetail = [...appleConfig.map((key) => `bundle.macOS.${key}`), ...appleEnv].join(", ");

  // Which credential is actually required depends on what is being built.
  const isWindowsBuild = releaseTarget?.includes("-windows-") ?? false;
  const isAppleBuild = releaseTarget?.includes("-apple-") ?? false;

  if (isWindowsBuild) {
    if (hasAuthenticode) {
      pass("Windows Authenticode credentials", authenticodeDetail);
    } else {
      fail(
        "Windows Authenticode credentials",
        "no Authenticode certificate configured — set bundle.windows.certificateThumbprint/" +
          "certificatePath/signCommand in tauri.conf.json, or WINDOWS_SIGNTOOL_CERT_SHA1 / " +
          "WINDOWS_SIGNING_CERT_PATH / TAURI_BUNDLER_SIGN_COMMAND in the environment. " +
          "TAURI_SIGNING_PRIVATE_KEY is the updater key and does not count.",
      );
    }
  } else if (isAppleBuild) {
    if (hasApple) {
      pass("Apple code-signing credentials", appleDetail);
    } else {
      fail(
        "Apple code-signing credentials",
        "no Developer ID signal — set bundle.macOS.signingIdentity or APPLE_SIGNING_IDENTITY / " +
          "APPLE_CERTIFICATE / APPLE_API_KEY. TAURI_SIGNING_PRIVATE_KEY is the updater key and " +
          "does not count.",
      );
    }
  } else {
    pass(
      "Installer code-signing credentials",
      `${releaseTarget ?? "unknown target"} produces unsigned Linux packages; nothing to check`,
    );
  }

  if ((isWindowsBuild && !hasAuthenticode) || (isAppleBuild && !hasApple)) {
    if (envAny(["TAURI_SIGNING_PRIVATE_KEY"])) {
      warn(
        "Updater key is not a code-signing certificate",
        "TAURI_SIGNING_PRIVATE_KEY is set but no platform code-signing credential is — " +
          "the minisign updater keypair signs update manifests, not the installer",
      );
    }
  }
}

if (requireUpdater) {
  const updater = tauri.plugins?.updater ?? {};
  const updaterConfigReady =
    updater.active === true &&
    typeof updater.pubkey === "string" &&
    updater.pubkey.trim().length > 0 &&
    Array.isArray(updater.endpoints) &&
    updater.endpoints.length > 0;
  const updaterSecretReady = envAll([
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]);

  if (updaterConfigReady && updaterSecretReady) {
    pass("Updater signing configured");
  } else {
    fail(
      "Updater signing configured",
      "Updater beta requires active plugins.updater config with pubkey/endpoints plus TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD env",
    );
  }
}

let failed = 0;
let warned = 0;
for (const check of checks) {
  const marker = check.ok === true ? "PASS" : check.ok === false ? "FAIL" : "WARN";
  if (check.ok === false) failed += 1;
  if (check.ok === null) warned += 1;
  const detail = check.detail ? ` - ${check.detail}` : "";
  console.log(`${marker} ${check.name}${detail}`);
}

if (failed > 0) {
  console.error(`\nRelease gate failed: ${failed} failed, ${warned} warning(s).`);
  process.exit(1);
}

console.log(`\nRelease gate passed: ${checks.length - warned} checks, ${warned} warning(s).`);
