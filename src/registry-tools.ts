import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

export type RegistryKind = "integration" | "widget";

export type RegistryProposalOptions = {
  cwd?: string;
  kind?: RegistryKind;
  repoUrl?: string;
  ref?: string;
  output?: string;
  artifactManifest?: string;
};

export type RegistryProposal = {
  schema_version: 1;
  kind: RegistryKind;
  registry_id: string;
  version: string;
  repo_url: string;
  manifest_path: string;
  ref: string;
  artifact_integrity?: string;
  proposed_entry: JsonObject;
};

export type RegistryFinding = {
  level: "error" | "warning" | "info";
  message: string;
};

export async function prepareRegistryProposal(options: RegistryProposalOptions = {}): Promise<{ proposal: RegistryProposal; outputPath: string }> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolved = await resolveSource(cwd, options.kind);
  const repoUrl = normalizeRepoUrl(options.repoUrl ?? await inferRepoUrl(cwd));
  if (!repoUrl) throw new Error("Repository URL is required. Pass --repo-url or configure git remote.origin.url.");
  const source = await readJson(resolved.path);
  const artifactManifest = options.artifactManifest ? await readJson(path.resolve(cwd, options.artifactManifest)) : undefined;
  const normalized = resolved.kind === "widget"
    ? widgetEntry(source, artifactManifest, repoUrl, path.relative(cwd, resolved.path).replaceAll(path.sep, "/"))
    : integrationEntry(source, repoUrl, path.relative(cwd, resolved.path).replaceAll(path.sep, "/"));
  const version = text(normalized.version);
  const proposal: RegistryProposal = {
    schema_version: 1,
    kind: resolved.kind,
    registry_id: text(normalized.id),
    version,
    repo_url: repoUrl,
    manifest_path: path.relative(cwd, resolved.path).replaceAll(path.sep, "/"),
    ref: options.ref ?? `v${version}`,
    ...(resolved.kind === "widget" && text(object(normalized.artifact).integrity)
      ? { artifact_integrity: text(object(normalized.artifact).integrity) }
      : {}),
    proposed_entry: normalized,
  };
  const findings = verifyRegistryProposal(proposal);
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length) throw new Error(errors.map((finding) => finding.message).join("\n"));
  const outputPath = path.resolve(cwd, options.output ?? path.join("dist", "registry-proposal.json"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  return { proposal, outputPath };
}

export function verifyRegistryProposal(proposal: RegistryProposal): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  if (proposal.schema_version !== 1) findings.push(error("Registry proposal schema_version must be 1."));
  if (!proposal.registry_id) findings.push(error("Registry proposal requires registry_id."));
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(proposal.version)) findings.push(error("Registry proposal requires a semantic version."));
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(proposal.repo_url)) findings.push(error("repo_url must be a canonical HTTPS GitHub repository URL."));
  if (!safePath(proposal.manifest_path)) findings.push(error("manifest_path must be a safe repository-relative path."));
  if (proposal.ref !== `v${proposal.version}`) findings.push(error(`Release ref must be v${proposal.version}.`));
  const entry = object(proposal.proposed_entry);
  for (const field of ["id", "name", "version", "type", "trust_level", "risk_level", "description", "platforms", "owner", "repo_name", "repo_url", "manifest_path", "maintainer", "marketplace"]) {
    if (entry[field] === undefined || entry[field] === "") findings.push(error(`Proposed registry entry is missing ${field}.`));
  }
  if (text(entry.id) !== proposal.registry_id) findings.push(error("Proposal and entry registry IDs do not match."));
  if (text(entry.version) !== proposal.version) findings.push(error("Proposal and entry versions do not match."));
  if (proposal.kind === "widget") {
    if (text(entry.type) !== "widget") findings.push(error("Widget proposal entry type must be widget."));
    const artifact = object(entry.artifact);
    if (!safePath(text(artifact.release_asset)) || !safePath(text(artifact.manifest_asset))) findings.push(error("Widget proposal requires safe release and manifest asset names."));
    const integrity = text(artifact.integrity);
    if (integrity && !/^sha256:[a-f0-9]{64}$/.test(integrity)) findings.push(error("Widget artifact integrity must be a SHA-256 digest."));
  }
  if (!findings.length) findings.push({ level: "info", message: `${proposal.registry_id} registry proposal is valid.` });
  return findings;
}

export async function readAndVerifyRegistryProposal(file: string): Promise<RegistryFinding[]> {
  return verifyRegistryProposal(await readJson(path.resolve(file)) as RegistryProposal);
}

export async function submitRegistryProposal(file: string, registryRepo = "PiPhi-io/piphi-nework-registry"): Promise<void> {
  const proposal = await readJson(path.resolve(file)) as RegistryProposal;
  const errors = verifyRegistryProposal(proposal).filter((finding) => finding.level === "error");
  if (errors.length) throw new Error(errors.map((finding) => finding.message).join("\n"));
  const args = [
    "workflow", "run", ".github/workflows/publish-registry-proposal.yml",
    "--repo", registryRepo,
    "--ref", "main",
    "-f", `registry_id=${proposal.registry_id}`,
    "-f", `entry_type=${proposal.kind}`,
    "-f", `repo_url=${proposal.repo_url}`,
    "-f", `manifest_path=${proposal.manifest_path}`,
    "-f", `ref=${proposal.ref}`,
  ];
  if (proposal.artifact_integrity) args.push("-f", `artifact_integrity=${proposal.artifact_integrity}`);
  await run("gh", args, process.cwd());
}

async function resolveSource(cwd: string, requested?: RegistryKind): Promise<{ kind: RegistryKind; path: string }> {
  const widget = path.join(cwd, "package.source.json");
  const integration = [path.join(cwd, "manifest.json"), path.join(cwd, "src", "manifest.json")].find(existsSync);
  if (requested === "widget") {
    if (!existsSync(widget)) throw new Error(`Widget manifest not found: ${widget}`);
    return { kind: "widget", path: widget };
  }
  if (requested === "integration") {
    if (!integration) throw new Error("Integration manifest not found at manifest.json or src/manifest.json.");
    return { kind: "integration", path: integration };
  }
  if (existsSync(widget)) return { kind: "widget", path: widget };
  if (integration) return { kind: "integration", path: integration };
  throw new Error("Could not infer project kind. Expected package.source.json or an integration manifest.");
}

function widgetEntry(source: JsonObject, artifactManifest: JsonObject | undefined, repoUrl: string, manifestPath: string): JsonObject {
  const identity = object(source.identity);
  const publisherId = text(identity.publisher_id);
  const packageId = text(identity.package_id);
  const version = text(identity.version);
  const registryId = `${publisherId}.${packageId}`;
  const repo = parseRepo(repoUrl);
  const artifact = object(artifactManifest?.artifact);
  const digest = text(artifact.digest);
  const widgets = Array.isArray(source.widgets) ? source.widgets.map(object) : [];
  const capabilities = [...new Set(widgets.flatMap((widget) => (Array.isArray(widget.binding_slots) ? widget.binding_slots.map(object) : []).flatMap((slot) => Array.isArray(slot.capability_requirements) ? slot.capability_requirements.map(String) : [])))];
  return {
    id: registryId,
    name: text(source.name) || packageId,
    version,
    type: "widget",
    deployment_mode: "standalone",
    trust_level: "community",
    risk_level: "low",
    description: text(source.description) || `${text(source.name) || packageId} dashboard widgets.`,
    rewardable: false,
    platforms: ["web"],
    owner: repo.owner,
    repo_name: repo.name,
    repo_url: repoUrl,
    ref: `v${version}`,
    manifest_path: manifestPath,
    artifact: {
      release_asset: `${packageId}-${version}.zip`,
      manifest_asset: `${packageId}-${version}.manifest.json`,
      integrity: digest || null,
    },
    tags: [packageId, "dashboard", "widget-sdk"],
    runtime_requirements: [],
    maintainer: { name: repo.owner, website: repoUrl, support_email: "support@piphi.io" },
    marketplace: source.marketplace ?? defaultWidgetMarketplace(source, repoUrl, capabilities),
  };
}

function integrationEntry(source: JsonObject, repoUrl: string, manifestPath: string): JsonObject {
  const repo = parseRepo(repoUrl);
  const runtime = object(source.runtime);
  const linux = object(runtime.linux);
  const container = object(linux.container);
  const image = text(source.image) || text(container.image);
  const marketplace = object(source.marketplace);
  const deployment = text(source.deployment_mode) || "standalone";
  return {
    id: text(source.id),
    name: text(source.name),
    version: text(source.version),
    type: deployment === "sidecar" ? "platform_service" : "integration",
    ...(deployment === "sidecar" ? { deployment_mode: "sidecar" } : {}),
    trust_level: "community",
    risk_level: inferRisk(source, deployment),
    description: text(source.description),
    rewardable: false,
    platforms: Array.isArray(source.platforms) && source.platforms.length ? source.platforms : ["linux"],
    ...(image ? { image } : {}),
    owner: repo.owner,
    repo_name: repo.name,
    repo_url: repoUrl,
    ref: `v${text(source.version)}`,
    manifest_path: manifestPath,
    runtime_requirements: Array.isArray(source.runtime_requirements) ? source.runtime_requirements : [],
    maintainer: source.maintainer ?? { name: repo.owner, website: repoUrl },
    marketplace,
  };
}

function defaultWidgetMarketplace(source: JsonObject, repoUrl: string, capabilities: string[]): JsonObject {
  const name = text(source.name) || text(object(source.identity).package_id);
  return {
    metadata_version: 2,
    display_name: name,
    summary: text(source.description) || `${name} dashboard widgets.`,
    category: "other",
    regions: ["WW"],
    languages: ["en"],
    publisher: { name: parseRepo(repoUrl).owner, website_url: repoUrl, support_url: `${repoUrl}/issues`, security_contact: "support@piphi.io" },
    access: [],
    compatibility: (capabilities.length ? capabilities : ["custom"]).map((capability) => ({ capability, host_protocol: "piphi.widget.host/1", widget_sdk: text(source.sdk_version_range) || ">=0.6.1,<0.7" })),
    documentation_url: repoUrl,
    support_url: `${repoUrl}/issues`,
    changelog_url: `${repoUrl}/releases`,
    quality_tier: "unrated",
    governance: { schema_version: 1, publication_status: "draft", rollout_percent: 0, lifecycle_status: "active", qualification: { status: "unverified" } },
  };
}

function inferRisk(source: JsonObject, deployment: string): string {
  const requirements = Array.isArray(source.runtime_requirements) ? source.runtime_requirements.map(String) : [];
  if (requirements.some((item) => ["privileged_container", "host_networking", "host_filesystem_mounts"].includes(item))) return "high";
  if (deployment === "sidecar" || requirements.length) return "moderate";
  return "low";
}

async function inferRepoUrl(cwd: string): Promise<string> {
  try { return (await capture("git", ["config", "--get", "remote.origin.url"], cwd)).trim(); }
  catch { return ""; }
}

function normalizeRepoUrl(value: string): string {
  return value.trim().replace(/^git@github\.com:/, "https://github.com/").replace(/^git\+/, "").replace(/\.git$/, "");
}

function parseRepo(repoUrl: string): { owner: string; name: string } {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repoUrl);
  if (!match) throw new Error("Only canonical GitHub repository URLs are currently supported.");
  return { owner: match[1], name: match[2] };
}

function safePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function error(message: string): RegistryFinding { return { level: "error", message }; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
async function readJson(file: string): Promise<JsonObject> { return object(JSON.parse(await readFile(file, "utf8"))); }

async function capture(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)));
  });
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}.`)));
  });
}
