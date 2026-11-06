import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch as hostArchitecture, platform as hostPlatform, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Ajv2020 } from "ajv/dist/2020.js";
import { unzipSync, zipSync, type Zippable } from "fflate";

type JsonObject = Record<string, unknown>;
type NativePlatform = "linux" | "windows" | "macos";
type NativeArchitecture = "amd64" | "arm64";
type SignatureKind = "authenticode" | "developer_id" | "sigstore";

const MAX_ARCHIVE_MEMBERS = 10_000;
const MAX_METADATA_BYTES = 10 * 1024 * 1024;

export type NativeBundleAuthoringConfig = {
  contract: "piphi.native-bundle-authoring.v1";
  package_id: string;
  package_version: string;
  binary: string;
  target: {
    platform: NativePlatform;
    architecture: NativeArchitecture;
    minimum_os_version?: string;
  };
  bundle: {
    entrypoint: string;
    args: string[];
    environment: Record<string, string>;
    working_directory: string;
    endpoint?: {
      port: number;
      allowed_path_prefixes: string[];
      allowed_methods: string[];
    };
  };
  signing: {
    kind: SignatureKind;
    identity: string;
    sigstore_issuer?: string;
    timestamp_url?: string;
    apple_notary_profile?: string;
  };
  artifact_base_url: string;
};

export type PackageNativeBundleOptions = {
  cwd?: string;
  config?: string;
  outputDir?: string;
  sourceRevision?: string;
};

export type NativeBundleOutput = {
  manifestPath: string;
  archivePath: string;
  sbomPath: string;
  provenancePath: string;
  signatureBundlePath?: string;
};

export type NativeValidationResult = {
  valid: boolean;
  errors: string[];
};

export type NativeConformanceReport = {
  contract: "piphi.native-conformance-report.v1";
  manifest: string;
  package_id: string | null;
  package_version: string | null;
  source_revision: string | null;
  portable: {
    status: "passed" | "failed";
    scope: string[];
    errors: string[];
  };
  targets: Array<{
    platform: string;
    architecture: string;
    portable_status: "passed" | "failed";
    native_qualification: "not_qualified";
    required_native_evidence: string[];
  }>;
  qualification: {
    status: "not_qualified";
    statement: string;
  };
};

const schemaText = await readFile(
  new URL("../contracts/runtime/native-artifact-set.v1.schema.json", import.meta.url),
  "utf8",
);
const artifactSetSchema: unknown = JSON.parse(schemaText);
const artifactAjv = new Ajv2020({ allErrors: true, strict: false });
artifactAjv.addFormat("uri", {
  type: "string",
  validate(value: string) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
});
const validateArtifactSetSchema = artifactAjv.compile(artifactSetSchema as JsonObject);

export async function initializeNativeBundleConfig(options: {
  cwd?: string;
  binary: string;
  platform?: NativePlatform;
  architecture?: NativeArchitecture;
  identity: string;
  artifactBaseUrl: string;
  force?: boolean;
}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = asObject(JSON.parse(await readFile(path.join(cwd, "manifest.json"), "utf8")));
  const packageId = requireSafeName(manifest.id, "manifest.id");
  const packageVersion = requireSafeName(manifest.version, "manifest.version");
  const targetPlatform = options.platform ?? currentPlatform();
  const architecture = options.architecture ?? currentArchitecture();
  const runtime = asObject(manifest.runtime);
  const linux = asObject(runtime.linux);
  const container = asObject(linux.container);
  const ports = Array.isArray(container.ports) ? container.ports : [];
  const port = Number(asObject(ports[0]).container ?? 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("manifest runtime port must be between 1 and 65535");
  }
  const endpoints = Object.values(asObject(asObject(manifest.api).endpoints))
    .filter((value): value is string => typeof value === "string" && isSafeLocalPath(value));
  const signatureKind = expectedSignatureKind(targetPlatform);
  const binaryName = path.basename(options.binary);
  const config: NativeBundleAuthoringConfig = {
    contract: "piphi.native-bundle-authoring.v1",
    package_id: packageId,
    package_version: packageVersion,
    binary: options.binary,
    target: {
      platform: targetPlatform,
      architecture,
    },
    bundle: {
      entrypoint: `bin/${binaryName}`,
      args: [],
      environment: {},
      working_directory: ".",
      endpoint: {
        port,
        allowed_path_prefixes: [...new Set(endpoints.length > 0 ? endpoints : ["/health", "/command"])],
        allowed_methods: ["GET", "POST"],
      },
    },
    signing: {
      kind: signatureKind,
      identity: options.identity,
      ...(signatureKind === "sigstore"
        ? { sigstore_issuer: "https://token.actions.githubusercontent.com" }
        : {}),
      ...(signatureKind === "authenticode"
        ? { timestamp_url: "http://timestamp.digicert.com" }
        : {}),
    },
    artifact_base_url: normalizeHttpsOrigin(options.artifactBaseUrl),
  };
  const output = path.join(cwd, "native-bundle.json");
  if (existsSync(output) && !options.force) {
    throw new Error("native-bundle.json already exists; pass --force to replace it");
  }
  await writeJson(output, config);
  return output;
}

export async function packageNativeBundle(
  options: PackageNativeBundleOptions = {},
): Promise<NativeBundleOutput> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.config ?? "native-bundle.json");
  const config = validateAuthoringConfig(JSON.parse(await readFile(configPath, "utf8")));
  requireNativeHost(config.target.platform, config.target.architecture);
  const binaryPath = confinedProjectPath(cwd, config.binary);
  const binaryStats = await stat(binaryPath);
  if (!binaryStats.isFile() || binaryStats.size < 1) {
    throw new Error(`native binary is not a non-empty file: ${config.binary}`);
  }

  const sourceRevision = options.sourceRevision ?? gitRevision(cwd);
  if (!/^[a-f0-9]{40,64}$/.test(sourceRevision)) {
    throw new Error("source revision must contain 40 to 64 lowercase hexadecimal characters");
  }
  const outputDir = path.resolve(cwd, options.outputDir ?? "dist/native");
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(tmpdir(), "piphi-native-bundle-"));
  try {
    const entrypoint = confinedRelativePath(staging, config.bundle.entrypoint);
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await copyFile(binaryPath, entrypoint);
    if (config.target.platform !== "windows") await chmod(entrypoint, 0o755);
    await signEntrypoint(config, entrypoint, cwd);

    const descriptor = {
      contract: "piphi.native-runtime-bundle.v1",
      package_id: config.package_id,
      package_version: config.package_version,
      entrypoint: normalizeArchivePath(config.bundle.entrypoint),
      args: config.bundle.args,
      environment: config.bundle.environment,
      working_directory: normalizeArchivePath(config.bundle.working_directory),
      ...(config.bundle.endpoint ? { endpoint: config.bundle.endpoint } : {}),
    };
    await writeJson(path.join(staging, "piphi-runtime.json"), descriptor);

    const stem = [
      config.package_id,
      config.package_version,
      config.target.platform,
      config.target.architecture,
    ].join("-");
    const archivePath = path.join(outputDir, `${stem}.zip`);
    await writeDeterministicZip(staging, archivePath);
    await finalizeNativeSignature(config, entrypoint, archivePath, cwd);

    const digest = await sha256File(archivePath);
    const archiveSize = (await stat(archivePath)).size;
    const sbomPath = path.join(outputDir, `${stem}.spdx.json`);
    run("syft", [archivePath, "-o", `spdx-json=${sbomPath}`], cwd);
    await requireSpdx(sbomPath);

    const provenancePath = path.join(outputDir, `${stem}.intoto.jsonl`);
    await writeJsonLine(provenancePath, {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: path.basename(archivePath), digest: { sha256: digest.slice(7) } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          buildType: "https://piphi.io/build/native-bundle/v1",
          externalParameters: {
            package_id: config.package_id,
            package_version: config.package_version,
            platform: config.target.platform,
            architecture: config.target.architecture,
          },
          resolvedDependencies: [{ uri: "git+source", digest: { gitCommit: sourceRevision } }],
        },
        runDetails: { builder: { id: "@piphi-network/cli" } },
      },
    });

    let signatureBundlePath: string | undefined;
    if (config.signing.kind === "sigstore") {
      signatureBundlePath = path.join(outputDir, `${stem}.sigstore.json`);
      run("cosign", ["sign-blob", "--yes", "--bundle", signatureBundlePath, archivePath], cwd);
      await requireFile(signatureBundlePath, "cosign did not produce a signature bundle");
      const issuer = config.signing.sigstore_issuer;
      if (!issuer) throw new Error("Sigstore packaging requires signing.sigstore_issuer");
      run(
        "cosign",
        [
          "verify-blob",
          "--bundle",
          signatureBundlePath,
          "--certificate-identity",
          config.signing.identity,
          "--certificate-oidc-issuer",
          issuer,
          archivePath,
        ],
        cwd,
      );
    }

    const baseUrl = config.artifact_base_url.replace(/\/$/, "");
    const artifact = {
      platform: config.target.platform,
      architecture: config.target.architecture,
      ...(config.target.minimum_os_version
        ? { minimum_os_version: config.target.minimum_os_version }
        : {}),
      format: "zip",
      url: `${baseUrl}/${encodeURIComponent(path.basename(archivePath))}`,
      digest,
      size_bytes: archiveSize,
      entrypoint: normalizeArchivePath(config.bundle.entrypoint),
      signature: {
        kind: config.signing.kind,
        identity: config.signing.identity,
        verified: true,
      },
      ...(signatureBundlePath
        ? {
            signature_bundle: `${baseUrl}/${encodeURIComponent(path.basename(signatureBundlePath))}`,
          }
        : {}),
      sbom: `${baseUrl}/${encodeURIComponent(path.basename(sbomPath))}`,
      provenance: `${baseUrl}/${encodeURIComponent(path.basename(provenancePath))}`,
    };
    const artifactSet = {
      contract: "piphi.native-artifact-set.v1",
      package_id: config.package_id,
      package_version: config.package_version,
      source_revision: sourceRevision,
      runtime_contract: "piphi.runtime-http.v1",
      artifacts: [artifact],
    };
    const manifestPath = path.join(outputDir, `${stem}.native-artifact-set.json`);
    await writeJson(manifestPath, artifactSet);
    const validation = await validateNativeArtifactSet({ manifestPath, artifactDir: outputDir });
    if (!validation.valid) throw new Error(validation.errors.join("\n"));
    return { manifestPath, archivePath, sbomPath, provenancePath, signatureBundlePath };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function validateNativeArtifactSet(options: {
  manifestPath: string;
  artifactDir?: string;
}): Promise<NativeValidationResult> {
  const manifestPath = path.resolve(options.manifestPath);
  const artifactDir = path.resolve(options.artifactDir ?? path.dirname(manifestPath));
  const errors: string[] = [];
  let manifest: JsonObject;
  try {
    manifest = asObject(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    return { valid: false, errors: [`manifest is not valid JSON: ${errorMessage(error)}`] };
  }
  if (!validateArtifactSetSchema(manifest)) {
    errors.push(
      ...(validateArtifactSetSchema.errors ?? []).map(
        (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      ),
    );
    return { valid: false, errors };
  }
  const packageId = String(manifest.package_id);
  const packageVersion = String(manifest.package_version);
  validateArtifactSemantics(manifest, errors);
  for (const rawArtifact of manifest.artifacts as JsonObject[]) {
    const artifact = asObject(rawArtifact);
    const archivePath = localArtifactPath(artifactDir, String(artifact.url));
    const sbomPath = localArtifactPath(artifactDir, String(artifact.sbom));
    const provenancePath = localArtifactPath(artifactDir, String(artifact.provenance));
    try {
      await requireFile(archivePath, `archive is missing: ${archivePath}`);
      const actualSize = (await stat(archivePath)).size;
      if (actualSize !== artifact.size_bytes) errors.push(`archive size mismatch: ${archivePath}`);
      const digest = await sha256File(archivePath);
      if (digest !== artifact.digest) errors.push(`archive digest mismatch: ${archivePath}`);
      await requireSpdx(sbomPath);
      await requireProvenanceSubject(provenancePath, digest);
      if (artifact.signature_bundle) {
        await requireFile(
          localArtifactPath(artifactDir, String(artifact.signature_bundle)),
          "signature bundle is missing",
        );
      }
      const inspected = await inspectZipBundle(
        archivePath,
        String(artifact.entrypoint),
        actualSize,
      );
      const descriptorBytes = inspected.descriptor;
      if (!descriptorBytes) {
        errors.push("archive does not contain piphi-runtime.json");
      } else {
        const descriptor = asObject(JSON.parse(Buffer.from(descriptorBytes).toString("utf8")));
        if (descriptor.contract !== "piphi.native-runtime-bundle.v1") {
          errors.push("bundle descriptor contract is invalid");
        }
        if (descriptor.package_id !== packageId || descriptor.package_version !== packageVersion) {
          errors.push("bundle descriptor package identity does not match artifact set");
        }
        const entrypoint = String(descriptor.entrypoint ?? "");
        if (entrypoint !== artifact.entrypoint || !inspected.entrypointPresent) {
          errors.push("bundle entrypoint does not match the archive");
        }
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return { valid: errors.length === 0, errors };
}

async function inspectZipBundle(
  archivePath: string,
  expectedEntrypoint: string,
  archiveSize: number,
): Promise<{ descriptor?: Uint8Array; entrypointPresent: boolean }> {
  let members = 0;
  let unpackedBytes = 0;
  let entrypointPresent = false;
  let descriptorCount = 0;
  const names = new Set<string>();
  const maximumUnpackedBytes = Math.min(
    4_294_967_296,
    Math.max(64 * 1024 * 1024, archiveSize * 20),
  );
  const archive = unzipSync(new Uint8Array(await readFile(archivePath)), {
    filter(file) {
      members += 1;
      if (members > MAX_ARCHIVE_MEMBERS) throw new Error("archive contains too many members");
      validateArchiveMemberName(file.name);
      if (names.has(file.name)) throw new Error(`archive contains duplicate member: ${file.name}`);
      names.add(file.name);
      unpackedBytes += file.originalSize;
      if (unpackedBytes > maximumUnpackedBytes) throw new Error("archive expands beyond the size limit");
      if (file.name === expectedEntrypoint) entrypointPresent = true;
      if (file.name === "piphi-runtime.json") {
        descriptorCount += 1;
        if (file.originalSize > MAX_METADATA_BYTES) {
          throw new Error("bundle descriptor exceeds the metadata size limit");
        }
        return true;
      }
      return false;
    },
  });
  if (descriptorCount > 1) throw new Error("archive contains duplicate bundle descriptors");
  return { descriptor: archive["piphi-runtime.json"], entrypointPresent };
}

function validateArchiveMemberName(name: string): void {
  const withoutDirectorySuffix = name.endsWith("/") ? name.slice(0, -1) : name;
  const parts = withoutDirectorySuffix.split("/");
  if (
    !withoutDirectorySuffix ||
    name.includes("\0") ||
    name.includes("\\") ||
    withoutDirectorySuffix.startsWith("/") ||
    withoutDirectorySuffix.includes(":") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`archive contains an unsafe member path: ${name}`);
  }
}

export async function mergeNativeArtifactSets(options: {
  manifestPaths: string[];
  outputPath: string;
}): Promise<string> {
  if (options.manifestPaths.length < 2) {
    throw new Error("native merge requires at least two artifact-set manifests");
  }
  const manifests: Array<{ path: string; document: JsonObject }> = [];
  for (const input of options.manifestPaths) {
    const manifestPath = path.resolve(input);
    const validation = await validateNativeArtifactSet({ manifestPath });
    if (!validation.valid) {
      throw new Error(`${manifestPath} is invalid:\n${validation.errors.join("\n")}`);
    }
    manifests.push({
      path: manifestPath,
      document: asObject(JSON.parse(await readFile(manifestPath, "utf8"))),
    });
  }

  const first = manifests[0].document;
  for (const candidate of manifests.slice(1)) {
    for (const field of ["package_id", "package_version", "source_revision", "runtime_contract"]) {
      if (candidate.document[field] !== first[field]) {
        throw new Error(
          `cannot merge ${candidate.path}: ${field} does not match ${manifests[0].path}`,
        );
      }
    }
  }

  const artifacts = manifests
    .flatMap(({ document }) => document.artifacts as JsonObject[])
    .map(normalizeArtifactForOutput)
    .sort(compareArtifacts);
  const targets = new Set<string>();
  for (const artifact of artifacts) {
    const target = artifactTarget(artifact);
    if (targets.has(target)) throw new Error(`cannot merge duplicate native target: ${target}`);
    targets.add(target);
  }

  const merged = {
    contract: "piphi.native-artifact-set.v1",
    package_id: first.package_id,
    package_version: first.package_version,
    source_revision: first.source_revision,
    runtime_contract: first.runtime_contract,
    artifacts,
  };
  if (!validateArtifactSetSchema(merged)) {
    throw new Error(
      `merged artifact set is invalid:\n${(validateArtifactSetSchema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("\n")}`,
    );
  }
  const semanticErrors: string[] = [];
  validateArtifactSemantics(merged, semanticErrors);
  if (semanticErrors.length > 0) {
    throw new Error(`merged artifact set is invalid:\n${semanticErrors.join("\n")}`);
  }

  const outputPath = path.resolve(options.outputPath);
  await writeJson(outputPath, merged);
  return outputPath;
}

export async function buildNativeConformanceReport(options: {
  manifestPath: string;
  artifactDir?: string;
}): Promise<NativeConformanceReport> {
  const manifestPath = path.resolve(options.manifestPath);
  let manifest: JsonObject = {};
  try {
    manifest = asObject(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch {
    // The validator provides the actionable parse error in the report.
  }
  const validation = await validateNativeArtifactSet(options);
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((artifact) => asObject(artifact)).sort(compareArtifacts)
    : [];
  return {
    contract: "piphi.native-conformance-report.v1",
    manifest: manifestPath,
    package_id: typeof manifest.package_id === "string" ? manifest.package_id : null,
    package_version: typeof manifest.package_version === "string" ? manifest.package_version : null,
    source_revision: typeof manifest.source_revision === "string" ? manifest.source_revision : null,
    portable: {
      status: validation.valid ? "passed" : "failed",
      scope: [
        "artifact-set schema and target policy",
        "local file presence, size, and SHA-256 digest",
        "SPDX SBOM and in-toto provenance linkage",
        "bundle descriptor identity and entrypoint layout",
      ],
      errors: validation.errors,
    },
    targets: artifacts.map((artifact) => ({
      platform: String(artifact.platform ?? "unknown"),
      architecture: String(artifact.architecture ?? "unknown"),
      portable_status: validation.valid ? "passed" : "failed",
      native_qualification: "not_qualified",
      required_native_evidence: nativeQualificationEvidence(String(artifact.platform ?? "")),
    })),
    qualification: {
      status: "not_qualified",
      statement:
        "Portable conformance is not native qualification. Qualify each target on its native host with real signing trust and Chief lifecycle, containment, networking, and cleanup tests.",
    },
  };
}

export function formatNativeConformanceReport(report: NativeConformanceReport): string {
  const lines = [
    `Portable conformance: ${report.portable.status.toUpperCase()}`,
    `Package: ${report.package_id ?? "unknown"}@${report.package_version ?? "unknown"}`,
    `Source revision: ${report.source_revision ?? "unknown"}`,
    "",
  ];
  for (const target of report.targets) {
    lines.push(
      `${target.platform}/${target.architecture}: portable=${target.portable_status}, native=${target.native_qualification}`,
    );
  }
  if (report.portable.errors.length > 0) {
    lines.push("", "Errors:", ...report.portable.errors.map((error) => `- ${error}`));
  }
  lines.push("", `Qualification: ${report.qualification.status}`, report.qualification.statement);
  return `${lines.join("\n")}\n`;
}

export async function publishNativeArtifactSet(options: {
  manifestPath: string;
  tag: string;
  repository?: string;
  artifactDir?: string;
}): Promise<void> {
  const manifestPath = path.resolve(options.manifestPath);
  const artifactDir = path.resolve(options.artifactDir ?? path.dirname(manifestPath));
  const validation = await validateNativeArtifactSet({ manifestPath, artifactDir });
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  const manifest = asObject(JSON.parse(await readFile(manifestPath, "utf8")));
  const files = new Set<string>([manifestPath]);
  for (const artifact of manifest.artifacts as JsonObject[]) {
    for (const key of ["url", "sbom", "provenance", "signature_bundle"]) {
      if (artifact[key]) files.add(localArtifactPath(artifactDir, String(artifact[key])));
    }
  }
  const args = ["release", "upload", options.tag, ...[...files], "--clobber"];
  if (options.repository) args.push("--repo", options.repository);
  run("gh", args, process.cwd());
}

function validateArtifactSemantics(manifest: JsonObject, errors: string[]): void {
  const targets = new Set<string>();
  for (const rawArtifact of manifest.artifacts as JsonObject[]) {
    const artifact = asObject(rawArtifact);
    const target = artifactTarget(artifact);
    if (targets.has(target)) errors.push(`duplicate native target: ${target}`);
    targets.add(target);
    const platform = String(artifact.platform);
    const signature = asObject(artifact.signature);
    if (["linux", "windows", "macos"].includes(platform)) {
      const expected = expectedSignatureKind(platform as NativePlatform);
      if (signature.kind !== expected) {
        errors.push(`${target} requires ${expected} signing`);
      }
    }
  }
}

function compareArtifacts(left: JsonObject, right: JsonObject): number {
  return artifactTarget(left).localeCompare(artifactTarget(right));
}

function artifactTarget(artifact: JsonObject): string {
  return `${String(artifact.platform)}/${String(artifact.architecture)}`;
}

function normalizeArtifactForOutput(artifact: JsonObject): JsonObject {
  const signature = asObject(artifact.signature);
  return {
    platform: artifact.platform,
    architecture: artifact.architecture,
    ...(artifact.minimum_os_version !== undefined
      ? { minimum_os_version: artifact.minimum_os_version }
      : {}),
    format: artifact.format,
    url: artifact.url,
    digest: artifact.digest,
    size_bytes: artifact.size_bytes,
    entrypoint: artifact.entrypoint,
    signature: {
      kind: signature.kind,
      identity: signature.identity,
      verified: signature.verified,
    },
    ...(artifact.signature_bundle !== undefined
      ? { signature_bundle: artifact.signature_bundle }
      : {}),
    sbom: artifact.sbom,
    provenance: artifact.provenance,
  };
}

function nativeQualificationEvidence(platform: string): string[] {
  const common = [
    "Chief admission with the production trust policy",
    "install, launch, readiness, virtual HTTP, graceful stop, and forced cleanup",
    "resource and log bounds plus whole-process-tree termination",
  ];
  if (platform === "windows") {
    return ["Authenticode verification on Windows", "Windows Job Object containment", ...common];
  }
  if (platform === "macos") {
    return ["Developer ID and notarization verification on macOS", ...common];
  }
  if (platform === "linux") {
    return ["Sigstore verification against the trusted OIDC issuer on Linux", ...common];
  }
  return common;
}

function validateAuthoringConfig(value: unknown): NativeBundleAuthoringConfig {
  const config = asObject(value);
  requireExactKeys(config, [
    "contract",
    "package_id",
    "package_version",
    "binary",
    "target",
    "bundle",
    "signing",
    "artifact_base_url",
  ], "native bundle config");
  if (config.contract !== "piphi.native-bundle-authoring.v1") {
    throw new Error("native bundle config contract is invalid");
  }
  requireSafeName(config.package_id, "package_id");
  requireSafeName(config.package_version, "package_version");
  if (typeof config.binary !== "string" || !config.binary) throw new Error("binary is required");
  const target = asObject(config.target);
  requireAllowedKeys(target, ["platform", "architecture", "minimum_os_version"], "target");
  const targetPlatform = String(target.platform) as NativePlatform;
  const architecture = String(target.architecture) as NativeArchitecture;
  if (!["linux", "windows", "macos"].includes(targetPlatform)) throw new Error("target platform is invalid");
  if (!["amd64", "arm64"].includes(architecture)) throw new Error("target architecture is invalid");
  const bundle = asObject(config.bundle);
  requireAllowedKeys(
    bundle,
    ["entrypoint", "args", "environment", "working_directory", "endpoint"],
    "bundle",
  );
  normalizeArchivePath(String(bundle.entrypoint ?? ""));
  normalizeArchivePath(String(bundle.working_directory ?? "."));
  if (!Array.isArray(bundle.args) || !bundle.args.every((item) => typeof item === "string")) {
    throw new Error("bundle args must contain strings");
  }
  const environment = asObject(bundle.environment);
  if (!Object.values(environment).every((item) => typeof item === "string")) {
    throw new Error("bundle environment values must be strings");
  }
  if (bundle.endpoint !== undefined) validateEndpoint(asObject(bundle.endpoint));
  const signing = asObject(config.signing);
  requireAllowedKeys(
    signing,
    ["kind", "identity", "sigstore_issuer", "timestamp_url", "apple_notary_profile"],
    "signing",
  );
  if (signing.kind !== expectedSignatureKind(targetPlatform)) {
    throw new Error(`${targetPlatform} requires ${expectedSignatureKind(targetPlatform)} signing`);
  }
  if (typeof signing.identity !== "string" || !signing.identity || signing.identity.length > 256) {
    throw new Error("signing identity is required");
  }
  if (
    signing.kind === "sigstore" &&
    (typeof signing.sigstore_issuer !== "string" || !signing.sigstore_issuer.startsWith("https://"))
  ) {
    throw new Error("Sigstore signing requires an HTTPS sigstore_issuer");
  }
  normalizeHttpsOrigin(String(config.artifact_base_url));
  return value as NativeBundleAuthoringConfig;
}

function validateEndpoint(endpoint: JsonObject): void {
  requireAllowedKeys(
    endpoint,
    ["port", "allowed_path_prefixes", "allowed_methods"],
    "endpoint",
  );
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("endpoint port is invalid");
  if (
    !Array.isArray(endpoint.allowed_path_prefixes) ||
    endpoint.allowed_path_prefixes.length === 0 ||
    !endpoint.allowed_path_prefixes.every((item) => typeof item === "string" && isSafeLocalPath(item))
  ) {
    throw new Error("endpoint path prefixes must be safe local paths");
  }
  const methods = endpoint.allowed_methods;
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    !methods.every((item) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(item)))
  ) {
    throw new Error("endpoint methods are invalid");
  }
}

async function signEntrypoint(
  config: NativeBundleAuthoringConfig,
  entrypoint: string,
  cwd: string,
): Promise<void> {
  if (config.signing.kind === "authenticode") {
    run(
      "signtool",
      [
        "sign",
        "/fd",
        "SHA256",
        "/td",
        "SHA256",
        "/tr",
        config.signing.timestamp_url ?? "http://timestamp.digicert.com",
        "/n",
        config.signing.identity,
        entrypoint,
      ],
      cwd,
    );
  } else if (config.signing.kind === "developer_id") {
    run(
      "codesign",
      ["--force", "--timestamp", "--options", "runtime", "--sign", config.signing.identity, entrypoint],
      cwd,
    );
  }
}

async function finalizeNativeSignature(
  config: NativeBundleAuthoringConfig,
  entrypoint: string,
  archivePath: string,
  cwd: string,
): Promise<void> {
  if (config.signing.kind === "authenticode") {
    run("signtool", ["verify", "/pa", "/v", entrypoint], cwd);
  } else if (config.signing.kind === "developer_id") {
    run("codesign", ["--verify", "--deep", "--strict", entrypoint], cwd);
    const profile = config.signing.apple_notary_profile;
    if (!profile) throw new Error("macOS packaging requires signing.apple_notary_profile");
    run("xcrun", ["notarytool", "submit", archivePath, "--keychain-profile", profile, "--wait"], cwd);
    run("spctl", ["--assess", "--type", "execute", entrypoint], cwd);
  }
}

async function writeDeterministicZip(root: string, destination: string): Promise<void> {
  const entries = await collectFiles(root);
  const files: Zippable = {};
  for (const relative of entries.sort()) {
    files[relative] = [
      new Uint8Array(await readFile(path.join(root, ...relative.split("/")))),
      { mtime: new Date(1980, 0, 1, 0, 0, 0) },
    ];
  }
  await writeFile(destination, zipSync(files, { level: 9 }));
}

async function collectFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`bundle input cannot contain symbolic links: ${next}`);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, next)));
    else if (entry.isFile()) result.push(next);
    else throw new Error(`bundle input contains an unsupported file: ${next}`);
  }
  return result;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${command} is required but was not found on PATH`);
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function gitRevision(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("unable to resolve source revision; pass --source-revision");
  return result.stdout.trim().toLowerCase();
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return `sha256:${digest.digest("hex")}`;
}

async function requireSpdx(file: string): Promise<void> {
  const payload = asObject(JSON.parse(await readFile(file, "utf8")));
  if (typeof payload.spdxVersion !== "string") throw new Error(`SBOM is not SPDX JSON: ${file}`);
}

async function requireProvenanceSubject(file: string, digest: string): Promise<void> {
  const statements = (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => asObject(JSON.parse(line)));
  const expected = digest.slice(7);
  const found = statements.some((statement) =>
    (Array.isArray(statement.subject) ? statement.subject : []).some(
      (subject) => asObject(asObject(subject).digest).sha256 === expected,
    ),
  );
  if (!found) throw new Error(`provenance does not name archive digest: ${file}`);
}

async function requireFile(file: string, message: string): Promise<void> {
  const details = await stat(file).catch(() => null);
  if (!details?.isFile() || details.size < 1) throw new Error(message);
}

function localArtifactPath(root: string, url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`artifact URL does not identify a safe local filename: ${url}`);
  }
  return path.join(root, name);
}

function confinedProjectPath(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes the project: ${value}`);
  }
  return resolved;
}

function confinedRelativePath(root: string, value: string): string {
  const normalized = normalizeArchivePath(value);
  return path.join(root, ...normalized.split("/"));
}

function normalizeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    parts.some((part) => part === ".." || part === "")
  ) {
    throw new Error(`archive path must remain relative: ${value}`);
  }
  if (normalized === ".") return normalized;
  return parts.filter((part) => part !== ".").join("/");
}

function requireNativeHost(targetPlatform: NativePlatform, targetArchitecture: NativeArchitecture): void {
  if (currentPlatform() !== targetPlatform || currentArchitecture() !== targetArchitecture) {
    throw new Error(
      `native bundles must be signed on their target host; requested ${targetPlatform}/${targetArchitecture}, ` +
        `running ${currentPlatform()}/${currentArchitecture()}`,
    );
  }
}

function currentPlatform(): NativePlatform {
  if (hostPlatform() === "win32") return "windows";
  if (hostPlatform() === "darwin") return "macos";
  if (hostPlatform() === "linux") return "linux";
  throw new Error(`unsupported native platform: ${hostPlatform()}`);
}

function currentArchitecture(): NativeArchitecture {
  if (["x64", "amd64"].includes(hostArchitecture())) return "amd64";
  if (["arm64", "aarch64"].includes(hostArchitecture())) return "arm64";
  throw new Error(`unsupported native architecture: ${hostArchitecture()}`);
}

function expectedSignatureKind(platform: NativePlatform): SignatureKind {
  if (platform === "windows") return "authenticode";
  if (platform === "macos") return "developer_id";
  return "sigstore";
}

function isSafeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "..")
  );
}

function normalizeHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("artifact base URL must be an HTTPS URL without credentials, query, or fragment");
  }
  return value.replace(/\/$/, "");
}

function requireSafeName(value: unknown, label: string): string {
  const normalized = String(value ?? "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be a safe package or version identifier`);
  }
  return normalized;
}

function requireExactKeys(value: JsonObject, keys: string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} fields are invalid` +
        (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "") +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function requireAllowedKeys(value: JsonObject, keys: string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonLine(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
