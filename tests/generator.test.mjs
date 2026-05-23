import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCreate } from "../dist/generator.js";
import {
  addAuth,
  addDiscovery,
  addPoller,
  addReleaseWorkflow,
  addTelemetry,
  addWebhook,
  inspectProject,
  publishCheckProject,
  upgradeProject,
  validateProject,
} from "../dist/project-tools.js";
import { validateTemplatePack } from "../dist/template-packs.js";
import { assertMatchesSnapshot } from "./snapshot-helpers.mjs";

const languages = ["node", "python", "go"];
const testDir = path.dirname(fileURLToPath(import.meta.url));
const presets = [
  "minimal",
  "device",
  "sensor-device",
  "actuator-device",
  "cloud",
  "cloud-polling-api",
  "webhook-receiver",
  "protocol-bridge",
  "sidecar",
  "sidecar-worker",
  "platform-service",
];

test("generates every language and preset with a valid manifest contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-create-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const language of languages) {
    for (const preset of presets) {
      const projectName = `${language}-${preset}-runtime`;
      const outDir = path.join(root, projectName);
      await runCreate([
        projectName,
        "--language",
        language,
        "--preset",
        preset,
        "--domain",
        ["cloud", "cloud-polling-api", "webhook-receiver"].includes(preset)
          ? "cloud-api"
          : ["sidecar", "sidecar-worker", "platform-service"].includes(preset)
            ? "sidecar-service"
            : preset === "protocol-bridge"
              ? "bridge"
              : preset === "actuator-device"
                ? "actuator"
                : "sensor",
        "--out-dir",
        outDir,
        "--port",
        "9876",
        "--github-actions",
        "--force",
      ]);

      const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
      const commandExample = JSON.parse(await readFile(path.join(outDir, "examples", "command.json"), "utf8"));
      const behaviorMetadataPath = language === "go" ? "behaviors.json" : "src/behaviors.json";
      const behaviorMetadata = JSON.parse(await readFile(path.join(outDir, behaviorMetadataPath), "utf8"));
      assert.equal(manifest.metadata.generator, "piphi-network-create");
      assert.equal(manifest.metadata.scaffold_version, "0.2.0");
      assert.equal(manifest.metadata.preset, preset);
      assert.equal(manifest.$schema, "./schema/piphi-manifest.schema.json");
      assert.equal(manifest.runtime.linux.container.ports[0].container, 9876);
      assert.deepEqual(manifest.api.required, ["health", "entities", "command", "config", "ui_config"]);
      assert.equal(commandExample.contract_version, "automation.runtime.command.v1");
      assert.equal(commandExample.target.config_id, "demo-device");
      assert.deepEqual(commandExample.capability_requirements, ["device.refresh"]);
      assert.equal(behaviorMetadata.behaviorSchemaVersion, "integration.behaviors.v2");
      assert.equal(behaviorMetadata.templates[0].config.execution.dispatchMode, "runtime");
      assert.equal(behaviorMetadata.templates[0].config.policies.execution.dispatchMode, "runtime");
      assert.equal(behaviorMetadata.devices[0].actions[0].runtime.endpoint, "/command");
      assert.equal(behaviorMetadata.devices[0].actions[0].safety.riskLevel, "low");
      assert.ok(behaviorMetadata.devices[0].actions[0].capabilityRequirements.length >= 1);

      assert.equal(existsSync(path.join(outDir, "schema", "piphi-manifest.schema.json")), true);
      assert.equal(existsSync(path.join(outDir, "docs", "contract.md")), true);
      assert.equal(existsSync(path.join(outDir, "examples", "curl.sh")), true);
      assert.equal(existsSync(path.join(outDir, "examples", "config.json")), true);
      assert.equal(existsSync(path.join(outDir, "examples", "command.json")), true);
      assert.equal(existsSync(path.join(outDir, "examples", "discovery-request.json")), true);
      assert.equal(existsSync(path.join(outDir, "examples", "entity-response.json")), true);
      assert.equal(existsSync(path.join(outDir, ".github", "workflows", "ci.yml")), true);

      if (preset === "cloud" || preset === "cloud-polling-api") {
        assert.equal(manifest.config.editable_fields.includes("api_key"), true);
        assert.equal("sync_cloud" in manifest.commands, true);
      }
      if (preset === "sidecar" || preset === "sidecar-worker") {
        assert.equal("restart_worker" in manifest.commands, true);
      }
      if (preset === "platform-service") {
        assert.deepEqual(manifest.platforms, ["linux", "windows", "macos"]);
        assert.equal(manifest.kind, "platform_service");
        assert.equal(manifest.runtime.windows.type, "proxy");
        assert.equal(manifest.runtime.windows.proxy.managed_helpers[0].supervisor, "pm2");
        assert.equal(manifest.runtime.macos.proxy.managed_helpers[0].docker_mode.supported, true);
      }

      if (language === "node") {
        assert.equal(existsSync(path.join(outDir, "src", "contract.ts")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "contract.test.ts")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "conformance.test.ts")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "fixtures", "contract-conformance.json")), true);
      } else if (language === "python") {
        const packageDir = projectName.replaceAll("-", "_");
        assert.equal(existsSync(path.join(outDir, "src", packageDir, "contract.py")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "test_contract.py")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "test_conformance.py")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "fixtures", "contract-conformance.json")), true);
      } else {
        assert.equal(existsSync(path.join(outDir, "contract.go")), true);
        assert.equal(existsSync(path.join(outDir, "contract_test.go")), true);
        assert.equal(existsSync(path.join(outDir, "conformance_test.go")), true);
        assert.equal(existsSync(path.join(outDir, "tests", "fixtures", "contract-conformance.json")), true);
      }

      const findings = await validateProject({ cwd: outDir });
      assert.deepEqual(
        findings.filter((finding) => finding.level === "error"),
        [],
        `${language}/${preset} should validate`,
      );
    }
  }
});

test("project tools add professional add-ons and upgrade metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-create-tools-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outDir = path.join(root, "tools-runtime");
  await runCreate([
    "tools-runtime",
    "--language",
    "node",
    "--preset",
    "minimal",
    "--out-dir",
    outDir,
    "--force",
  ]);

  await addWebhook({ cwd: outDir });
  await addPoller({ cwd: outDir, interval: 45 });
  await addAuth("oauth2", { cwd: outDir });
  await addDiscovery("mdns", { cwd: outDir });
  await addTelemetry(["battery_percent", "rssi_dbm"], { cwd: outDir });
  await addReleaseWorkflow({ cwd: outDir });
  const upgradeFindings = await upgradeProject({ cwd: outDir });
  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));

  assert.equal(manifest.api.endpoints.webhook, "/webhooks/:source");
  assert.equal(manifest.runtime.linux.discovery.method, "mdns");
  assert.equal(manifest.runtime.linux.container.environment.POLL_INTERVAL_SECONDS, "45");
  assert.equal(manifest.metadata.auth_strategy, "oauth2");
  assert.equal("battery_percent" in manifest.capabilities, true);
  assert.equal(existsSync(path.join(outDir, "docs", "addons", "webhook.md")), true);
  assert.equal(existsSync(path.join(outDir, ".github", "workflows", "release.yml")), true);
  assert.equal(existsSync(path.join(outDir, "scripts", "release.py")), true);
  assert.equal(existsSync(path.join(outDir, "docs", "release.md")), true);
  const releaseWorkflow = await readFile(path.join(outDir, ".github", "workflows", "release.yml"), "utf8");
  assert.match(releaseWorkflow, /DOCKERHUB_USERNAME/);
  assert.match(releaseWorkflow, /DOCKERHUB_TOKEN/);
  assert.match(releaseWorkflow, /docker\/build-push-action@v6/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release@v2/);
  assert.equal(upgradeFindings.some((finding) => finding.level === "info"), true);

  const inspection = await inspectProject({ cwd: outDir });
  assert.equal(inspection.language, "node");
  assert.equal(inspection.preset, "minimal");
  assert.equal(inspection.files.conformanceFixture, true);

  const draftFindings = await publishCheckProject({ cwd: outDir });
  assert.equal(draftFindings.some((finding) => finding.level === "error"), true);

  manifest.version = "1.0.0";
  manifest.runtime.linux.container.image = "docker.io/piphi/tools-runtime:1.0.0";
  manifest.image = "docker.io/piphi/tools-runtime:1.0.0";
  manifest.maintainer = {
    name: "Example Integrations Team",
    website: "https://example.com",
  };
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const publishFindings = await publishCheckProject({ cwd: outDir });
  assert.deepEqual(
    publishFindings.filter((finding) => finding.level === "error"),
    [],
    "publish-check should pass after release metadata is customized",
  );
});

test("local template packs can add rendered files and defaults", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-create-template-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const templateDir = path.join(root, "vendor-template");
  await mkdir(path.join(templateDir, "files", "docs"), { recursive: true });
  await writeFile(
    path.join(templateDir, "template.json"),
    `${JSON.stringify(
      {
        name: "vendor-cloud-template",
        description: "Cloud vendor integration notes.",
        languages: ["node"],
        kind: "integration",
        preset: "cloud-polling-api",
        domain: "cloud-api",
        variables: [{ name: "vendor", default: "Vendor" }],
        files: [
          {
            path: "docs/{{vars.vendor}}.md",
            template: "files/docs/vendor.md",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(templateDir, "files", "docs", "vendor.md"),
    "# {{vars.vendor}}\n\nGenerated for {{title}} using {{preset}} on port {{port}}.\n",
  );

  const templateFindings = await validateTemplatePack(templateDir);
  assert.deepEqual(templateFindings.filter((finding) => finding.level === "error"), []);

  const outDir = path.join(root, "kaiterra-runtime");
  await runCreate([
    "kaiterra-runtime",
    "--template",
    templateDir,
    "--set",
    "vendor=Kaiterra",
    "--out-dir",
    outDir,
    "--release-workflow",
    "--force",
  ]);

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
  const vendorDoc = await readFile(path.join(outDir, "docs", "Kaiterra.md"), "utf8");
  assert.equal(manifest.metadata.preset, "cloud-polling-api");
  assert.equal(manifest.metadata.domain, "cloud-api");
  assert.equal(existsSync(path.join(outDir, ".github", "workflows", "release.yml")), true);
  assert.equal(existsSync(path.join(outDir, "scripts", "release.py")), true);
  assert.match(vendorDoc, /# Kaiterra/);
  assert.match(vendorDoc, /using cloud-polling-api/);
});

test("representative generated files match golden snapshots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-create-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cases = [
    {
      language: "node",
      preset: "cloud-polling-api",
      domain: "cloud-api",
      files: ["manifest.json", "src/contract.ts", "tests/conformance.test.ts", "README.md", ".github/workflows/ci.yml"],
    },
    {
      language: "python",
      preset: "webhook-receiver",
      domain: "cloud-api",
      files: ["manifest.json", "src/python_webhook_receiver_runtime/contract.py", "tests/test_conformance.py", "scripts/validate.py"],
    },
    {
      language: "go",
      preset: "sidecar-worker",
      domain: "sidecar-service",
      files: ["manifest.json", "contract.go", "conformance_test.go", "cmd/validate/main.go"],
    },
  ];

  for (const fixture of cases) {
    const projectName = `${fixture.language}-${fixture.preset}-runtime`;
    const outDir = path.join(root, projectName);
    await runCreate([
      projectName,
      "--language",
      fixture.language,
      "--preset",
      fixture.preset,
      "--domain",
      fixture.domain,
      "--out-dir",
      outDir,
      "--port",
      "9988",
      "--github-actions",
      "--force",
    ]);

    for (const file of fixture.files) {
      const actual = await readFile(path.join(outDir, file), "utf8");
      const snapshotPath = path.join(
        testDir,
        "snapshots",
        fixture.language,
        fixture.preset,
        `${file.replaceAll("/", "__")}.snap`,
      );
      await assertMatchesSnapshot(actual, snapshotPath);
    }
  }
});
