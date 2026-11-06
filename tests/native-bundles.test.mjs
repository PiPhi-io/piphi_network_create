import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { zipSync } from "fflate";

import {
  buildNativeConformanceReport,
  initializeNativeBundleConfig,
  mergeNativeArtifactSets,
  packageNativeBundle,
  validateNativeArtifactSet,
} from "../dist/native-bundles.js";

function nativePlatform() {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  return "linux";
}

function nativeArchitecture() {
  return arch() === "arm64" ? "arm64" : "amd64";
}

test("native init creates a fail-closed target authoring config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piphi-native-init-"));
  await writeManifest(root);

  const output = await initializeNativeBundleConfig({
    cwd: root,
    binary: "dist/binary/awair",
    platform: nativePlatform(),
    architecture: nativeArchitecture(),
    identity: "release@piphi.example",
    artifactBaseUrl: "https://downloads.example/awair/0.2.0",
  });
  const config = JSON.parse(await readFile(output, "utf8"));

  assert.equal(config.contract, "piphi.native-bundle-authoring.v1");
  assert.equal(config.package_id, "awair-element-local-api");
  assert.equal(config.package_version, "0.2.0");
  assert.equal(config.bundle.endpoint.port, 8090);
  assert.deepEqual(config.bundle.endpoint.allowed_path_prefixes, ["/health", "/command"]);
  assert.equal(
    config.signing.kind,
    nativePlatform() === "linux"
      ? "sigstore"
      : nativePlatform() === "windows"
        ? "authenticode"
        : "developer_id",
  );
});

test(
  "native package emits a signed, reproducible, locally valid artifact set",
  { skip: nativePlatform() !== "linux" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "piphi-native-package-"));
    await writeManifest(root);
    const binary = path.join(root, "dist", "binary", "awair");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);
    await initializeNativeBundleConfig({
      cwd: root,
      binary: "dist/binary/awair",
      platform: "linux",
      architecture: nativeArchitecture(),
      identity: "release@piphi.example",
      artifactBaseUrl: "https://downloads.example/awair/0.2.0",
    });
    const tools = await installFakeTools(root);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
    try {
      const output = await packageNativeBundle({
        cwd: root,
        sourceRevision: "a".repeat(40),
      });
      const validation = await validateNativeArtifactSet({
        manifestPath: output.manifestPath,
        artifactDir: path.dirname(output.manifestPath),
      });
      assert.deepEqual(validation, { valid: true, errors: [] });
      const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
      assert.equal(manifest.contract, "piphi.native-artifact-set.v1");
      assert.equal(manifest.artifacts[0].signature.kind, "sigstore");
      assert.match(manifest.artifacts[0].signature_bundle, /^https:\/\//);

      const bytes = await readFile(output.archivePath);
      const repeated = await packageNativeBundle({
        cwd: root,
        sourceRevision: "a".repeat(40),
      });
      assert.deepEqual(await readFile(repeated.archivePath), bytes);

      const macManifest = structuredClone(manifest);
      macManifest.artifacts[0].platform = "macos";
      macManifest.artifacts[0].signature.kind = "developer_id";
      delete macManifest.artifacts[0].signature_bundle;
      const macManifestPath = path.join(root, "dist", "native", "macos.native-artifact-set.json");
      await writeFile(macManifestPath, `${JSON.stringify(macManifest, null, 2)}\n`, "utf8");
      const mergedPath = path.join(root, "dist", "native", "all.native-artifact-set.json");
      const reversePath = path.join(root, "dist", "native", "all-reverse.native-artifact-set.json");
      await mergeNativeArtifactSets({
        manifestPaths: [macManifestPath, output.manifestPath],
        outputPath: mergedPath,
      });
      await mergeNativeArtifactSets({
        manifestPaths: [output.manifestPath, macManifestPath],
        outputPath: reversePath,
      });
      const merged = JSON.parse(await readFile(mergedPath, "utf8"));
      assert.deepEqual(
        merged.artifacts.map((artifact) => `${artifact.platform}/${artifact.architecture}`),
        [`linux/${nativeArchitecture()}`, `macos/${nativeArchitecture()}`],
      );
      assert.deepEqual(await readFile(mergedPath), await readFile(reversePath));

      const report = await buildNativeConformanceReport({ manifestPath: mergedPath });
      assert.equal(report.portable.status, "passed");
      assert.equal(report.qualification.status, "not_qualified");
      assert.ok(report.targets.every((target) => target.native_qualification === "not_qualified"));

      const unsafeArchive = zipSync({
        "../escape": new TextEncoder().encode("escape"),
        "bin/awair": new TextEncoder().encode("binary"),
        "piphi-runtime.json": new TextEncoder().encode(
          JSON.stringify({
            contract: "piphi.native-runtime-bundle.v1",
            package_id: manifest.package_id,
            package_version: manifest.package_version,
            entrypoint: "bin/awair",
            args: [],
            environment: {},
            working_directory: ".",
          }),
        ),
      });
      const unsafeArchivePath = path.join(root, "dist", "native", "unsafe.zip");
      await writeFile(unsafeArchivePath, unsafeArchive);
      const unsafeDigest = createHash("sha256").update(unsafeArchive).digest("hex");
      const unsafeProvenancePath = path.join(root, "dist", "native", "unsafe.intoto.jsonl");
      await writeFile(
        unsafeProvenancePath,
        `${JSON.stringify({ subject: [{ digest: { sha256: unsafeDigest } }] })}\n`,
        "utf8",
      );
      const unsafeManifest = structuredClone(manifest);
      unsafeManifest.artifacts[0].url = "https://downloads.example/unsafe.zip";
      unsafeManifest.artifacts[0].digest = `sha256:${unsafeDigest}`;
      unsafeManifest.artifacts[0].size_bytes = unsafeArchive.byteLength;
      unsafeManifest.artifacts[0].provenance = "https://downloads.example/unsafe.intoto.jsonl";
      const unsafeManifestPath = path.join(root, "dist", "native", "unsafe-manifest.json");
      await writeFile(unsafeManifestPath, `${JSON.stringify(unsafeManifest, null, 2)}\n`, "utf8");
      const unsafeValidation = await validateNativeArtifactSet({ manifestPath: unsafeManifestPath });
      assert.equal(unsafeValidation.valid, false);
      assert.ok(
        unsafeValidation.errors.some((error) => error.includes("unsafe member path")),
        unsafeValidation.errors.join("\n"),
      );

      const wrongRevision = structuredClone(macManifest);
      wrongRevision.source_revision = "b".repeat(40);
      const wrongRevisionPath = path.join(root, "dist", "native", "wrong-revision.json");
      await writeFile(wrongRevisionPath, `${JSON.stringify(wrongRevision, null, 2)}\n`, "utf8");
      await assert.rejects(
        mergeNativeArtifactSets({
          manifestPaths: [output.manifestPath, wrongRevisionPath],
          outputPath: mergedPath,
        }),
        /source_revision does not match/,
      );

      await writeFile(output.archivePath, Buffer.concat([bytes, Buffer.from("tampered")]));
      const tampered = await validateNativeArtifactSet({
        manifestPath: output.manifestPath,
        artifactDir: path.dirname(output.manifestPath),
      });
      assert.equal(tampered.valid, false);
      assert.ok(tampered.errors.some((error) => error.includes("size mismatch")));
    } finally {
      process.env.PATH = previousPath;
    }
  },
);

test("native package rejects unknown authoring fields before invoking tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piphi-native-invalid-"));
  await writeManifest(root);
  const binary = path.join(root, "awair");
  await writeFile(binary, "binary", "utf8");
  const config = {
    contract: "piphi.native-bundle-authoring.v1",
    package_id: "awair-element-local-api",
    package_version: "0.2.0",
    binary: "awair",
    target: { platform: nativePlatform(), architecture: nativeArchitecture() },
    bundle: {
      entrypoint: "bin/awair",
      args: [],
      environment: {},
      working_directory: ".",
      unexpected: true,
    },
    signing: {
      kind:
        nativePlatform() === "linux"
          ? "sigstore"
          : nativePlatform() === "windows"
            ? "authenticode"
            : "developer_id",
      identity: "release@piphi.example",
      sigstore_issuer: "https://token.actions.githubusercontent.com",
      apple_notary_profile: "piphi-notary",
    },
    artifact_base_url: "https://downloads.example/awair/0.2.0",
  };
  await writeFile(path.join(root, "native-bundle.json"), JSON.stringify(config), "utf8");

  await assert.rejects(
    packageNativeBundle({ cwd: root, sourceRevision: "a".repeat(40) }),
    /bundle contains unknown fields: unexpected/,
  );
});

async function writeManifest(root) {
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      id: "awair-element-local-api",
      version: "0.2.0",
      runtime: { linux: { container: { ports: [{ container: 8090 }] } } },
      api: { endpoints: { health: "/health", command: "/command" } },
    }),
    "utf8",
  );
}

async function installFakeTools(root) {
  const directory = path.join(root, "fake-tools");
  await mkdir(directory, { recursive: true });
  const syft = path.join(directory, "syft");
  await writeFile(
    syft,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    spdx-json=*) output="\${arg#spdx-json=}" ;;
  esac
done
printf '%s\n' '{"spdxVersion":"SPDX-2.3","name":"test"}' > "$output"
`,
    "utf8",
  );
  const cosign = path.join(directory, "cosign");
  await writeFile(
    cosign,
    `#!/bin/sh
if [ "$1" = "sign-blob" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--bundle" ]; then shift; bundle="$1"; fi
    shift
  done
  printf '%s\n' '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}' > "$bundle"
fi
exit 0
`,
    "utf8",
  );
  await chmod(syft, 0o755);
  await chmod(cosign, 0o755);
  return directory;
}
