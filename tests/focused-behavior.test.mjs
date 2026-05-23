import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCreate } from "../dist/generator.js";
import {
  addAuth,
  addBinaryBuild,
  addCapability,
  addCommand,
  addDiscovery,
  addPoller,
  addReleaseWorkflow,
  addRoute,
  addTelemetry,
  addWebhook,
  doctorProject,
  fixProject,
  hasErrors,
  inspectProject,
  publishCheckProject,
  upgradeProject,
  validateProject,
} from "../dist/project-tools.js";
import {
  loadTemplatePack,
  renderTemplatePackFiles,
  templatePackDefaults,
  templateVariableValues,
  validateTemplatePack,
} from "../dist/template-packs.js";

test("focused scaffold generation behavior", async (t) => {
  await t.test("node pnpm scaffolds package manager metadata and Docker corepack", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--package-manager", "pnpm"] });
    const packageJson = await readJson(path.join(outDir, "package.json"));
    const dockerfile = await readFile(path.join(outDir, "Dockerfile"), "utf8");
    assert.equal(packageJson.packageManager, "pnpm@10.0.0");
    assert.match(dockerfile, /corepack enable/);
    assert.match(dockerfile, /pnpm install/);
  });

  await t.test("node yarn scaffolds package manager metadata and yarn commands", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--package-manager", "yarn"] });
    const packageJson = await readJson(path.join(outDir, "package.json"));
    const readme = await readFile(path.join(outDir, "README.md"), "utf8");
    assert.equal(packageJson.packageManager, "yarn@4.0.0");
    assert.match(readme, /yarn install/);
    assert.match(readme, /yarn dev/);
  });

  await t.test("python uv scaffolds uv-oriented local commands", async (t) => {
    const outDir = await scaffold(t, { language: "python", extra: ["--python-manager", "uv"] });
    const readme = await readFile(path.join(outDir, "README.md"), "utf8");
    assert.match(readme, /uv venv/);
    assert.match(readme, /uv pip install -e \.\[dev\]/);
  });

  await t.test("python pdm scaffolds pdm-oriented local commands", async (t) => {
    const outDir = await scaffold(t, { language: "python", extra: ["--python-manager", "pdm"] });
    const readme = await readFile(path.join(outDir, "README.md"), "utf8");
    assert.match(readme, /pdm install -G dev/);
    assert.match(readme, /pdm run pytest/);
  });

  await t.test("go scaffold uses the expected module path", async (t) => {
    const outDir = await scaffold(t, { name: "go-module-runtime", language: "go" });
    const goMod = await readFile(path.join(outDir, "go.mod"), "utf8");
    assert.match(goMod, /module github\.com\/piphi-network\/go-module-runtime/);
  });

  await t.test("sidecar kind defaults to sidecar-worker and sidecar-service", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--kind", "sidecar"] });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.metadata.preset, "sidecar-worker");
    assert.equal(manifest.metadata.domain, "sidecar-service");
    assert.equal("restart_worker" in manifest.commands, true);
  });

  await t.test("scaffolds behavior metadata v2", async (t) => {
    const outDir = await scaffold(t, { language: "node", preset: "actuator-device", domain: "actuator" });
    const behavior = await readJson(path.join(outDir, "src", "behaviors.json"));
    assert.equal(behavior.behaviorSchemaVersion, "integration.behaviors.v2");
    assert.equal(behavior.templates[0].config.execution.dispatchMode, "runtime");
    assert.equal(behavior.templates[0].config.policies.execution.dispatchMode, "runtime");
    assert.equal(behavior.devices[0].actions[0].targeting.fanoutSafe, true);
    assert.equal(behavior.devices[0].actions[0].targeting.supportsMultiTarget, true);
    assert.equal(behavior.devices[0].actions[0].targeting.scopes.includes("all_matching"), true);
    assert.equal(behavior.devices[0].targeting.fanout.allowedModes.includes("capability"), true);
    assert.equal(behavior.devices[0].actions[0].safety.riskLevel, "low");
    assert.equal(behavior.devices[0].actions[0].safety.liveRunAllowed, true);
    assert.equal(behavior.devices[0].actions[0].failure.strategy, "retry_then_continue");
    assert.equal(behavior.devices[0].actions[0].failure.continueOnPartialFailure, true);
  });

  await t.test("actuator preset adds action capability and safety config", async (t) => {
    const outDir = await scaffold(t, { language: "node", preset: "actuator-device", domain: "actuator" });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.capabilities.set_power.kind, "action");
    assert.equal("set_power" in manifest.commands, true);
    assert.equal(manifest.config.editable_fields.includes("safety_mode"), true);
  });

  await t.test("protocol bridge preset adds bridge metadata", async (t) => {
    const outDir = await scaffold(t, { language: "python", preset: "protocol-bridge", domain: "bridge" });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.config.editable_fields.includes("bridge_address"), true);
    assert.equal(manifest.config.editable_fields.includes("protocol"), true);
    assert.equal("resync_bridge" in manifest.commands, true);
  });

  await t.test("cloud polling preset adds API settings and sync command", async (t) => {
    const outDir = await scaffold(t, { language: "go", preset: "cloud-polling-api", domain: "cloud-api" });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.config.editable_fields.includes("base_url"), true);
    assert.equal(manifest.config.editable_fields.includes("api_key"), true);
    assert.equal("sync_cloud" in manifest.commands, true);
  });

  await t.test("release workflow can be generated during create", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--release-workflow"] });
    const releaseWorkflow = await readFile(path.join(outDir, ".github", "workflows", "release.yml"), "utf8");
    const releaseScript = await readFile(path.join(outDir, "scripts", "release.py"), "utf8");
    assert.match(releaseWorkflow, /release_type:/);
    assert.match(releaseWorkflow, /docker\/build-push-action@v6/);
    assert.match(releaseWorkflow, /softprops\/action-gh-release@v2/);
    assert.match(releaseWorkflow, /DOCKERHUB_TOKEN/);
    assert.match(releaseScript, /class SemVer/);
    assert.match(releaseScript, /PACKAGE_VERSION_RE/);
  });

  await t.test("release workflow is opt-in", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    assert.equal(existsSync(path.join(outDir, ".github", "workflows", "release.yml")), false);
  });

  await t.test("python binary build can be generated during create", async (t) => {
    const outDir = await scaffold(t, { language: "python", extra: ["--binary-build"] });
    const buildScript = await readFile(path.join(outDir, "scripts", "build_binary.py"), "utf8");
    const workflow = await readFile(path.join(outDir, ".github", "workflows", "build-binary.yml"), "utf8");
    const pyproject = await readFile(path.join(outDir, "pyproject.toml"), "utf8");
    assert.match(buildScript, /PyInstaller/);
    assert.match(buildScript, /python-focused-runtime/);
    assert.match(workflow, /pip install -e \.\[dev,binary\]/);
    assert.match(pyproject, /pyinstaller>=6\.10\.0/);
  });

  await t.test("node binary build can be generated during create", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--binary-build"] });
    const buildScript = await readFile(path.join(outDir, "scripts", "build-binary.mjs"), "utf8");
    const workflow = await readFile(path.join(outDir, ".github", "workflows", "build-binary.yml"), "utf8");
    const packageJson = await readJson(path.join(outDir, "package.json"));
    assert.match(buildScript, /experimental-sea-config/);
    assert.match(buildScript, /postject/);
    assert.equal(packageJson.scripts["build:binary"], "node scripts/build-binary.mjs");
    assert.equal("esbuild" in packageJson.devDependencies, true);
    assert.equal("postject" in packageJson.devDependencies, true);
    assert.match(workflow, /build:binary/);
  });

  await t.test("go binary build can be generated during create", async (t) => {
    const outDir = await scaffold(t, { language: "go", extra: ["--binary-build"] });
    const buildScript = await readFile(path.join(outDir, "scripts", "build_binary.py"), "utf8");
    const workflow = await readFile(path.join(outDir, ".github", "workflows", "build-binary.yml"), "utf8");
    assert.match(buildScript, /go", "build", "-trimpath"/);
    assert.match(buildScript, /go-focused-runtime/);
    assert.match(workflow, /go test \.\/\.\.\./);
    assert.match(workflow, /python scripts\/build_binary.py --clean/);
  });

  await t.test("dry-run previews without writing the target directory", async (t) => {
    const root = await tempRoot(t);
    const outDir = path.join(root, "dry-run-runtime");
    await runCreate(["dry-run-runtime", "--language", "node", "--out-dir", outDir, "--dry-run"]);
    assert.equal(existsSync(outDir), false);
  });
});

test("focused project maintenance behavior", async (t) => {
  await t.test("validate reports a missing manifest", async (t) => {
    const root = await tempRoot(t);
    const findings = await validateProject({ cwd: root });
    assert.equal(hasErrors(findings), true);
    assert.match(findings[0].message, /manifest\.json is missing/);
  });

  await t.test("fix recreates the manifest schema file", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await rm(path.join(outDir, "schema", "piphi-manifest.schema.json"));
    const findings = await fixProject({ cwd: outDir });
    assert.equal(existsSync(path.join(outDir, "schema", "piphi-manifest.schema.json")), true);
    assert.equal(findings.some((finding) => finding.message.includes("Created schema/piphi-manifest.schema.json")), true);
  });

  await t.test("fix corrects Dockerfile exposed port drift", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--port", "8222"] });
    await writeFile(path.join(outDir, "Dockerfile"), "FROM node:22-alpine\nEXPOSE 1234\n");
    await fixProject({ cwd: outDir });
    const dockerfile = await readFile(path.join(outDir, "Dockerfile"), "utf8");
    assert.match(dockerfile, /EXPOSE 8222/);
  });

  await t.test("fix restores missing required endpoints", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    const manifest = await readManifest(outDir);
    manifest.api.required = [];
    delete manifest.api.endpoints.health;
    await writeManifest(outDir, manifest);
    await fixProject({ cwd: outDir });
    const fixed = await readManifest(outDir);
    assert.equal(fixed.api.required.includes("health"), true);
    assert.equal(fixed.api.endpoints.health, "/health");
  });

  await t.test("add-command adds action capability and command metadata", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addCommand("refresh_devices", { cwd: outDir, description: "Refresh all devices." });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.capabilities.refresh_devices.kind, "action");
    assert.equal(manifest.commands.refresh_devices.description, "Refresh all devices.");
  });

  await t.test("add-capability preserves unit metadata", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addCapability("humidity_percent", { cwd: outDir, unit: "%" });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.capabilities.humidity_percent.unit, "%");
  });

  await t.test("add-route normalizes endpoint paths", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addRoute("metrics", "metrics", { cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.api.endpoints.metrics, "/metrics");
  });

  await t.test("add-auth api-key adds api_key config", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addAuth("api-key", { cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.config.editable_fields.includes("api_key"), true);
    assert.equal(manifest.metadata.auth_strategy, "api-key");
  });

  await t.test("add-auth oauth2 adds OAuth config fields", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addAuth("oauth2", { cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.config.editable_fields.includes("client_id"), true);
    assert.equal(manifest.config.editable_fields.includes("client_secret"), true);
    assert.equal(manifest.config.editable_fields.includes("token_url"), true);
  });

  await t.test("add-poller defaults to a 60 second interval", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addPoller({ cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.runtime.linux.container.environment.POLL_INTERVAL_SECONDS, "60");
    assert.equal("poll_latency_ms" in manifest.capabilities, true);
  });

  await t.test("add-discovery writes discovery strategy and docs", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addDiscovery("ssdp", { cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.runtime.linux.discovery.method, "ssdp");
    assert.equal(existsSync(path.join(outDir, "docs", "addons", "discovery.md")), true);
  });

  await t.test("add-telemetry adds each metric and docs", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addTelemetry(["battery_percent", "rssi_dbm"], { cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal("battery_percent" in manifest.capabilities, true);
    assert.equal("rssi_dbm" in manifest.capabilities, true);
    assert.equal(existsSync(path.join(outDir, "docs", "addons", "telemetry.md")), true);
  });

  await t.test("add-webhook adds receiver endpoint and config fields", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addWebhook({ cwd: outDir });
    const manifest = await readManifest(outDir);
    assert.equal(manifest.api.endpoints.webhook, "/webhooks/:source");
    assert.equal(manifest.config.editable_fields.includes("webhook_secret"), true);
  });

  await t.test("doctor warns when README is missing", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await rm(path.join(outDir, "README.md"));
    const findings = await doctorProject({ cwd: outDir });
    assert.equal(findings.some((finding) => finding.message === "README.md is missing."), true);
  });

  await t.test("inspect reports release workflow file presence", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    let inspection = await inspectProject({ cwd: outDir });
    assert.equal(inspection.files.releaseWorkflow, false);
    await addReleaseWorkflow({ cwd: outDir });
    inspection = await inspectProject({ cwd: outDir });
    assert.equal(inspection.files.releaseWorkflow, true);
    assert.equal(inspection.files.releaseScript, true);
  });

  await t.test("binary-build command adds Python executable build files", async (t) => {
    const outDir = await scaffold(t, { language: "python" });
    await addBinaryBuild({ cwd: outDir });
    const inspection = await inspectProject({ cwd: outDir });
    const pyproject = await readFile(path.join(outDir, "pyproject.toml"), "utf8");
    const gitignore = await readFile(path.join(outDir, ".gitignore"), "utf8");
    assert.equal(inspection.files.binaryBuildScript, true);
    assert.equal(inspection.files.binaryBuildWorkflow, true);
    assert.match(pyproject, /binary = \[/);
    assert.match(pyproject, /pyinstaller>=6\.10\.0/);
    assert.match(gitignore, /build\//);
    assert.match(gitignore, /\*\.spec/);
  });

  await t.test("binary-build command adds Node executable build files", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await addBinaryBuild({ cwd: outDir });
    const inspection = await inspectProject({ cwd: outDir });
    const packageJson = await readJson(path.join(outDir, "package.json"));
    assert.equal(inspection.files.binaryBuildScript, true);
    assert.equal(inspection.files.binaryBuildWorkflow, true);
    assert.equal(packageJson.scripts["build:binary"], "node scripts/build-binary.mjs");
    assert.equal("esbuild" in packageJson.devDependencies, true);
  });

  await t.test("binary-build command adds Go executable build files", async (t) => {
    const outDir = await scaffold(t, { language: "go" });
    await addBinaryBuild({ cwd: outDir });
    const inspection = await inspectProject({ cwd: outDir });
    const buildScript = await readFile(path.join(outDir, "scripts", "build_binary.py"), "utf8");
    assert.equal(inspection.files.binaryBuildScript, true);
    assert.equal(inspection.files.binaryBuildWorkflow, true);
    assert.match(buildScript, /go", "build"/);
  });

  await t.test("publish-check requires release workflow", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    await makeReleaseReady(outDir, "docker.io/piphi/release-required:1.0.0");
    const findings = await publishCheckProject({ cwd: outDir });
    assert.equal(findings.some((finding) => finding.message.includes(".github/workflows/release.yml")), true);
  });

  await t.test("publish-check accepts GHCR images", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--release-workflow"] });
    await makeReleaseReady(outDir, "ghcr.io/piphi/ghcr-runtime:1.0.0");
    const findings = await publishCheckProject({ cwd: outDir });
    assert.deepEqual(findings.filter((finding) => finding.level === "error"), []);
  });

  await t.test("publish-check accepts Docker Hub short images", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--release-workflow"] });
    await makeReleaseReady(outDir, "piphi/dockerhub-runtime:1.0.0");
    const findings = await publishCheckProject({ cwd: outDir });
    assert.deepEqual(findings.filter((finding) => finding.level === "error"), []);
  });

  await t.test("publish-check rejects unsupported registries", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--release-workflow"] });
    await makeReleaseReady(outDir, "quay.io/piphi/runtime:1.0.0");
    const findings = await publishCheckProject({ cwd: outDir });
    assert.equal(findings.some((finding) => finding.message.includes("Docker Hub or GHCR")), true);
  });

  await t.test("validate catches action capabilities without commands", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    const manifest = await readManifest(outDir);
    manifest.capabilities.orphan_action = { kind: "action" };
    await writeManifest(outDir, manifest);
    const findings = await validateProject({ cwd: outDir });
    assert.equal(findings.some((finding) => finding.message.includes("orphan_action")), true);
  });

  await t.test("validate catches Dockerfile port drift", async (t) => {
    const outDir = await scaffold(t, { language: "node", extra: ["--port", "8333"] });
    await writeFile(path.join(outDir, "Dockerfile"), "FROM node:22-alpine\nEXPOSE 1999\n");
    const findings = await validateProject({ cwd: outDir });
    assert.equal(findings.some((finding) => finding.message.includes("Dockerfile must expose manifest port 8333")), true);
  });

  await t.test("upgrade restores stale scaffold metadata", async (t) => {
    const outDir = await scaffold(t, { language: "node" });
    const manifest = await readManifest(outDir);
    manifest.metadata.scaffold_version = "0.0.1";
    await writeManifest(outDir, manifest);
    await upgradeProject({ cwd: outDir });
    const upgraded = await readManifest(outDir);
    assert.equal(upgraded.metadata.scaffold_version, "0.2.0");
  });
});

test("focused template pack behavior", async (t) => {
  await t.test("missing template.json is reported", async (t) => {
    const root = await tempRoot(t);
    const findings = await validateTemplatePack(root);
    assert.equal(hasErrorMatching(findings, /template\.json is missing/), true);
  });

  await t.test("invalid template JSON is reported", async (t) => {
    const root = await tempRoot(t);
    await writeFile(path.join(root, "template.json"), "{nope");
    const findings = await validateTemplatePack(root);
    assert.equal(hasErrorMatching(findings, /could not be parsed/), true);
  });

  await t.test("valid inline-content template passes", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "inline",
      files: [{ path: "docs/inline.md", content: "# Inline\n" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.deepEqual(findings.filter((finding) => finding.level === "error"), []);
  });

  await t.test("missing template name is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, { files: [{ path: "docs/a.md", content: "A" }] });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /non-empty name/), true);
  });

  await t.test("empty file list is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, { name: "empty", files: [] });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /at least one file/), true);
  });

  await t.test("unsupported top-level language is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-language",
      languages: ["ruby"],
      files: [{ path: "docs/a.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsupported template language 'ruby'/), true);
  });

  await t.test("unsupported kind is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-kind",
      kind: "library",
      files: [{ path: "docs/a.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsupported template kind 'library'/), true);
  });

  await t.test("unsupported preset is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-preset",
      preset: "enterprise",
      files: [{ path: "docs/a.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsupported template preset 'enterprise'/), true);
  });

  await t.test("unsupported domain is rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-domain",
      domain: "space",
      files: [{ path: "docs/a.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsupported template domain 'space'/), true);
  });

  await t.test("unsafe output paths are rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "unsafe-output",
      files: [{ path: "../escape.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsafe template output path/), true);
  });

  await t.test("unsafe source paths are rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "unsafe-source",
      files: [{ path: "docs/a.md", template: "../secret.md" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsafe template source path/), true);
  });

  await t.test("missing source files are rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "missing-source",
      files: [{ path: "docs/a.md", template: "files/missing.md" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /is missing/), true);
  });

  await t.test("content and template cannot both be set", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "ambiguous",
      files: [{ path: "docs/a.md", template: "files/a.md", content: "A" }],
    });
    await mkdir(path.join(templateDir, "files"), { recursive: true });
    await writeFile(path.join(templateDir, "files", "a.md"), "A");
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /cannot define both content and template/), true);
  });

  await t.test("invalid variable names are rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-variable",
      variables: [{ name: "bad-name" }],
      files: [{ path: "docs/a.md", content: "A" }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Invalid template variable name/), true);
  });

  await t.test("unsupported file language filters are rejected", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "bad-file-language",
      files: [{ path: "docs/a.md", content: "A", languages: ["rust"] }],
    });
    const findings = await validateTemplatePack(templateDir);
    assert.equal(hasErrorMatching(findings, /Unsupported language 'rust'/), true);
  });

  await t.test("loadTemplatePack throws for invalid packs", async (t) => {
    const templateDir = await writeTemplatePack(t, {
      name: "invalid-load",
      files: [{ path: "/absolute.md", content: "A" }],
    });
    await assert.rejects(() => loadTemplatePack(templateDir), /Template pack is invalid/);
  });

  await t.test("templatePackDefaults uses supported metadata", async () => {
    const defaults = templatePackDefaults({
      name: "defaults",
      languages: ["node", "go"],
      kind: "sidecar",
      preset: "sidecar-worker",
      domain: "sidecar-service",
      files: [],
      directory: "/tmp/template",
    });
    assert.deepEqual(defaults, {
      language: "node",
      kind: "sidecar",
      preset: "sidecar-worker",
      domain: "sidecar-service",
    });
  });

  await t.test("templateVariableValues applies defaults and CLI overrides", async () => {
    const values = templateVariableValues(
      {
        name: "vars",
        variables: [
          { name: "vendor", default: "Acme" },
          { name: "tier", default: "dev" },
        ],
        files: [],
        directory: "/tmp/template",
      },
      { vendor: "Kaiterra" },
    );
    assert.deepEqual(values, { vendor: "Kaiterra", tier: "dev" });
  });

  await t.test("renderTemplatePackFiles filters by language", async () => {
    const files = await renderTemplatePackFiles(
      {
        name: "filtered",
        files: [
          { path: "docs/node.md", content: "Node", languages: ["node"] },
          { path: "docs/go.md", content: "Go", languages: ["go"] },
        ],
        directory: "/tmp/template",
      },
      { language: "node" },
    );
    assert.deepEqual(files.map((file) => file.path), ["docs/node.md"]);
  });

  await t.test("renderTemplatePackFiles renders nested variables in paths and content", async () => {
    const files = await renderTemplatePackFiles(
      {
        name: "render",
        files: [{ path: "docs/{{vars.vendor}}-{{slug}}.md", content: "# {{vars.vendor}}\n{{title}}\n" }],
        directory: "/tmp/template",
      },
      { slug: "air-sensor", title: "Air Sensor", language: "node", vars: { vendor: "Kaiterra" } },
    );
    assert.equal(files[0].path, "docs/Kaiterra-air-sensor.md");
    assert.equal(files[0].contents, "# Kaiterra\nAir Sensor\n");
  });
});

async function scaffold(t, options = {}) {
  const root = await tempRoot(t);
  const name = options.name ?? `${options.language ?? "node"}-focused-runtime`;
  const outDir = path.join(root, name);
  const args = [
    name,
    "--language",
    options.language ?? "node",
    "--out-dir",
    outDir,
    "--force",
  ];
  if (options.preset) {
    args.push("--preset", options.preset);
  }
  if (options.domain) {
    args.push("--domain", options.domain);
  }
  args.push(...(options.extra ?? []));
  await runCreate(args);
  return outDir;
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-focused-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readManifest(outDir) {
  return readJson(path.join(outDir, "manifest.json"));
}

async function writeManifest(outDir, manifest) {
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function makeReleaseReady(outDir, image) {
  const manifest = await readManifest(outDir);
  manifest.version = "1.0.0";
  manifest.image = image;
  manifest.runtime.linux.container.image = image;
  manifest.maintainer = {
    name: "Example Integrations Team",
    website: "https://example.com",
  };
  await writeManifest(outDir, manifest);
}

async function writeTemplatePack(t, manifest) {
  const root = await tempRoot(t);
  await writeFile(path.join(root, "template.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function hasErrorMatching(findings, pattern) {
  return findings.some((finding) => finding.level === "error" && pattern.test(finding.message));
}
