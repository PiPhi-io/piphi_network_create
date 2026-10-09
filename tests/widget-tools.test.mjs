import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWidgetProject,
  linkWidgetProject,
  packWidgetProject,
  validateWidgetProject,
  verifyWidgetLink,
  widgetDevManifest,
} from "../dist/widget-tools.js";

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "piphi-cli-widget-"));
}

test("creates a modern SDK widget project and validates its built entry", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = await createWidgetProject("Air Monitor", {
    cwd: root,
    publisherId: "io.piphi",
    integrationId: "air-monitor-local-api",
  });
  const source = JSON.parse(await readFile(path.join(target, "package.source.json"), "utf8"));
  assert.equal(source.identity.package_id, "air-monitor");
  assert.equal(source.widgets[0].runtime, "sandboxed_bundle");
  assert.match(await readFile(path.join(target, "src", "widget.ts"), "utf8"), /piphi-network-widget-sdk/);

  let findings = await validateWidgetProject({ cwd: target });
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("Run the widget build")));
  await writeFile(path.join(target, "assets", "widget.mjs"), "export {};\n");
  findings = await validateWidgetProject({ cwd: target });
  assert.equal(findings.some((finding) => finding.level === "error"), false);
  const packed = await packWidgetProject(target, { check: true });
  assert.match(packed.digest, /^sha256:[a-f0-9]{64}$/);
  const devManifest = await widgetDevManifest(target);
  assert.equal(devManifest.entry, "assets/widget.mjs");
  assert.equal(devManifest.id, "io.piphi.air-monitor.overview");
});

test("links separate repositories through package identity and verifies the relationship", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const widget = await createWidgetProject("Room Climate", {
    cwd: root,
    publisherId: "io.piphi",
    integrationId: "room-climate-local-api",
  });
  const integration = path.join(root, "integration");
  await mkdir(path.join(integration, "src"), { recursive: true });
  await writeFile(path.join(integration, "src", "manifest.json"), `${JSON.stringify({ id: "room-climate-local-api", version: "0.4.0" }, null, 2)}\n`);

  const linked = await linkWidgetProject(widget, integration, true);
  assert.equal(linked.registryId, "io.piphi.room-climate");
  const manifest = JSON.parse(await readFile(linked.manifestPath, "utf8"));
  assert.deepEqual(manifest.ui.experience_packages, [{
    registry_id: "io.piphi.room-climate",
    version_range: ">=0.1,<1",
    auto_install: true,
  }]);
  const findings = await verifyWidgetLink(widget, integration);
  assert.equal(findings.some((finding) => finding.level === "error"), false);

  await linkWidgetProject(widget, integration, false);
  const relinked = JSON.parse(await readFile(linked.manifestPath, "utf8"));
  assert.equal(relinked.ui.experience_packages.length, 1);
  assert.equal(relinked.ui.experience_packages[0].auto_install, false);
});

test("rejects mismatched integration ownership", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const widget = await createWidgetProject("Vendor Widget", {
    cwd: root,
    publisherId: "io.vendor",
    integrationId: "expected-integration",
  });
  const integration = path.join(root, "manifest.json");
  await writeFile(integration, `${JSON.stringify({
    id: "different-integration",
    ui: { experience_packages: [{ registry_id: "io.vendor.vendor-widget", version_range: ">=0.1,<1", auto_install: true }] },
  }, null, 2)}\n`);
  const findings = await verifyWidgetLink(widget, integration);
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("different-integration")));
});
