# piphi_network_create

TypeScript CLI for scaffolding PiPhi Network runtime integrations, sidecars, and Widget SDK packages.

Generated runtimes use managed-runtime contract v1: the manifest declares the preferred container port, Core allocates the host listener, and the process reads the assignment from `PORT`. Generated widget packages explicitly declare that listener ports are not applicable.

Install the unified PiPhi developer CLI:

```bash
npm install --global @piphi-network/cli
piphi create my-integration --language python
piphi validate -C ./my-integration
piphi doctor -C ./my-integration --url http://127.0.0.1:8090
piphi widget create "Room Climate" --publisher io.example --integration-id room-climate-local-api
```

The generator supports the current PiPhi runtime SDK languages:

- Node.js / TypeScript with `piphi-runtime-kit-node`
- Python / FastAPI with `piphi-runtime-kit-python`

## Develop

```bash
npm install
npm run build
npm test
node dist/index.js my-demo-integration --language node
```

Shared scaffold artifacts live under `src/templates/`. When intentional
template changes affect generated files, refresh the golden snapshots:

```bash
UPDATE_SNAPSHOTS=1 npm test
```

## Usage

```bash
piphi-network-create <name> --language node
piphi-network-create create <name> --language node
piphi-network-create <name> --language python --kind sidecar
piphi-network-create <name> --language python --preset cloud-polling-api --domain cloud-api --github-actions
piphi-network-create <name> --language python --binary-build
piphi-network-create <name> --template ./templates/vendor-cloud --set vendor=Kaiterra
piphi-network-create <name> --language node --preset webhook-receiver --package-manager pnpm
piphi-network-create <name> --language node --dry-run --print-tree
```

If you omit `name`, `language`, or `kind` in an interactive terminal, the CLI
will prompt for them with a guided flow. Runtime language and scaffold kind use
select menus, and the advanced prompt can customize the output directory and
container image.

## Options

- `--name <name>`: project and integration name
- `--language <node|python>`: runtime SDK language
- `--kind <integration|sidecar>`: scaffold flavor
- `--preset <preset>`: template preset such as `sensor-device`, `actuator-device`, `cloud-polling-api`, `webhook-receiver`, `protocol-bridge`, `sidecar-worker`, or `platform-service`
- `--domain <sensor|actuator|bridge|cloud-api|local-device|sidecar-service>`: domain metadata
- `--out-dir <path>`: target directory, defaults to the slugified name
- `--port <number>`: runtime HTTP port, defaults to `8090`
- `--image <image>`: manifest and Docker image reference
- `--package-manager <npm|pnpm|yarn>`: Node.js package manager
- `--python-manager <pip|uv|pdm>`: Python project manager
- `--license <name>`: manifest license metadata, defaults to `Apache-2.0`
- `--maintainer-name <name>`: manifest maintainer name
- `--maintainer-website <url>`: manifest maintainer website
- `--dry-run`: preview the scaffold without writing files
- `--print-tree`: print the generated file tree
- `--github-actions`: generate a CI workflow
- `--release-workflow`: generate a production release workflow, release script, and release guide
- `--binary-build`: generate native executable build scripts when supported
- `--template <path>`: apply a local template pack with `template.json`
- `--set <key=value>`: set a template variable; repeat for multiple values
- `--force`: allow writing into a non-empty target directory
- `--help`: print usage

Generated projects include a runtime starter, `manifest.json`, `Dockerfile`,
README, SDK dependencies, contract docs, curl examples, validation scripts,
contract tests, shared contract conformance fixtures, request/response examples,
a local manifest JSON Schema, and the common PiPhi runtime routes:

- `/health`
- `/diagnostics`
- `/discover`
- `/config`
- `/config/sync`
- `/deconfigure`
- `/state`
- `/contract`
- `/entities`
- `/events`
- `/telemetry/example`

Python projects are generated as a package with an app factory, SDK lifespan
hook, shared runtime state, typed schemas, a first-class `contract.py`, and
route modules under `routes/`.

Node.js projects use the same professional shape with `app.ts`, `contract.ts`,
`state.ts`, typed route modules under `src/routes/`, and a small `index.ts`
entrypoint.

Presets are not just labels: they adjust generated config fields, `.env.example`,
manifest capabilities, command metadata, entity metadata, examples, CI, and the
language-specific contract source so the scaffold starts closer to the intended
runtime shape.

Every generated project can validate manifest/contract drift locally:

- Node.js: `npm test` and `npm run validate`
- Python: `pytest` and `python scripts/validate.py`

The generated test suite includes `tests/fixtures/contract-conformance.json`,
which drives runtime conformance tests for `/health`, `/ui-config`, `/contract`,
`/config`, `/entities`, and `/command` across the supported SDK languages.

## Template Packs

Local template packs let teams layer company or vendor-specific files on top of
the built-in Node.js and Python scaffolds:

```bash
piphi-network-create template validate ./templates/vendor-cloud
piphi-network-create create kaiterra-runtime --template ./templates/vendor-cloud --set vendor=Kaiterra
```

A template pack is a directory with `template.json`. File paths and text content
can use placeholders such as `{{title}}`, `{{slug}}`, `{{language}}`,
`{{preset}}`, `{{port}}`, and custom variables under `{{vars.name}}`.

```json
{
  "name": "vendor-cloud",
  "languages": ["node"],
  "kind": "integration",
  "preset": "cloud-polling-api",
  "domain": "cloud-api",
  "variables": [{ "name": "vendor", "default": "Vendor" }],
  "files": [
    {
      "path": "docs/{{vars.vendor}}.md",
      "template": "files/docs/vendor.md"
    }
  ]
}
```

## Project Maintenance

The CLI can also inspect and lightly maintain generated projects:

```bash
piphi-network-create validate -C ./my-runtime
piphi-network-create validate -C ./my-runtime --fix
piphi-network-create inspect -C ./my-runtime
piphi-network-create publish-check -C ./my-runtime
piphi doctor -C ./my-runtime
piphi doctor -C ./my-runtime --url http://127.0.0.1:8090
piphi-network-create add-command refresh_devices -C ./my-runtime
piphi-network-create add-capability humidity_percent --unit % -C ./my-runtime
piphi-network-create add-route diagnostics /diagnostics -C ./my-runtime
piphi-network-create add-webhook -C ./my-runtime
piphi-network-create add-poller --interval 60 -C ./my-runtime
piphi-network-create add-auth oauth2 -C ./my-runtime
piphi-network-create add-discovery mdns -C ./my-runtime
piphi set-onboarding manual -C ./my-runtime
piphi-network-create add-telemetry temperature_c humidity_percent battery_percent -C ./my-runtime
piphi-network-create release-workflow -C ./my-runtime
piphi-network-create binary-build -C ./my-runtime
piphi-network-create upgrade -C ./my-runtime
```

`validate` uses the generated JSON Schema through `ajv` and the hand-written
contract checks. `upgrade` applies the current scaffold metadata/schema
migration, including `metadata.scaffold_version`.

Every newly generated runtime also declares its homeowner-facing setup entry
point in `onboarding.mode`. Use `--onboarding` while creating a project or
`piphi set-onboarding <mode> -C <project>` for an existing project. Runtime
discovery metadata remains independent: a package may implement `/discover`
while using `manual` onboarding.

`doctor` always checks the project on disk. When `--url` is supplied it also
runs the published PiPhi runtime conformance suite against the live process.
Use `--mock-core-port`, `--telemetry-trigger`, and `--event-trigger` to verify
outbound telemetry and automation-event delivery.

`inspect` prints the scaffold language, preset, image, endpoints, capabilities,
commands, config fields, generated file presence, and validation status.
`publish-check` is stricter than `validate`: it expects release metadata,
custom image/version/maintainer values, generated docs/examples, contract tests,
conformance fixtures, a release workflow, and `scripts/release.py` before the
project is considered publish-ready.

The generated release workflow is a release manager modeled after the production
integration release flow. It runs from `workflow_dispatch`, bumps semantic
versions through `scripts/release.py`, updates manifest/package metadata,
commits and tags the release, builds a multi-architecture image with Docker
Buildx, pushes version/latest tags, and creates a GitHub Release. Use
`org/image:tag` or `docker.io/org/image:tag` for Docker Hub and set
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Use `ghcr.io/org/image:tag` for
GHCR; the workflow uses GitHub's built-in token.

`binary-build` adds language-specific native executable build files and
`.github/workflows/build-binary.yml`. Python uses PyInstaller and Node.js uses
Node SEA with `esbuild` and `postject`. Generated
artifacts are written to `dist/binary/` with platform-aware names.

## Native Managed Workload bundles

`binary-build` remains compatible and only creates the executable. The separate
`piphi native` workflow packages that output for Chief, signs it on the target
host, generates an SPDX SBOM and in-toto provenance, and emits a
`piphi.native-artifact-set.v1` manifest.

Create an authoring file from a generated project:

```bash
piphi native init \
  --binary dist/binary/my-runtime \
  --identity release@example.com \
  --artifact-base-url https://github.com/example/my-runtime/releases/download/v1.2.3
```

Review `native-bundle.json` before packaging. Important fields include:

```json
{
  "contract": "piphi.native-bundle-authoring.v1",
  "package_id": "my-runtime",
  "package_version": "1.2.3",
  "binary": "dist/binary/my-runtime",
  "target": {
    "platform": "linux",
    "architecture": "amd64",
    "minimum_os_version": "22.04"
  },
  "bundle": {
    "entrypoint": "bin/my-runtime",
    "args": [],
    "environment": {},
    "working_directory": ".",
    "endpoint": {
      "port": 8090,
      "allowed_path_prefixes": ["/health", "/command"],
      "allowed_methods": ["GET", "POST"]
    }
  },
  "signing": {
    "kind": "sigstore",
    "identity": "https://github.com/example/my-runtime/.github/workflows/release.yml@refs/tags/v1.2.3",
    "sigstore_issuer": "https://token.actions.githubusercontent.com"
  },
  "artifact_base_url": "https://github.com/example/my-runtime/releases/download/v1.2.3"
}
```

Package each target on that target's native OS and CPU architecture:

```bash
piphi native package --config native-bundle.json --source-revision "$GIT_SHA"
```

Cross-packaging is intentionally rejected. Required tools and credentials are:

- Every target: `syft` on `PATH` for SPDX JSON generation.
- Linux: `cosign`, with an identity and trusted OIDC issuer. GitHub Actions
  keyless signing requires `permissions: id-token: write`.
- Windows: Windows SDK `signtool` and an Authenticode certificate installed in
  the runner's certificate store. `signing.identity` is the certificate subject
  selected by `signtool /n`; `timestamp_url` is optional.
- macOS: `codesign`, `xcrun notarytool`, and `spctl`, a Developer ID certificate
  in the runner keychain, and `signing.apple_notary_profile` created with
  `xcrun notarytool store-credentials`.

The command fails closed if a tool, credential, signature check, SBOM, or
attestation is missing. It produces a deterministic ZIP, an SPDX document,
in-toto provenance, a Sigstore bundle on Linux, and a one-target artifact-set
manifest under `dist/native/`.

Merge native-runner outputs only when package ID, version, source revision, and
runtime contract all match. Duplicate targets are rejected and artifacts are
sorted so input order does not affect the merged manifest:

```bash
piphi native merge dist/native/*.native-artifact-set.json \
  --output dist/native/my-runtime-1.2.3.native-artifact-set.json
piphi native validate dist/native/my-runtime-1.2.3.native-artifact-set.json
piphi native conformance dist/native/my-runtime-1.2.3.native-artifact-set.json \
  --output dist/native/native-conformance.json
piphi native publish dist/native/my-runtime-1.2.3.native-artifact-set.json \
  --tag v1.2.3 --repo example/my-runtime
```

Keep all referenced release files in the manifest directory, or pass
`--artifact-dir`. `native conformance` reports portable schema, digest, SBOM,
provenance, and bundle-layout checks. It always labels native qualification as
`not_qualified`: Windows Authenticode and Job Object behavior, macOS Developer
ID/notarization behavior, and each platform's Chief lifecycle and whole-tree
cleanup must be tested on real native hosts.

Artifact metadata containing `signature.verified: true` is not a trust grant.
Chief independently verifies signatures and applies its local
`PIPHI_NATIVE_TRUST_POLICY`; an absent or non-matching trust policy rejects
admission.

### GitHub Actions outline

Keep one authoring file per matrix target (for example,
`native-bundle.linux-amd64.json`) and provision each runner's signing tools and
credentials before packaging:

```yaml
permissions:
  contents: write
  id-token: write

jobs:
  native:
    strategy:
      matrix:
        include:
          - runner: ubuntu-22.04
            config: native-bundle.linux-amd64.json
          - runner: windows-2022
            config: native-bundle.windows-amd64.json
          - runner: macos-14
            config: native-bundle.macos-arm64.json
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm install --global @piphi-network/cli
      - run: npm run build:binary
      # Install syft/cosign or import the platform signing credentials here.
      - run: piphi native package --config "${{ matrix.config }}" --source-revision "${{ github.sha }}"
      - uses: actions/upload-artifact@v4
        with:
          name: native-${{ matrix.runner }}
          path: dist/native/*

  aggregate:
    needs: native
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm install --global @piphi-network/cli
      - uses: actions/download-artifact@v4
        with:
          pattern: native-*
          path: dist/native
          merge-multiple: true
      - run: piphi native merge dist/native/*.native-artifact-set.json --output dist/native/release.native-artifact-set.json
      - run: piphi native conformance dist/native/release.native-artifact-set.json --output dist/native/native-conformance.json
      - run: piphi native publish dist/native/release.native-artifact-set.json --tag "${GITHUB_REF_NAME}"
        env:
          GH_TOKEN: ${{ github.token }}
```

## Widget projects

The unified CLI treats repository layout and installation as separate concerns. A widget can live beside its integration or in an independent repository; the integration links it by registry identity rather than a Git URL.

```bash
piphi widget create "Awair Air Quality" \
  --publisher io.piphi \
  --integration-id awair-element-local-api

cd awair-air-quality
npm install
npm test
piphi widget dev
piphi widget validate
piphi widget link --integration ../com_piphi_awair_element
piphi widget verify-link --integration ../com_piphi_awair_element
piphi widget pack --check
```

`widget create` generates TypeScript source that imports `piphi-network-widget-sdk`, an esbuild browser bundle, tests, and a modern `package.source.json`. `widget link` updates `ui.experience_packages` idempotently and supports manifests at either `manifest.json` or `src/manifest.json`.

`widget pack --check` creates and signs a disposable deterministic package with an ephemeral key. For a real artifact, provide the configured publisher key and choose an output directory:

```bash
PIPHI_WIDGET_SIGNING_KEY_PEM_BASE64=... \
  piphi widget publish --output-dir dist
```

`widget publish` now produces the signed ZIP and manifest, writes
`dist/registry-proposal.json`, and requests a reviewed registry pull request.
Use `--dry-run` to preview the package and proposal without signing or submitting,
or `--no-registry` when intentionally publishing a private or direct-install
package. Core installs immutable registry artifacts; it never clones source
repositories during installation.

## Registry proposals

Integration and widget repositories use the same portable proposal contract:

```bash
piphi registry prepare -C .
piphi registry verify dist/registry-proposal.json
piphi registry submit dist/registry-proposal.json
```

`registry prepare` infers whether the project is an integration or widget,
normalizes its immutable version tag and repository metadata, and starts new
entries as draft with zero rollout. For a widget release, pass the signed
manifest with `--artifact-manifest` so the proposal is bound to the archive's
SHA-256 digest. `registry submit` dispatches the registry-owned proposal
workflow, which validates the complete catalog and opens a review pull request;
it never merges or promotes the listing automatically.

CLI releases use npm trusted publishing from GitHub Actions. See [RELEASING.md](RELEASING.md) for the one-time npm package configuration and tag-based release procedure.
