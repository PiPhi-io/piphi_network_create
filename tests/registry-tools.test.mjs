import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareRegistryProposal,
  readAndVerifyRegistryProposal,
  verifyRegistryProposal,
} from "../dist/registry-tools.js";

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "piphi-registry-tools-"));
}

test("prepares a draft widget proposal bound to a signed artifact digest", async (t) => {
  const cwd = await workspace();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "package.source.json"), JSON.stringify({
    schema_version: "1",
    identity: { publisher_id: "io.example", package_id: "room-air", version: "0.2.0" },
    name: "Room Air",
    description: "Room air readings.",
    sdk_version_range: ">=0.6.1,<0.7",
    widgets: [{ id: "overview", binding_slots: [{ capability_requirements: ["co2"] }] }],
  }));
  await mkdir(path.join(cwd, "dist"));
  await writeFile(path.join(cwd, "dist", "room-air-0.2.0.manifest.json"), JSON.stringify({
    artifact: { digest: `sha256:${"a".repeat(64)}` },
  }));
  const result = await prepareRegistryProposal({
    cwd,
    kind: "widget",
    repoUrl: "https://github.com/example/room-air-widget",
    artifactManifest: "dist/room-air-0.2.0.manifest.json",
  });
  assert.equal(result.proposal.registry_id, "io.example.room-air");
  assert.equal(result.proposal.proposed_entry.artifact.integrity, `sha256:${"a".repeat(64)}`);
  assert.equal(result.proposal.proposed_entry.marketplace.governance.publication_status, "draft");
  assert.equal((await readAndVerifyRegistryProposal(result.outputPath)).some((finding) => finding.level === "error"), false);
});

test("prepares an integration proposal without changing its reviewed marketplace metadata", async (t) => {
  const cwd = await workspace();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  const marketplace = {
    metadata_version: 2,
    display_name: "Example Climate",
    summary: "Example climate integration.",
    category: "climate",
    device_types: ["sensor"], protocols: ["http"], regions: ["WW"], languages: ["en"], discovery_methods: ["manual"],
    connectivity: "local", offline_support: "full",
    publisher: { name: "Example", support_url: "https://example.com/support", security_contact: "security@example.com" },
    access: [], compatibility: [{ brand: "Example", model: "Climate" }],
    documentation_url: "https://example.com/docs", support_url: "https://example.com/support", changelog_url: "https://example.com/changelog",
    quality_tier: "unrated",
    governance: { schema_version: 1, publication_status: "draft", rollout_percent: 0, lifecycle_status: "active", qualification: { status: "unverified" } },
  };
  await writeFile(path.join(cwd, "src", "manifest.json"), JSON.stringify({
    id: "example-climate", name: "Example Climate", version: "1.2.3", description: "Climate data.", platforms: ["linux"], marketplace,
  }));
  const result = await prepareRegistryProposal({ cwd, kind: "integration", repoUrl: "https://github.com/example/climate" });
  assert.equal(result.proposal.manifest_path, "src/manifest.json");
  assert.deepEqual(result.proposal.proposed_entry.marketplace, marketplace);
});

test("rejects mutable refs and malformed widget integrity", () => {
  const findings = verifyRegistryProposal({
    schema_version: 1,
    kind: "widget",
    registry_id: "io.example.widget",
    version: "0.1.0",
    repo_url: "https://github.com/example/widget",
    manifest_path: "package.source.json",
    ref: "main",
    artifact_integrity: "sha256:nope",
    proposed_entry: {
      id: "io.example.widget", name: "Widget", version: "0.1.0", type: "widget", trust_level: "community", risk_level: "low",
      description: "Widget", platforms: ["web"], owner: "example", repo_name: "widget", repo_url: "https://github.com/example/widget",
      manifest_path: "package.source.json", maintainer: { name: "example" }, marketplace: {},
      artifact: { release_asset: "widget-0.1.0.zip", manifest_asset: "widget-0.1.0.manifest.json", integrity: "sha256:nope" },
    },
  });
  assert.ok(findings.some((finding) => finding.message.includes("Release ref")));
  assert.ok(findings.some((finding) => finding.message.includes("SHA-256")));
});
