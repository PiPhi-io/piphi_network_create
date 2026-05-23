import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { renderReleaseGithubActions, renderReleaseGuide, renderReleaseScript } from "./templates/common.js";
import {
  renderGoBinaryBuildScript,
  renderGoBinaryGithubActions,
  renderNodeBinaryBuildScript,
  renderNodeBinaryGithubActions,
  renderPythonBinaryBuildScript,
  renderPythonBinaryEntry,
  renderPythonBinaryGithubActions,
} from "./templates/binary.js";
import type { TemplateCommandSet, TemplateScaffoldOptions } from "./templates/types.js";

type JsonObject = Record<string, unknown>;

type ProjectToolOptions = {
  cwd?: string;
};

type Finding = {
  level: "error" | "warning" | "info";
  message: string;
};

type ProjectInspection = {
  cwd: string;
  language: string;
  id: string;
  name: string;
  version: string;
  preset: string;
  domain: string;
  scaffoldVersion: string;
  image: string;
  port: number | null;
  endpoints: string[];
  requiredEndpoints: string[];
  capabilities: string[];
  commands: string[];
  configFields: string[];
  files: Record<string, boolean>;
  findings: Finding[];
};

const requiredEndpointKeys = ["health", "entities", "command", "config", "ui_config"];
const defaultEndpoints: Record<string, string> = {
  health: "/health",
  diagnostics: "/diagnostics",
  discover: "/discover",
  entities: "/entities",
  state: "/state",
  config: "/config",
  config_sync: "/config/sync",
  deconfigure: "/deconfigure",
  ui_config: "/ui-config",
  events: "/events",
  command: "/command",
};
const manifestSchemaPath = "schema/piphi-manifest.schema.json";
const currentScaffoldVersion = "0.2.0";

export async function validateProject(options: ProjectToolOptions = {}): Promise<Finding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const findings: Finding[] = [];
  const manifest = await readManifest(cwd, findings);
  if (!manifest) {
    return findings;
  }

  const api = asObject(manifest.api);
  const endpoints = asObject(api.endpoints);
  const required = Array.isArray(api.required) ? api.required.map(String) : [];

  if (manifest.$schema !== `./${manifestSchemaPath}`) {
    findings.push({
      level: "warning",
      message: `manifest.json should reference ./${manifestSchemaPath}`,
    });
  }
  if (!existsSync(path.join(cwd, manifestSchemaPath))) {
    findings.push({ level: "warning", message: `${manifestSchemaPath} is missing.` });
  }
  findings.push(...(await validateManifestSchema(cwd, manifest)));
  const metadata = asObject(manifest.metadata);
  if (metadata.scaffold_version !== currentScaffoldVersion) {
    findings.push({
      level: "warning",
      message: `metadata.scaffold_version should be ${currentScaffoldVersion}`,
    });
  }

  for (const key of requiredEndpointKeys) {
    if (!required.includes(key)) {
      findings.push({ level: "error", message: `api.required is missing ${key}` });
    }
    const endpoint = endpoints[key];
    if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
      findings.push({ level: "error", message: `api.endpoints.${key} must be an absolute path` });
    }
  }

  const runtime = asObject(manifest.runtime);
  const linux = asObject(runtime.linux);
  const container = asObject(linux.container);
  const ports = Array.isArray(container.ports) ? container.ports : [];
  const firstPort = asObject(ports[0]);
  const manifestPort = firstPort.container;
  if (!Number.isInteger(manifestPort)) {
    findings.push({
      level: "error",
      message: "runtime.linux.container.ports[0].container must be an integer",
    });
  } else {
    const dockerfilePath = path.join(cwd, "Dockerfile");
    if (existsSync(dockerfilePath)) {
      const dockerfile = await readFile(dockerfilePath, "utf8");
      if (!dockerfile.includes(`EXPOSE ${manifestPort}`)) {
        findings.push({
          level: "error",
          message: `Dockerfile must expose manifest port ${manifestPort}`,
        });
      }
    }
  }

  const capabilities = asObject(manifest.capabilities);
  const commands = asObject(manifest.commands);
  for (const [capabilityId, capability] of Object.entries(capabilities)) {
    const capabilityShape = asObject(capability);
    if (capabilityShape.kind === "action" && !commands[capabilityId]) {
      findings.push({
        level: "error",
        message: `Action capability '${capabilityId}' must map to a command handler`,
      });
    }
  }

  if (!existsAny(cwd, ["src/contract.ts", "src/*/contract.py", "contract.go"])) {
    findings.push({
      level: "warning",
      message: "No generated contract source file was found.",
    });
  }

  return findings;
}

export async function fixProject(options: ProjectToolOptions = {}): Promise<Finding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const findings: Finding[] = [];
  let changed = false;

  if (manifest.$schema !== `./${manifestSchemaPath}`) {
    manifest.$schema = `./${manifestSchemaPath}`;
    changed = true;
    findings.push({ level: "info", message: `Set manifest $schema to ./${manifestSchemaPath}.` });
  }

  const api = ensureObject(manifest, "api");
  const endpoints = ensureObject(api, "endpoints");
  const required = ensureArray(api, "required");
  for (const key of requiredEndpointKeys) {
    if (!required.includes(key)) {
      required.push(key);
      changed = true;
      findings.push({ level: "info", message: `Added ${key} to api.required.` });
    }
    if (typeof endpoints[key] !== "string" || !String(endpoints[key]).startsWith("/")) {
      endpoints[key] = defaultEndpoints[key];
      changed = true;
      findings.push({ level: "info", message: `Set api.endpoints.${key} to ${defaultEndpoints[key]}.` });
    }
  }
  for (const [key, endpoint] of Object.entries(defaultEndpoints)) {
    if (typeof endpoints[key] !== "string") {
      endpoints[key] = endpoint;
      changed = true;
      findings.push({ level: "info", message: `Added api.endpoints.${key}.` });
    }
  }

  const metadata = ensureObject(manifest, "metadata");
  if (metadata.generator !== "piphi-network-create") {
    metadata.generator = "piphi-network-create";
    changed = true;
    findings.push({ level: "info", message: "Set metadata.generator." });
  }
  if (metadata.scaffold_version !== currentScaffoldVersion) {
    metadata.scaffold_version = currentScaffoldVersion;
    changed = true;
    findings.push({ level: "info", message: `Set metadata.scaffold_version to ${currentScaffoldVersion}.` });
  }

  const capabilities = ensureObject(manifest, "capabilities");
  const commands = ensureObject(manifest, "commands");
  for (const [capabilityId, capability] of Object.entries(capabilities)) {
    const capabilityShape = asObject(capability);
    if (capabilityShape.kind === "action" && !commands[capabilityId]) {
      commands[capabilityId] = {
        description: humanize(capabilityId),
        timeout_ms: 5000,
      };
      changed = true;
      findings.push({ level: "info", message: `Added command handler metadata for ${capabilityId}.` });
    }
  }

  const port = asObject(asObject(asObject(manifest.runtime).linux).container).ports;
  const manifestPort = Array.isArray(port) ? asObject(port[0]).container : undefined;
  if (Number.isInteger(manifestPort)) {
    const dockerfilePath = path.join(cwd, "Dockerfile");
    if (existsSync(dockerfilePath)) {
      const dockerfile = await readFile(dockerfilePath, "utf8");
      const nextDockerfile = dockerfile.match(/^EXPOSE\s+\d+/m)
        ? dockerfile.replace(/^EXPOSE\s+\d+/m, `EXPOSE ${manifestPort}`)
        : `${dockerfile.trimEnd()}\nEXPOSE ${manifestPort}\n`;
      if (nextDockerfile !== dockerfile) {
        await writeFile(dockerfilePath, nextDockerfile, "utf8");
        findings.push({ level: "info", message: `Updated Dockerfile EXPOSE to ${manifestPort}.` });
      }
    }
  }

  const schemaFullPath = path.join(cwd, manifestSchemaPath);
  if (!existsSync(schemaFullPath)) {
    await mkdir(path.dirname(schemaFullPath), { recursive: true });
    await writeFile(schemaFullPath, manifestSchemaJson(), "utf8");
    findings.push({ level: "info", message: `Created ${manifestSchemaPath}.` });
  }

  if (changed) {
    await writeManifest(cwd, manifest);
  }
  if (findings.length === 0) {
    findings.push({ level: "info", message: "No automatic fixes were needed." });
  }
  return findings;
}

export async function doctorProject(options: ProjectToolOptions = {}): Promise<Finding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const findings = await validateProject({ cwd });

  if (!existsSync(path.join(cwd, "README.md"))) {
    findings.push({ level: "warning", message: "README.md is missing." });
  }
  if (!existsSync(path.join(cwd, "docs", "contract.md"))) {
    findings.push({ level: "warning", message: "docs/contract.md is missing." });
  }
  if (!existsSync(path.join(cwd, "examples", "curl.sh"))) {
    findings.push({ level: "warning", message: "examples/curl.sh is missing." });
  }
  if (!existsAny(cwd, ["tests/contract.test.ts", "tests/test_contract.py", "contract_test.go"])) {
    findings.push({ level: "warning", message: "Generated contract tests are missing." });
  }

  if (!findings.some((finding) => finding.level === "error" || finding.level === "warning")) {
    findings.push({ level: "info", message: "Project looks healthy." });
  }
  return findings;
}

export async function inspectProject(options: ProjectToolOptions = {}): Promise<ProjectInspection> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const findings = await validateProject({ cwd });
  const manifest = await requireManifest(cwd);
  const metadata = asObject(manifest.metadata);
  const runtime = asObject(manifest.runtime);
  const linux = asObject(runtime.linux);
  const container = asObject(linux.container);
  const ports = Array.isArray(container.ports) ? container.ports : [];
  const firstPort = asObject(ports[0]);
  const api = asObject(manifest.api);
  const endpoints = asObject(api.endpoints);
  const config = asObject(manifest.config);

  return {
    cwd,
    language: detectLanguage(cwd),
    id: String(manifest.id ?? ""),
    name: String(manifest.name ?? ""),
    version: String(manifest.version ?? ""),
    preset: String(metadata.preset ?? ""),
    domain: String(metadata.domain ?? ""),
    scaffoldVersion: String(metadata.scaffold_version ?? ""),
    image: String(container.image ?? manifest.image ?? ""),
    port: Number.isInteger(firstPort.container) ? Number(firstPort.container) : null,
    endpoints: Object.entries(endpoints).map(([key, value]) => `${key}=${String(value)}`).sort(),
    requiredEndpoints: Array.isArray(api.required) ? api.required.map(String).sort() : [],
    capabilities: Object.keys(asObject(manifest.capabilities)).sort(),
    commands: Object.keys(asObject(manifest.commands)).sort(),
    configFields: Array.isArray(config.editable_fields) ? config.editable_fields.map(String).sort() : [],
    files: projectFilePresence(cwd),
    findings,
  };
}

export async function publishCheckProject(options: ProjectToolOptions = {}): Promise<Finding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const findings = await validateProject({ cwd });
  const files = projectFilePresence(cwd);
  const metadata = asObject(manifest.metadata);
  const maintainer = asObject(manifest.maintainer);
  const runtime = asObject(manifest.runtime);
  const linux = asObject(runtime.linux);
  const container = asObject(linux.container);
  const image = String(container.image ?? manifest.image ?? "");
  const id = String(manifest.id ?? "");

  requirePublishFile(findings, files.readme, "README.md is required before publishing.");
  requirePublishFile(findings, files.contractDocs, "docs/contract.md is required before publishing.");
  requirePublishFile(findings, files.curlExample, "examples/curl.sh is required before publishing.");
  requirePublishFile(findings, files.configExample, "examples/config.json is required before publishing.");
  requirePublishFile(findings, files.manifestSchema, `${manifestSchemaPath} is required before publishing.`);
  requirePublishFile(findings, files.contractTest, "Generated contract test is required before publishing.");
  requirePublishFile(findings, files.conformanceTest, "Generated conformance test is required before publishing.");
  requirePublishFile(findings, files.conformanceFixture, "tests/fixtures/contract-conformance.json is required before publishing.");
  requirePublishFile(findings, files.releaseWorkflow, ".github/workflows/release.yml is required before publishing.");
  requirePublishFile(findings, files.releaseScript, "scripts/release.py is required before publishing.");

  if (!image) {
    findings.push({ level: "error", message: "runtime image is required before publishing." });
  } else if (image === `piphinetwork/${id}:0.1.0` || image.startsWith("piphinetwork/")) {
    findings.push({ level: "error", message: "runtime image still uses the generated placeholder registry/name." });
  } else if (!releaseRegistryForImage(image)) {
    findings.push({
      level: "error",
      message: "runtime image must target Docker Hub or GHCR: use org/image:tag, docker.io/org/image:tag, or ghcr.io/org/image:tag.",
    });
  }

  if (manifest.version === "0.1.0") {
    findings.push({ level: "error", message: "manifest version is still 0.1.0." });
  }

  if (!maintainer.name || maintainer.name === "PiPhi Network") {
    findings.push({ level: "error", message: "maintainer.name should be set to the publishing owner." });
  }
  if (!maintainer.website || maintainer.website === "https://piphi.io") {
    findings.push({ level: "error", message: "maintainer.website should be set to the publishing owner website." });
  }
  if (!metadata.scaffold_version) {
    findings.push({ level: "error", message: "metadata.scaffold_version is required." });
  }

  if (!hasErrors(findings)) {
    findings.push({ level: "info", message: "Project is ready to publish." });
  }
  return findings;
}

export async function upgradeProject(options: ProjectToolOptions = {}): Promise<Finding[]> {
  const findings = await fixProject(options);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const metadata = ensureObject(manifest, "metadata");

  if (metadata.scaffold_version === currentScaffoldVersion) {
    findings.push({ level: "info", message: `Scaffold is at ${currentScaffoldVersion}.` });
  } else {
    metadata.scaffold_version = currentScaffoldVersion;
    await writeManifest(cwd, manifest);
    findings.push({ level: "info", message: `Migrated scaffold metadata to ${currentScaffoldVersion}.` });
  }

  return findings;
}

export async function addReleaseWorkflow(options: ProjectToolOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const releaseOptions = releaseOptionsFromManifest(cwd, manifest);
  await writeDoc(
    cwd,
    ".github/workflows/release.yml",
    renderReleaseGithubActions(releaseOptions, releaseCommandSet(cwd, releaseOptions.language)),
  );
  await writeDoc(cwd, "scripts/release.py", renderReleaseScript());
  await writeDoc(cwd, "docs/release.md", renderReleaseGuide(releaseOptions));
}

export async function addBinaryBuild(options: ProjectToolOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const buildOptions = releaseOptionsFromManifest(cwd, manifest);
  if (buildOptions.language === "node") {
    await writeDoc(cwd, "scripts/build-binary.mjs", renderNodeBinaryBuildScript(buildOptions));
    await writeDoc(cwd, ".github/workflows/build-binary.yml", renderNodeBinaryGithubActions(buildOptions));
    await ensureNodeBinaryScripts(cwd);
    await ensureGitignoreLines(cwd, ["build/", "dist/"]);
    return;
  }
  if (buildOptions.language === "go") {
    await writeDoc(cwd, "scripts/build_binary.py", renderGoBinaryBuildScript(buildOptions));
    await writeDoc(cwd, ".github/workflows/build-binary.yml", renderGoBinaryGithubActions(buildOptions));
    await ensureGitignoreLines(cwd, ["build/", "dist/"]);
    return;
  }
  await writeDoc(cwd, "scripts/binary_entry.py", renderPythonBinaryEntry(buildOptions));
  await writeDoc(cwd, "scripts/build_binary.py", renderPythonBinaryBuildScript(buildOptions));
  await writeDoc(cwd, ".github/workflows/build-binary.yml", renderPythonBinaryGithubActions(buildOptions));
  await ensurePythonBinaryExtra(cwd);
  await ensureGitignoreLines(cwd, ["build/", "*.spec"]);
}

export async function addCommand(
  commandId: string,
  options: ProjectToolOptions & { description?: string } = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const capabilities = ensureObject(manifest, "capabilities");
  const commands = ensureObject(manifest, "commands");
  capabilities[commandId] = { kind: "action" };
  commands[commandId] = {
    description: options.description ?? humanize(commandId),
    timeout_ms: 5000,
  };
  await writeManifest(cwd, manifest);
}

export async function addCapability(
  capabilityId: string,
  options: ProjectToolOptions & { kind?: string; unit?: string } = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const capabilities = ensureObject(manifest, "capabilities");
  capabilities[capabilityId] = {
    kind: options.kind ?? "sensor",
    ...(options.unit ? { unit: options.unit } : {}),
  };
  await writeManifest(cwd, manifest);
}

export async function addRoute(
  endpointKey: string,
  endpointPath: string,
  options: ProjectToolOptions = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const api = ensureObject(manifest, "api");
  const endpoints = ensureObject(api, "endpoints");
  endpoints[endpointKey] = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  await writeManifest(cwd, manifest);
}

export async function addWebhook(options: ProjectToolOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const api = ensureObject(manifest, "api");
  const endpoints = ensureObject(api, "endpoints");
  endpoints.webhook = "/webhooks/:source";
  const capabilities = ensureObject(manifest, "capabilities");
  capabilities.webhook_events_total = { kind: "sensor", unit: "events" };
  const config = ensureObject(manifest, "config");
  ensureStringArray(config, "editable_fields", ["webhook_secret", "source_name"]);
  await writeManifest(cwd, manifest);
  await writeDoc(cwd, "docs/addons/webhook.md", addonDoc("Webhook Receiver", ["POST /webhooks/{source}"]));
}

export async function addPoller(options: ProjectToolOptions & { interval?: number } = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const capabilities = ensureObject(manifest, "capabilities");
  capabilities.poll_success = { kind: "sensor", unit: "bool" };
  capabilities.poll_latency_ms = { kind: "sensor", unit: "ms" };
  const config = ensureObject(manifest, "config");
  ensureStringArray(config, "editable_fields", ["poll_interval_seconds"]);
  const runtime = ensureObject(ensureObject(ensureObject(manifest, "runtime"), "linux"), "container");
  const environment = ensureObject(runtime, "environment");
  environment.POLL_INTERVAL_SECONDS = String(options.interval ?? 60);
  await writeManifest(cwd, manifest);
  await writeDoc(cwd, "docs/addons/poller.md", addonDoc("Polling Loop", [`Default interval: ${options.interval ?? 60}s`]));
}

export async function addAuth(
  strategy: string,
  options: ProjectToolOptions = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const config = ensureObject(manifest, "config");
  if (strategy === "oauth2") {
    ensureStringArray(config, "editable_fields", ["client_id", "client_secret", "token_url"]);
  } else if (strategy === "api-key") {
    ensureStringArray(config, "editable_fields", ["api_key"]);
  } else {
    ensureStringArray(config, "editable_fields", ["auth_token"]);
  }
  const metadata = ensureObject(manifest, "metadata");
  metadata.auth_strategy = strategy;
  await writeManifest(cwd, manifest);
  await writeDoc(cwd, "docs/addons/auth.md", addonDoc("Authentication", [`Strategy: ${strategy}`]));
}

export async function addDiscovery(
  strategy: string,
  options: ProjectToolOptions = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const runtime = ensureObject(ensureObject(manifest, "runtime"), "linux");
  const discovery = ensureObject(runtime, "discovery");
  discovery.method = strategy;
  await writeManifest(cwd, manifest);
  await writeDoc(cwd, "docs/addons/discovery.md", addonDoc("Discovery", [`Method: ${strategy}`]));
}

export async function addTelemetry(
  metricIds: string[],
  options: ProjectToolOptions = {},
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await requireManifest(cwd);
  const capabilities = ensureObject(manifest, "capabilities");
  for (const metricId of metricIds) {
    capabilities[metricId] = { kind: "sensor" };
  }
  await writeManifest(cwd, manifest);
  await writeDoc(cwd, "docs/addons/telemetry.md", addonDoc("Telemetry", metricIds));
}

export function printFindings(findings: Finding[]): void {
  for (const finding of findings) {
    const label = finding.level.toUpperCase().padEnd(7);
    console.log(`${label} ${finding.message}`);
  }
}

export function printInspection(inspection: ProjectInspection): void {
  const validationErrors = inspection.findings.filter((finding) => finding.level === "error").length;
  const validationWarnings = inspection.findings.filter((finding) => finding.level === "warning").length;

  console.log(`Project: ${inspection.name || inspection.id}`);
  console.log(`Directory: ${inspection.cwd}`);
  console.log(`Language: ${inspection.language}`);
  console.log(`Version: ${inspection.version || "unknown"}`);
  console.log(`Preset: ${inspection.preset || "unknown"}`);
  console.log(`Domain: ${inspection.domain || "unknown"}`);
  console.log(`Scaffold: ${inspection.scaffoldVersion || "unknown"}`);
  console.log(`Image: ${inspection.image || "unset"}`);
  console.log(`Port: ${inspection.port ?? "unset"}`);
  console.log(`Validation: ${validationErrors} error(s), ${validationWarnings} warning(s)`);
  printInspectionList("Required endpoints", inspection.requiredEndpoints);
  printInspectionList("Endpoints", inspection.endpoints);
  printInspectionList("Config fields", inspection.configFields);
  printInspectionList("Capabilities", inspection.capabilities);
  printInspectionList("Commands", inspection.commands);
  console.log("Files:");
  for (const [label, present] of Object.entries(inspection.files)) {
    console.log(`  ${present ? "yes" : "no "} ${label}`);
  }
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((finding) => finding.level === "error");
}

function printInspectionList(label: string, values: string[]): void {
  console.log(`${label}: ${values.length > 0 ? values.join(", ") : "none"}`);
}

async function readManifest(cwd: string, findings: Finding[]): Promise<JsonObject | null> {
  const manifestPath = path.join(cwd, "manifest.json");
  if (!existsSync(manifestPath)) {
    findings.push({ level: "error", message: "manifest.json is missing." });
    return null;
  }
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
  } catch (error) {
    findings.push({
      level: "error",
      message: `manifest.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

async function requireManifest(cwd: string): Promise<JsonObject> {
  const manifestPath = path.join(cwd, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json is missing in ${cwd}`);
  }
  return JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
}

async function writeManifest(cwd: string, manifest: JsonObject): Promise<void> {
  await writeFile(path.join(cwd, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function validateManifestSchema(cwd: string, manifest: JsonObject): Promise<Finding[]> {
  const schemaPath = path.join(cwd, manifestSchemaPath);
  const schema = existsSync(schemaPath)
    ? JSON.parse(await readFile(schemaPath, "utf8")) as JsonObject
    : JSON.parse(manifestSchemaJson()) as JsonObject;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(manifest)) {
    return [];
  }
  return (validate.errors ?? []).map((error: ErrorObject) => ({
    level: "error" as const,
    message: `manifest schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  }));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function ensureObject(target: JsonObject, key: string): JsonObject {
  const value = target[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  const next: JsonObject = {};
  target[key] = next;
  return next;
}

function ensureArray(target: JsonObject, key: string): string[] {
  const value = target[key];
  if (Array.isArray(value)) {
    const next = value.map(String);
    target[key] = next;
    return next;
  }
  const next: string[] = [];
  target[key] = next;
  return next;
}

function ensureStringArray(target: JsonObject, key: string, values: string[]): string[] {
  const current = ensureArray(target, key);
  for (const value of values) {
    if (!current.includes(value)) {
      current.push(value);
    }
  }
  return current;
}

function projectFilePresence(cwd: string): Record<string, boolean> {
  return {
    readme: existsSync(path.join(cwd, "README.md")),
    dockerfile: existsSync(path.join(cwd, "Dockerfile")),
    manifestSchema: existsSync(path.join(cwd, manifestSchemaPath)),
    contractDocs: existsSync(path.join(cwd, "docs", "contract.md")),
    curlExample: existsSync(path.join(cwd, "examples", "curl.sh")),
    configExample: existsSync(path.join(cwd, "examples", "config.json")),
    commandExample: existsSync(path.join(cwd, "examples", "command.json")),
    discoveryExample: existsSync(path.join(cwd, "examples", "discovery-request.json")),
    entityExample: existsSync(path.join(cwd, "examples", "entity-response.json")),
    contractSource: existsAny(cwd, ["src/contract.ts", "src/*/contract.py", "contract.go"]),
    contractTest: existsAny(cwd, ["tests/contract.test.ts", "tests/test_contract.py", "contract_test.go"]),
    conformanceTest: existsAny(cwd, ["tests/conformance.test.ts", "tests/test_conformance.py", "conformance_test.go"]),
    conformanceFixture: existsSync(path.join(cwd, "tests", "fixtures", "contract-conformance.json")),
    releaseWorkflow: existsSync(path.join(cwd, ".github", "workflows", "release.yml")),
    releaseScript: existsSync(path.join(cwd, "scripts", "release.py")),
    binaryBuildScript: existsAny(cwd, ["scripts/build_binary.py", "scripts/build-binary.mjs"]),
    binaryBuildWorkflow: existsSync(path.join(cwd, ".github", "workflows", "build-binary.yml")),
  };
}

async function ensureNodeBinaryScripts(cwd: string): Promise<void> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as JsonObject;
  const scripts = ensureObject(packageJson, "scripts");
  scripts["build:binary"] = "node scripts/build-binary.mjs";
  const devDependencies = ensureObject(packageJson, "devDependencies");
  if (!devDependencies.esbuild) {
    devDependencies.esbuild = "^0.25.0";
  }
  if (!devDependencies.postject) {
    devDependencies.postject = "^1.0.0-alpha.6";
  }
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function ensurePythonBinaryExtra(cwd: string): Promise<void> {
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  if (!existsSync(pyprojectPath)) {
    return;
  }
  const pyproject = await readFile(pyprojectPath, "utf8");
  if (pyproject.includes("pyinstaller")) {
    return;
  }
  const marker = "[project.scripts]";
  const binaryExtra = `binary = [
  "pyinstaller>=6.10.0",
]

`;
  const next = pyproject.includes(marker)
    ? pyproject.replace(marker, `${binaryExtra}${marker}`)
    : `${pyproject.trimEnd()}\n\n[project.optional-dependencies]\n${binaryExtra}`;
  await writeFile(pyprojectPath, next, "utf8");
}

async function ensureGitignoreLines(cwd: string, lines: string[]): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const current = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
  const currentLines = new Set(current.split(/\r?\n/).filter(Boolean));
  const missing = lines.filter((line) => !currentLines.has(line));
  if (missing.length > 0) {
    await writeFile(gitignorePath, `${current.trimEnd()}\n${missing.join("\n")}\n`, "utf8");
  }
}

function releaseOptionsFromManifest(cwd: string, manifest: JsonObject): TemplateScaffoldOptions {
  const metadata = asObject(manifest.metadata);
  const runtime = asObject(manifest.runtime);
  const linux = asObject(runtime.linux);
  const container = asObject(linux.container);
  const ports = Array.isArray(container.ports) ? container.ports : [];
  const firstPort = asObject(ports[0]);
  const slug = String(manifest.id ?? path.basename(cwd));
  const language = detectLanguage(cwd);
  return {
    slug,
    title: String(manifest.name ?? slug),
    language: language === "python" || language === "go" ? language : "node",
    kind: String(metadata.kind ?? "integration"),
    image: String(container.image ?? manifest.image ?? ""),
    port: Number.isInteger(firstPort.container) ? Number(firstPort.container) : 8090,
    preset: String(metadata.preset ?? "minimal"),
    domain: String(metadata.domain ?? "sensor"),
    snakeName: slug.replace(/-/g, "_"),
    packageManager: nodePackageManager(cwd),
    pythonManager: "pip",
  };
}

function releaseCommandSet(cwd: string, language: "node" | "python" | "go"): TemplateCommandSet {
  if (language === "node") {
    const manager = nodePackageManager(cwd);
    const run = manager === "pnpm" ? "pnpm" : manager === "yarn" ? "yarn" : "npm run";
    return {
      installCommand: manager === "npm" ? "npm install" : `${manager} install`,
      checkCommand: `${run} check`,
      testCommand: manager === "npm" ? "npm test" : `${manager} test`,
      validateCommand: `${run} validate`,
    };
  }
  if (language === "python") {
    return {
      installCommand: "python -m pip install -e .[dev]",
      checkCommand: "python -m compileall -q src scripts",
      testCommand: "pytest",
      validateCommand: "python scripts/validate.py",
    };
  }
  return {
    installCommand: "go mod tidy",
    checkCommand: "go vet ./...",
    testCommand: "go test ./...",
    validateCommand: "go run ./cmd/validate",
  };
}

function nodePackageManager(cwd: string): "npm" | "pnpm" | "yarn" {
  try {
    const packageJson = JSON.parse(
      readdirSync(cwd).includes("package.json")
        ? readFileSync(path.join(cwd, "package.json"), "utf8")
        : "{}",
    ) as JsonObject;
    const packageManager = String(packageJson.packageManager ?? "");
    if (packageManager.startsWith("pnpm@")) {
      return "pnpm";
    }
    if (packageManager.startsWith("yarn@")) {
      return "yarn";
    }
  } catch {
    return "npm";
  }
  return "npm";
}

function releaseRegistryForImage(image: string): "dockerhub" | "ghcr" | null {
  if (image.startsWith("ghcr.io/")) {
    return "ghcr";
  }
  const firstSegment = image.split("/", 1)[0] ?? "";
  if (image.startsWith("docker.io/") || (image.includes("/") && !firstSegment.includes(".") && !firstSegment.includes(":"))) {
    return "dockerhub";
  }
  return null;
}

function detectLanguage(cwd: string): string {
  if (existsSync(path.join(cwd, "src", "contract.ts")) || existsSync(path.join(cwd, "package.json"))) {
    return "node";
  }
  if (existsAny(cwd, ["src/*/contract.py"]) || existsSync(path.join(cwd, "pyproject.toml"))) {
    return "python";
  }
  if (existsSync(path.join(cwd, "contract.go")) || existsSync(path.join(cwd, "go.mod"))) {
    return "go";
  }
  return "unknown";
}

function requirePublishFile(findings: Finding[], present: boolean, message: string): void {
  if (!present) {
    findings.push({ level: "error", message });
  }
}

async function writeDoc(cwd: string, relativePath: string, contents: string): Promise<void> {
  const destination = path.join(cwd, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

function addonDoc(title: string, lines: string[]): string {
  return `# ${title}

Generated by \`piphi-network-create\`.

${lines.map((line) => `- ${line}`).join("\n")}
`;
}

function manifestSchemaJson(): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://piphi.io/schemas/piphi-manifest.schema.json",
      title: "PiPhi Runtime Manifest",
      type: "object",
      required: ["manifest_version", "id", "name", "version", "runtime", "api", "capabilities"],
      properties: {
        $schema: { type: "string" },
        manifest_version: { type: "string" },
        id: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        runtime: { type: "object" },
        api: { type: "object" },
        capabilities: { type: "object" },
        commands: { type: "object" },
        entities: { type: "array" },
      },
    },
    null,
    2,
  )}\n`;
}

function existsAny(cwd: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) {
      return existsSync(path.join(cwd, pattern));
    }
    const [prefix, suffix] = pattern.split("*", 2);
    const base = path.join(cwd, prefix);
    if (!existsSync(base)) {
      return false;
    }
    return false || findFileWithSuffix(base, suffix);
  });
}

function findFileWithSuffix(directory: string, suffix: string): boolean {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    return entries.some((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findFileWithSuffix(fullPath, suffix);
      }
      return fullPath.endsWith(suffix);
    });
  } catch {
    return false;
  }
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
