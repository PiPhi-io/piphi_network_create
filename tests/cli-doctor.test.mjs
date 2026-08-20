import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { runCreate } from "../dist/generator.js";

test("package exposes the unified piphi executable", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.bin.piphi, "dist/index.js");
  assert.equal(packageJson.dependencies["@piphi-network/integration-doctor"], "^0.2.0");

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /create \[name\]/);
  assert.match(help.stdout, /doctor \[options\]/);
});

test("piphi doctor combines project and live runtime checks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "piphi-cli-doctor-"));
  const projectDir = path.join(root, "doctor-runtime");
  t.after(() => rm(root, { recursive: true, force: true }));

  await runCreate([
    "doctor-runtime",
    "--language",
    "node",
    "--out-dir",
    projectDir,
    "--force",
  ]);

  const server = http.createServer((request, response) => {
    const payload = responseFor(request.method ?? "GET", request.url ?? "/");
    response.writeHead(payload.status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.equal(typeof address, "object");
  const result = await runCli([
    "doctor",
    "-C",
    projectDir,
    "--url",
    `http://127.0.0.1:${address.port}`,
  ]);

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Project looks healthy/);
  assert.match(result.stdout, /PASS health route/);
  assert.match(result.stdout, /PASS config sync route/);
  assert.match(result.stdout, /Summary: 12 passed, 2 warnings, 0 failed/);
});

function responseFor(method, url) {
  if (method === "GET" && (url === "/health" || url === "/diagnostics")) {
    return { status: 200, body: { status: "ok" } };
  }
  if (method === "GET" && url === "/ui-config") {
    return { status: 200, body: { schema: {}, uiSchema: {} } };
  }
  if (method === "GET" && url === "/discover") {
    return { status: 200, body: { devices: [] } };
  }
  if (method === "GET" && url === "/state") {
    return { status: 200, body: { status: "ready" } };
  }
  if (method === "GET" && url === "/entities") {
    return { status: 200, body: { entities: [] } };
  }
  if (method === "GET" && url === "/events") {
    return { status: 200, body: { events: [{ id: "device.updated" }] } };
  }
  if (method === "POST" && url === "/config") {
    return {
      status: 200,
      body: {
        status: "configured",
        config_id: "doctor-sample-config",
        container_id: "doctor-payload-container",
      },
    };
  }
  if (method === "POST" && url === "/config/sync") {
    return { status: 200, body: { status: "synced", applied: [], removed: [] } };
  }
  if (method === "POST" && url === "/deconfigure") {
    return { status: 200, body: { status: "deconfigured", removed: true } };
  }
  return { status: 404, body: { error: "not found" } };
}

async function runCli(args) {
  const child = spawn(process.execPath, [path.resolve("dist/index.js"), ...args], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}
