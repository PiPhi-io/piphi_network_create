# piphi_network_create

TypeScript CLI for scaffolding PiPhi Network runtime integrations and sidecars.

The generator supports the current PiPhi runtime SDK languages:

- Node.js / TypeScript with `piphi-runtime-kit-node`
- Python / FastAPI with `piphi-runtime-kit-python`
- Go / `net/http` with `piphi-runtime-kit-go`

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
piphi-network-create <name> --language go --out-dir ./integrations/my-go-runtime
piphi-network-create <name> --language python --preset cloud-polling-api --domain cloud-api --github-actions
piphi-network-create <name> --language go --release-workflow
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
- `--language <node|python|go>`: runtime SDK language
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
entrypoint. Go projects use idiomatic small `package main` files such as
`contract.go`, `state.go`, and `routes_*.go`.

Presets are not just labels: they adjust generated config fields, `.env.example`,
manifest capabilities, command metadata, entity metadata, examples, CI, and the
language-specific contract source so the scaffold starts closer to the intended
runtime shape.

Every generated project can validate manifest/contract drift locally:

- Node.js: `npm test` and `npm run validate`
- Python: `pytest` and `python scripts/validate.py`
- Go: `go test ./...` and `go run ./cmd/validate`

The generated test suite includes `tests/fixtures/contract-conformance.json`,
which drives runtime conformance tests for `/health`, `/ui-config`, `/contract`,
`/config`, `/entities`, and `/command` across the supported SDK languages.

## Template Packs

Local template packs let teams layer company or vendor-specific files on top of
the built-in Node.js, Python, and Go scaffolds:

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
piphi-network-create doctor -C ./my-runtime
piphi-network-create add-command refresh_devices -C ./my-runtime
piphi-network-create add-capability humidity_percent --unit % -C ./my-runtime
piphi-network-create add-route diagnostics /diagnostics -C ./my-runtime
piphi-network-create add-webhook -C ./my-runtime
piphi-network-create add-poller --interval 60 -C ./my-runtime
piphi-network-create add-auth oauth2 -C ./my-runtime
piphi-network-create add-discovery mdns -C ./my-runtime
piphi-network-create add-telemetry temperature_c humidity_percent battery_percent -C ./my-runtime
piphi-network-create release-workflow -C ./my-runtime
piphi-network-create binary-build -C ./my-runtime
piphi-network-create upgrade -C ./my-runtime
```

`validate` uses the generated JSON Schema through `ajv` and the hand-written
contract checks. `upgrade` applies the current scaffold metadata/schema
migration, including `metadata.scaffold_version`.

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
`.github/workflows/build-binary.yml`. Python uses PyInstaller, Node.js uses
Node SEA with `esbuild` and `postject`, and Go uses `go build`. Generated
artifacts are written to `dist/binary/` with platform-aware names.
