import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";

type JsonObject = Record<string, unknown>;

export type WidgetFinding = {
  level: "error" | "warning" | "info";
  message: string;
};

export type CreateWidgetOptions = {
  cwd?: string;
  outDir?: string;
  publisherId?: string;
  integrationId?: string;
};

export type ValidateWidgetOptions = {
  cwd?: string;
  integration?: string;
};

const PACKAGE_SOURCE = "package.source.json";
const SIGNING_CONTEXT = Buffer.from("piphi-widget-package-manifest-v1\0", "utf8");

export async function createWidgetProject(name: string, options: CreateWidgetOptions = {}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const slug = slugify(name);
  const target = path.resolve(cwd, options.outDir ?? slug);
  if (existsSync(target)) throw new Error(`Target already exists: ${target}`);
  const publisherId = String(options.publisherId ?? "com.example").trim();
  const integrationId = String(options.integrationId ?? "").trim();
  if (!publisherId) throw new Error("publisher id cannot be empty");

  await Promise.all([
    mkdir(path.join(target, "src"), { recursive: true }),
    mkdir(path.join(target, "assets"), { recursive: true }),
    mkdir(path.join(target, "test"), { recursive: true }),
  ]);

  const packageSource: JsonObject = {
    schema_version: "1",
    identity: { publisher_id: publisherId, package_id: slug, version: "0.1.0" },
    name,
    description: `${name} dashboard widget.`,
    origin: integrationId ? "integration" : "standalone",
    ...(integrationId ? {
      owning_integration_id: integrationId,
      requires_integrations: [{ integration_id: integrationId, version_range: ">=0.1,<1", optional: false }],
      recommended_for_integrations: [integrationId],
    } : {}),
    sdk_version_range: ">=0.6.1,<0.7",
    widgets: [{
      id: "overview",
      name: `${name} Overview`,
      description: `${name} at a glance.`,
      runtime: "sandboxed_bundle",
      entry: "assets/widget.mjs",
      presentation: {
        contract_version: "1",
        shell: "core",
        content_surface: "transparent",
        typography: "core",
        appearance_controls: ["icon", "title", "surface", "opacity", "radius", "shadow"],
      },
      interaction_targets: [{ id: "card", label: `${name} details`, kind: "card", allowed_actions: ["more-info", "popout", "refresh"], default_action: "more-info" }],
      binding_slots: [{ id: "primary", label: "Primary value", required: true, binding_modes: ["read"], value_kinds: ["numeric", "text", "boolean", "enum"], capability_requirements: [], ...(integrationId ? { compatible_integration_ids: [integrationId] } : {}) }],
      default_column_span: 4,
      default_row_span: 3,
    }],
  };

  const packageJson = {
    name: `@${publisherId.replaceAll(".", "-")}/widget-${slug}`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "node scripts/build.mjs",
      test: "npm run build && node --test test/*.test.mjs",
      validate: "npm test && piphi widget validate",
    },
    devDependencies: { esbuild: "0.25.10", "piphi-network-widget-sdk": "0.6.1" },
    engines: { node: ">=22" },
  };

  await mkdir(path.join(target, "scripts"), { recursive: true });
  await Promise.all([
    writeJson(path.join(target, PACKAGE_SOURCE), packageSource),
    writeJson(path.join(target, "package.json"), packageJson),
    writeFile(path.join(target, "src", "widget.ts"), widgetSource(name), "utf8"),
    writeFile(path.join(target, "scripts", "build.mjs"), buildScript(), "utf8"),
    writeFile(path.join(target, "test", "widget.test.mjs"), widgetTest(), "utf8"),
    writeFile(path.join(target, ".gitignore"), "node_modules\ndist\n", "utf8"),
    writeFile(path.join(target, "README.md"), `# ${name}\n\nPiPhi Widget SDK package.\n\n\`npm install\` installs the pinned toolchain. Use \`npm test\`, \`piphi widget validate\`, and \`piphi widget link --integration ../my-integration\`.\n`, "utf8"),
  ]);
  return target;
}

export async function linkWidgetProject(widgetCwd: string, integrationPath: string, autoInstall = true): Promise<{ manifestPath: string; registryId: string }> {
  const cwd = path.resolve(widgetCwd);
  const source = await readJson(path.join(cwd, PACKAGE_SOURCE));
  const identity = object(source.identity);
  const registryId = `${string(identity.publisher_id)}.${string(identity.package_id)}`;
  if (registryId === ".") throw new Error("package.source.json is missing identity.publisher_id or identity.package_id");
  const manifestPath = await resolveIntegrationManifest(integrationPath);
  const manifest = await readJson(manifestPath);
  const ui = ensureObject(manifest, "ui");
  const packages = ensureArray(ui, "experience_packages");
  const existing = packages.find((value) => object(value).registry_id === registryId);
  const link = { registry_id: registryId, version_range: compatibleVersionRange(string(identity.version)), auto_install: autoInstall };
  if (existing && typeof existing === "object") Object.assign(existing, link);
  else packages.push(link);
  await writeJson(manifestPath, manifest);
  return { manifestPath, registryId };
}

export async function validateWidgetProject(options: ValidateWidgetOptions = {}): Promise<WidgetFinding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const findings: WidgetFinding[] = [];
  let source: JsonObject;
  try {
    source = await readJson(path.join(cwd, PACKAGE_SOURCE));
  } catch (error) {
    return [{ level: "error", message: error instanceof Error ? error.message : String(error) }];
  }
  const identity = object(source.identity);
  for (const field of ["publisher_id", "package_id", "version"] as const) {
    if (!string(identity[field])) findings.push({ level: "error", message: `identity.${field} is required.` });
  }
  if (!string(source.sdk_version_range)) findings.push({ level: "error", message: "sdk_version_range is required." });
  const widgets = Array.isArray(source.widgets) ? source.widgets : [];
  if (!widgets.length) findings.push({ level: "error", message: "At least one widget is required." });
  for (const raw of widgets) {
    const widget = object(raw);
    const id = string(widget.id) || "<unknown>";
    const runtime = string(widget.runtime);
    if (!string(widget.id) || !string(widget.name)) findings.push({ level: "error", message: `Widget ${id} requires id and name.` });
    if (!Array.isArray(widget.binding_slots)) findings.push({ level: "error", message: `Widget ${id} requires binding_slots.` });
    if (runtime === "sandboxed_bundle") {
      const entry = safeAssetPath(string(widget.entry));
      if (!entry) findings.push({ level: "error", message: `Widget ${id} requires a package-relative entry.` });
      else if (!existsSync(path.join(cwd, entry))) findings.push({ level: "error", message: `Widget ${id} entry is missing: ${entry}. Run the widget build.` });
      if (widget.recipe !== undefined) findings.push({ level: "error", message: `Widget ${id} cannot combine sandboxed_bundle with recipe.` });
    } else if (runtime === "declarative") {
      if (!widget.recipe) findings.push({ level: "error", message: `Declarative widget ${id} requires recipe.` });
    } else findings.push({ level: "error", message: `Widget ${id} has unsupported runtime '${runtime}'.` });
    for (const rawTheme of Array.isArray(widget.themes) ? widget.themes : []) {
      const stylesheet = safeAssetPath(string(object(rawTheme).stylesheet));
      if (!stylesheet || !existsSync(path.join(cwd, stylesheet))) findings.push({ level: "error", message: `Widget ${id} theme asset is missing: ${stylesheet || "<invalid>"}.` });
    }
  }
  if (existsSync(path.join(cwd, "package.json"))) {
    const packageJson = await readJson(path.join(cwd, "package.json"));
    if (string(packageJson.version) !== string(identity.version)) findings.push({ level: "error", message: "package.json and package.source.json versions must match." });
  }
  if (existsSync(path.join(cwd, "src"))) {
    const sourceFiles = await collectSourceFiles(path.join(cwd, "src"));
    const authored = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
    if (widgets.some((widget) => object(widget).runtime === "sandboxed_bundle") && !authored.includes("piphi-network-widget-sdk")) {
      findings.push({ level: "error", message: "Sandboxed widget source must use piphi-network-widget-sdk." });
    }
  }
  if (options.integration) findings.push(...await verifyWidgetLink(cwd, options.integration));
  if (!findings.length) findings.push({ level: "info", message: "Widget package is valid." });
  return findings;
}

export async function verifyWidgetLink(widgetCwd: string, integrationPath: string): Promise<WidgetFinding[]> {
  const source = await readJson(path.join(path.resolve(widgetCwd), PACKAGE_SOURCE));
  const identity = object(source.identity);
  const registryId = `${string(identity.publisher_id)}.${string(identity.package_id)}`;
  const manifestPath = await resolveIntegrationManifest(integrationPath);
  const manifest = await readJson(manifestPath);
  const packages = Array.isArray(object(manifest.ui).experience_packages) ? object(manifest.ui).experience_packages as unknown[] : [];
  const link = packages.find((value) => object(value).registry_id === registryId);
  if (!link) return [{ level: "error", message: `Integration does not link ${registryId}. Run 'piphi widget link'.` }];
  const integrationId = string(manifest.id);
  const required = Array.isArray(source.requires_integrations) ? source.requires_integrations.map((value) => string(object(value).integration_id)) : [];
  if (required.length && integrationId && !required.includes(integrationId)) return [{ level: "error", message: `Widget requires ${required.join(", ")}, but integration id is ${integrationId}.` }];
  return [{ level: "info", message: `${registryId} is linked to ${integrationId || path.basename(path.dirname(manifestPath))}.` }];
}

export async function packWidgetProject(cwdArg: string, options: { check?: boolean; outputDir?: string; privateKeyEnv?: string; keyId?: string } = {}): Promise<{ archivePath: string; manifestPath: string; digest: string }> {
  const cwd = path.resolve(cwdArg);
  const findings = await validateWidgetProject({ cwd });
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length) throw new Error(errors.map((finding) => finding.message).join("\n"));
  const source = await readJson(path.join(cwd, PACKAGE_SOURCE));
  const identity = object(source.identity);
  const assets = new Set<string>([PACKAGE_SOURCE]);
  for (const raw of source.widgets as unknown[]) {
    const widget = object(raw);
    if (string(widget.entry)) assets.add(string(widget.entry));
    for (const rawTheme of Array.isArray(widget.themes) ? widget.themes : []) assets.add(string(object(rawTheme).stylesheet));
  }
  const members: Record<string, [Uint8Array, { level: 9; mtime: Date }]> = {};
  for (const asset of [...assets].sort()) {
    const payload = asset === PACKAGE_SOURCE ? Buffer.from(`${JSON.stringify(source, null, 2)}\n`) : await readFile(path.join(cwd, asset));
    members[asset] = [payload, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }];
  }
  const archive = Buffer.from(zipSync(members));
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const check = options.check ?? false;
  const privateKey = check
    ? generateKeyPairSync("ed25519").privateKey
    : privateKeyFromEnvironment(options.privateKeyEnv ?? "PIPHI_WIDGET_SIGNING_KEY_PEM_BASE64");
  const manifest: JsonObject = {
    ...source,
    artifact: { digest, size_bytes: archive.length, media_type: "application/vnd.piphi.widget-package+zip", key_id: options.keyId ?? "piphi-release-1", signature: null },
  };
  const signature = sign(null, Buffer.concat([SIGNING_CONTEXT, Buffer.from(canonicalJson(manifest))]), privateKey).toString("base64");
  object(manifest.artifact).signature = signature;
  const temporary = check ? await mkdtemp(path.join(tmpdir(), "piphi-widget-package-")) : null;
  const outputDir = path.resolve(temporary ?? options.outputDir ?? path.join(cwd, "dist"));
  await mkdir(outputDir, { recursive: true });
  const packageId = string(identity.package_id);
  const version = string(identity.version);
  const archivePath = path.join(outputDir, `${packageId}-${version}.zip`);
  const manifestPath = path.join(outputDir, `${packageId}-${version}.manifest.json`);
  await writeFile(archivePath, archive);
  await writeJson(manifestPath, manifest);
  if (temporary) await rm(temporary, { recursive: true, force: true });
  return { archivePath: check ? "<temporary>" : archivePath, manifestPath: check ? "<temporary>" : manifestPath, digest };
}

export async function buildWidgetProject(cwdArg: string): Promise<void> {
  const cwd = path.resolve(cwdArg);
  const packageJson = await readJson(path.join(cwd, "package.json"));
  if (!string(object(packageJson.scripts).build)) throw new Error("Widget package.json must define a build script.");
  const manager = existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(cwd, "yarn.lock")) ? "yarn" : "npm";
  const args = manager === "npm" ? ["run", "build"] : ["build"];
  const child = spawn(manager, args, { cwd, stdio: "inherit", shell: false });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${manager} build exited with code ${code ?? "unknown"}.`)));
  });
}

export async function widgetDevManifest(cwdArg: string, widgetId?: string): Promise<JsonObject> {
  const source = await readJson(path.join(path.resolve(cwdArg), PACKAGE_SOURCE));
  const widgets = Array.isArray(source.widgets) ? source.widgets.map(object) : [];
  const widget = widgets.find((candidate) => string(candidate.id) === widgetId) ?? widgets[0];
  if (!widget) throw new Error("Widget package does not contain any widgets.");
  if (string(widget.runtime) !== "sandboxed_bundle") throw new Error("The local simulator currently previews sandboxed_bundle widgets.");
  const identity = object(source.identity);
  const slots = Array.isArray(widget.binding_slots) ? widget.binding_slots.map(object) : [];
  return {
    id: `${string(identity.publisher_id)}.${string(identity.package_id)}.${string(widget.id)}`,
    name: string(widget.name),
    version: string(identity.version),
    entry: string(widget.entry),
    binding_modes: [...new Set(slots.flatMap((slot) => Array.isArray(slot.binding_modes) ? slot.binding_modes.map(String) : []))],
    value_kinds: [...new Set(slots.flatMap((slot) => Array.isArray(slot.value_kinds) ? slot.value_kinds.map(String) : []))],
    capability_requirements: [...new Set(slots.flatMap((slot) => Array.isArray(slot.capability_requirements) ? slot.capability_requirements.map(String) : []))],
    settings: Array.isArray(widget.settings) ? widget.settings : [],
    themes: Array.isArray(widget.themes) ? widget.themes : [],
    default_theme_id: widget.default_theme_id,
    layout: { minHeight: 120, defaultHeight: Math.max(180, Number(widget.default_row_span ?? 3) * 60), maxHeight: 1200 },
    security: { permissions: Array.isArray(widget.permissions) ? widget.permissions : [], allowed_commands: Array.isArray(widget.allowed_commands) ? widget.allowed_commands : [], sandbox: ["allow-scripts"], csp: { connect_src: [] } },
  };
}

export async function devWidgetProject(cwdArg: string, options: { port?: number; widgetId?: string } = {}): Promise<void> {
  const cwd = path.resolve(cwdArg);
  const manifest = await widgetDevManifest(cwd, options.widgetId);
  const sdkEntry = fileURLToPath(import.meta.resolve("piphi-network-widget-sdk"));
  const simulator = path.resolve(path.dirname(sdkEntry), "../simulator/index.html");
  const clients = new Set<import("node:http").ServerResponse>();
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/__piphi__/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (url.pathname === "/widget.manifest.json") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(manifest));
      return;
    }
    const requested = url.pathname === "/" || url.pathname === "/__piphi__/simulator"
      ? simulator
      : path.resolve(cwd, `.${decodeURIComponent(url.pathname)}`);
    if (requested !== simulator && !requested.startsWith(`${cwd}${path.sep}`)) {
      response.writeHead(403); response.end("Forbidden"); return;
    }
    try {
      const { stat } = await import("node:fs/promises");
      const info = await stat(requested);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, { "Content-Type": mime[path.extname(requested)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(await readFile(requested));
    } catch {
      response.writeHead(404); response.end("Not found");
    }
  });
  const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
    if (!filename || filename.includes("node_modules") || filename.includes(".git")) return;
    for (const client of clients) client.write(`event: reload\ndata: ${JSON.stringify(filename)}\n\n`);
  });
  const port = options.port ?? 4179;
  const stop = () => { watcher.close(); for (const client of clients) client.end(); server.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`PiPhi widget simulator: http://127.0.0.1:${port}/`);
      resolve();
    });
  });
}

async function resolveIntegrationManifest(value: string): Promise<string> {
  const input = path.resolve(value);
  for (const candidate of [input, path.join(input, "manifest.json"), path.join(input, "src", "manifest.json")]) {
    if (existsSync(candidate) && candidate.endsWith(".json")) return candidate;
  }
  throw new Error(`Could not find integration manifest under ${input}`);
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectSourceFiles(target));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) output.push(target);
  }
  return output;
}

function privateKeyFromEnvironment(name: string) {
  const encoded = String(process.env[name] ?? "").trim();
  if (!encoded) throw new Error(`${name} must contain a base64-encoded PEM Ed25519 private key.`);
  return createPrivateKey(Buffer.from(encoded, "base64"));
}

function compatibleVersionRange(version: string): string {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major > 0 ? `>=${major}.0,<${major + 1}` : ">=0.1,<1";
}

function safeAssetPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return "";
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-widget";
}

function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function ensureObject(parent: JsonObject, key: string): JsonObject { const current = object(parent[key]); parent[key] = current; return current; }
function ensureArray(parent: JsonObject, key: string): unknown[] { const current = Array.isArray(parent[key]) ? parent[key] as unknown[] : []; parent[key] = current; return current; }
async function readJson(file: string): Promise<JsonObject> { return object(JSON.parse(await readFile(file, "utf8"))); }
async function writeJson(file: string, value: unknown): Promise<void> { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function buildScript(): string {
  return `import { build } from "esbuild";\n\nawait build({ entryPoints: ["src/widget.ts"], outfile: "assets/widget.mjs", bundle: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "none" });\n`;
}

function widgetSource(name: string): string {
  return `import { getInjectedPiPhiWidgetHost } from "piphi-network-widget-sdk";\n\nconst root = document.getElementById("piphi-widget-root");\nconst host = getInjectedPiPhiWidgetHost();\n\nif (root) {\n  root.innerHTML = \`<section aria-label="${name}"><p role="status">Waiting for live data…</p><output>—</output></section>\`;\n  const status = root.querySelector('[role="status"]');\n  const output = root.querySelector("output");\n  host.subscribe((bootstrap) => {\n    for (const slot of bootstrap.bindings ?? []) {\n      void host.subscribeState({ slotId: slot.id }, (event) => {\n        if (status) status.textContent = event.kind === "error" ? (event.error?.message ?? "Data unavailable") : event.kind;\n        if (output && event.kind === "point") output.textContent = String(event.data?.value ?? "—");\n      });\n    }\n    void host.ready({ height: 180 });\n  });\n}\n`;
}

function widgetTest(): string {
  return `import assert from "node:assert/strict";\nimport { existsSync, readFileSync } from "node:fs";\nimport test from "node:test";\n\nconst source = JSON.parse(readFileSync(new URL("../package.source.json", import.meta.url), "utf8"));\n\ntest("widget package owns SDK source and a built entry", () => {\n  assert.equal(source.widgets[0].runtime, "sandboxed_bundle");\n  assert.equal(existsSync(new URL(\`../\${source.widgets[0].entry}\`, import.meta.url)), true);\n  assert.match(readFileSync(new URL("../src/widget.ts", import.meta.url), "utf8"), /piphi-network-widget-sdk/);\n});\n`;
}
