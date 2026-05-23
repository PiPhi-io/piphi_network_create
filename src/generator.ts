import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command, InvalidArgumentError } from "commander";
import Enquirer from "enquirer";
import {
  renderContractDoc,
  renderCurlExample,
  renderGoGithubActions,
  renderJson,
  renderManifestSchemaJson,
  renderNodeGithubActions,
  renderProjectReadme,
  renderPythonGithubActions,
  renderReleaseGithubActions,
  renderReleaseGuide,
  renderReleaseScript,
} from "./templates/common.js";
import {
  renderContractFixtures,
  renderGoConformanceTest,
  renderNodeConformanceTest,
  renderPythonConformanceTest,
} from "./templates/conformance.js";
import {
  renderGoBinaryBuildScript,
  renderGoBinaryGithubActions,
  renderNodeBinaryBuildScript,
  renderNodeBinaryGithubActions,
  renderPythonBinaryBuildScript,
  renderPythonBinaryEntry,
  renderPythonBinaryGithubActions,
} from "./templates/binary.js";
import {
  renderGoValidateSource,
  renderNodeValidateSource,
  renderPythonValidateSource,
} from "./templates/validators.js";
import {
  loadTemplatePack,
  renderTemplatePackFiles,
  templatePackDefaults,
  templateVariableValues,
  type TemplatePack,
} from "./template-packs.js";

const VERSION = "0.1.0";
const SCAFFOLD_VERSION = "0.2.0";
const DEFAULT_PORT = 8090;
const NODE_SDK_VERSION = "^0.2.0";
const PYTHON_SDK_VERSION = ">=0.3.0,<1.0.0";

const supportedLanguages = ["node", "python", "go"] as const;
const supportedKinds = ["integration", "sidecar"] as const;
const supportedPresets = [
  "minimal",
  "device",
  "sensor-device",
  "actuator-device",
  "cloud",
  "cloud-polling-api",
  "webhook-receiver",
  "protocol-bridge",
  "sidecar",
  "sidecar-worker",
  "platform-service",
] as const;
const supportedDomains = [
  "sensor",
  "actuator",
  "bridge",
  "cloud-api",
  "local-device",
  "sidecar-service",
] as const;
const supportedNodePackageManagers = ["npm", "pnpm", "yarn"] as const;
const supportedPythonManagers = ["pip", "uv", "pdm"] as const;

type Language = (typeof supportedLanguages)[number];
type ProjectKind = (typeof supportedKinds)[number];
type ProjectPreset = (typeof supportedPresets)[number];
type ProjectDomain = (typeof supportedDomains)[number];
type NodePackageManager = (typeof supportedNodePackageManagers)[number];
type PythonManager = (typeof supportedPythonManagers)[number];
type JsonObject = Record<string, unknown>;

type CliOptions = {
  name?: string;
  language?: Language;
  kind?: ProjectKind;
  preset?: ProjectPreset;
  domain?: ProjectDomain;
  outDir?: string;
  image?: string;
  port?: number;
  dryRun: boolean;
  printTree: boolean;
  githubActions: boolean;
  releaseWorkflow: boolean;
  binaryBuild: boolean;
  force: boolean;
  template?: string;
  templateValues: Record<string, string>;
  packageManager?: NodePackageManager;
  pythonManager?: PythonManager;
  license?: string;
  maintainerName?: string;
  maintainerWebsite?: string;
};

type ScaffoldOptions = {
  name: string;
  slug: string;
  title: string;
  language: Language;
  kind: ProjectKind;
  targetDir: string;
  image: string;
  port: number;
  preset: ProjectPreset;
  domain: ProjectDomain;
  githubActions: boolean;
  releaseWorkflow: boolean;
  binaryBuild: boolean;
  packageManager: NodePackageManager;
  pythonManager: PythonManager;
  license: string;
  maintainerName: string;
  maintainerWebsite: string;
  snakeName: string;
  pascalName: string;
  templatePack?: TemplatePack;
  templateValues: Record<string, string | number | boolean>;
};

type ProjectFile = {
  path: string;
  contents: string;
};

function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name("piphi-network-create")
    .description("Scaffold a PiPhi Network runtime integration or sidecar.")
    .version(VERSION, "-v, --version", "print the CLI version")
    .argument("[project-name]", "project and integration name")
    .option("--name <name>", "project and integration name")
    .option("-l, --language <language>", "runtime SDK language: node, python, or go", parseLanguage)
    .option("-k, --kind <kind>", "scaffold flavor: integration or sidecar", parseKind)
    .option(
      "--preset <preset>",
      "template preset: minimal, sensor-device, actuator-device, cloud-polling-api, webhook-receiver, protocol-bridge, sidecar-worker, or platform-service",
      parsePreset,
    )
    .option("--domain <domain>", "integration domain: sensor, actuator, bridge, cloud-api, local-device, or sidecar-service", parseDomain)
    .option("-o, --out-dir <path>", "target directory")
    .option("--output <path>", "alias for --out-dir")
    .option("--image <image>", "container image for manifest and Docker docs")
    .option("-p, --port <number>", `runtime HTTP port (default: ${DEFAULT_PORT})`, parsePort)
    .option("--package-manager <manager>", "Node.js package manager: npm, pnpm, or yarn", parseNodePackageManager)
    .option("--python-manager <manager>", "Python project manager: pip, uv, or pdm", parsePythonManager)
    .option("--license <name>", "license name to place in generated metadata", "Apache-2.0")
    .option("--maintainer-name <name>", "maintainer name for generated manifest metadata")
    .option("--maintainer-website <url>", "maintainer website for generated manifest metadata")
    .option("--dry-run", "preview generated files without writing them")
    .option("--print-tree", "print the generated file tree")
    .option("--github-actions", "generate a GitHub Actions workflow")
    .option("--release-workflow", "generate a release workflow and release guide")
    .option("--binary-build", "generate native executable build scripts when supported by the selected language")
    .option("--template <path>", "local template pack directory with template.json")
    .option("--set <key=value>", "set a template variable; repeat for multiple values", collectTemplateValue, {})
    .option("--force", "allow writing into a non-empty target directory")
    .addHelpText(
      "after",
      `

Examples:
  $ piphi-network-create awair-element --language node
  $ piphi-network-create rtl433-bridge --language python --preset device --domain bridge
  $ piphi-network-create matter-sidecar --language go --kind sidecar --preset sidecar --github-actions
`,
    );

  program.parse(argv, { from: "user" });
  const values = program.opts<{
    name?: string;
    language?: Language;
    kind?: ProjectKind;
    preset?: ProjectPreset;
    domain?: ProjectDomain;
    outDir?: string;
    output?: string;
    image?: string;
    port?: number;
    dryRun?: boolean;
    printTree?: boolean;
    githubActions?: boolean;
    releaseWorkflow?: boolean;
    binaryBuild?: boolean;
    template?: string;
    set?: Record<string, string>;
    force?: boolean;
    packageManager?: NodePackageManager;
    pythonManager?: PythonManager;
    license?: string;
    maintainerName?: string;
    maintainerWebsite?: string;
  }>();
  const projectName = program.args[0];

  return {
    name: values.name ?? projectName,
    language: values.language,
    kind: values.kind,
    preset: values.preset,
    domain: values.domain,
    outDir: values.outDir ?? values.output,
    image: values.image,
    port: values.port,
    dryRun: values.dryRun ?? false,
    printTree: values.printTree ?? false,
    githubActions: values.githubActions ?? false,
    releaseWorkflow: values.releaseWorkflow ?? false,
    binaryBuild: values.binaryBuild ?? false,
    template: values.template,
    templateValues: values.set ?? {},
    force: values.force ?? false,
    packageManager: values.packageManager,
    pythonManager: values.pythonManager,
    license: values.license,
    maintainerName: values.maintainerName,
    maintainerWebsite: values.maintainerWebsite,
  };
}

function collectTemplateValue(value: string, previous: Record<string, string>): Record<string, string> {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    throw new InvalidArgumentError(`Template variables must use key=value, received "${value}".`);
  }
  const key = value.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new InvalidArgumentError(`Invalid template variable name "${key}".`);
  }
  return {
    ...previous,
    [key]: value.slice(separatorIndex + 1),
  };
}

function parseNodePackageManager(value: string): NodePackageManager {
  if ((supportedNodePackageManagers as readonly string[]).includes(value)) {
    return value as NodePackageManager;
  }
  throw new InvalidArgumentError(
    `Unsupported package manager "${value}". Use one of: ${supportedNodePackageManagers.join(", ")}`,
  );
}

function parsePythonManager(value: string): PythonManager {
  if ((supportedPythonManagers as readonly string[]).includes(value)) {
    return value as PythonManager;
  }
  throw new InvalidArgumentError(
    `Unsupported Python manager "${value}". Use one of: ${supportedPythonManagers.join(", ")}`,
  );
}

function parseLanguage(value: string): Language {
  if ((supportedLanguages as readonly string[]).includes(value)) {
    return value as Language;
  }
  throw new InvalidArgumentError(
    `Unsupported language "${value}". Use one of: ${supportedLanguages.join(", ")}`,
  );
}

function parseKind(value: string): ProjectKind {
  if ((supportedKinds as readonly string[]).includes(value)) {
    return value as ProjectKind;
  }
  throw new InvalidArgumentError(
    `Unsupported kind "${value}". Use one of: ${supportedKinds.join(", ")}`,
  );
}

function parsePreset(value: string): ProjectPreset {
  if ((supportedPresets as readonly string[]).includes(value)) {
    return value as ProjectPreset;
  }
  throw new InvalidArgumentError(
    `Unsupported preset "${value}". Use one of: ${supportedPresets.join(", ")}`,
  );
}

function parseDomain(value: string): ProjectDomain {
  if ((supportedDomains as readonly string[]).includes(value)) {
    return value as ProjectDomain;
  }
  throw new InvalidArgumentError(
    `Unsupported domain "${value}". Use one of: ${supportedDomains.join(", ")}`,
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

async function resolveOptions(parsed: CliOptions): Promise<ScaffoldOptions> {
  const templatePack = parsed.template ? await loadTemplatePack(parsed.template) : undefined;
  const defaults = templatePackDefaults(templatePack);
  const seeded: CliOptions = {
    ...parsed,
    language: parsed.language ?? defaults.language,
    kind: parsed.kind ?? defaults.kind,
    preset: parsed.preset ?? defaults.preset as ProjectPreset | undefined,
    domain: parsed.domain ?? defaults.domain as ProjectDomain | undefined,
  };
  const prompted = await promptForMissing(seeded);
  const name = prompted.name?.trim();
  if (!name) {
    throw new Error("Project name is required.");
  }

  const slug = toSlug(name);
  const language = prompted.language ?? "node";
  const kind = prompted.kind ?? "integration";
  const preset = prompted.preset ?? defaultPresetForKind(kind);
  const domain = prompted.domain ?? defaultDomainForPreset(preset);
  const port = prompted.port ?? DEFAULT_PORT;
  const title = toTitle(name);
  const image = prompted.image ?? `piphinetwork/${slug}:0.1.0`;
  const targetDir = path.resolve(process.cwd(), prompted.outDir ?? slug);
  const maintainerName = prompted.maintainerName?.trim() || "PiPhi Network";
  const maintainerWebsite = prompted.maintainerWebsite?.trim() || "https://piphi.io";

  return {
    name,
    slug,
    title,
    language,
    kind,
    targetDir,
    image,
    port,
    preset,
    domain,
    githubActions: prompted.githubActions,
    releaseWorkflow: prompted.releaseWorkflow,
    binaryBuild: prompted.binaryBuild,
    packageManager: prompted.packageManager ?? "npm",
    pythonManager: prompted.pythonManager ?? "pip",
    license: prompted.license?.trim() || "Apache-2.0",
    maintainerName,
    maintainerWebsite,
    snakeName: toSnake(slug),
    pascalName: toPascal(slug),
    templatePack,
    templateValues: templateVariableValues(templatePack, prompted.templateValues),
  };
}

async function promptForMissing(options: CliOptions): Promise<CliOptions> {
  const next = { ...options };
  if (!process.stdin.isTTY) {
    return next;
  }

  if (!next.name) {
    const answer = await Enquirer.prompt<{ name: string }>({
      type: "input",
      name: "name",
      message: "Project name",
      initial: "my-piphi-integration",
      validate: (value) => {
        if (!String(value).trim()) {
          return "Project name is required.";
        }
        try {
          toSlug(String(value));
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : "Use a valid project name.";
        }
      },
    });
    next.name = answer.name;
  }

  if (!next.language) {
    const answer = await Enquirer.prompt<{ language: Language }>({
      type: "select",
      name: "language",
      message: "Runtime SDK language",
      initial: 0,
      choices: [
        {
          name: "node",
          message: "Node.js / TypeScript",
          hint: "Fastify + piphi-runtime-kit-node",
        },
        {
          name: "python",
          message: "Python / FastAPI",
          hint: "lifespan + routed package layout",
        },
        {
          name: "go",
          message: "Go / net/http",
          hint: "small compiled runtime",
        },
      ],
    });
    next.language = answer.language;
  }

  if (!next.kind) {
    const answer = await Enquirer.prompt<{ kind: ProjectKind }>({
      type: "select",
      name: "kind",
      message: "What are you scaffolding?",
      initial: 0,
      choices: [
        {
          name: "integration",
          message: "Integration",
          hint: "device, cloud API, or vendor runtime",
        },
        {
          name: "sidecar",
          message: "Sidecar",
          hint: "helper service used by one or more integrations",
        },
      ],
    });
    next.kind = answer.kind;
  }

  if (!next.preset) {
    const answer = await Enquirer.prompt<{ preset: ProjectPreset }>({
      type: "select",
      name: "preset",
      message: "Template preset",
      initial: next.kind === "sidecar" ? 3 : 1,
      choices: [
        { name: "minimal", message: "Minimal", hint: "contract routes only" },
        { name: "sensor-device", message: "Sensor Device", hint: "read-only telemetry and polling" },
        { name: "actuator-device", message: "Actuator Device", hint: "commands and device control" },
        { name: "cloud-polling-api", message: "Cloud Polling API", hint: "API key and vendor sync loop" },
        { name: "webhook-receiver", message: "Webhook Receiver", hint: "event ingestion and signature settings" },
        { name: "protocol-bridge", message: "Protocol Bridge", hint: "external protocol normalization" },
        { name: "sidecar-worker", message: "Sidecar Worker", hint: "worker loop and queue metrics" },
        { name: "platform-service", message: "Platform Service", hint: "shared dependency service baseline" },
      ],
    });
    next.preset = answer.preset;
  }

  if (!next.domain) {
    const answer = await Enquirer.prompt<{ domain: ProjectDomain }>({
      type: "select",
      name: "domain",
      message: "Integration domain",
      initial: initialDomainIndex(next.preset),
      choices: [
        { name: "sensor", message: "Sensor", hint: "read-only telemetry/state" },
        { name: "actuator", message: "Actuator", hint: "commands and device control" },
        { name: "bridge", message: "Bridge", hint: "normalizes an external protocol/service" },
        { name: "cloud-api", message: "Cloud API", hint: "talks to a vendor cloud" },
        { name: "local-device", message: "Local Device", hint: "LAN/local device integration" },
        { name: "sidecar-service", message: "Sidecar Service", hint: "local helper runtime" },
      ],
    });
    next.domain = answer.domain;
  }

  if (!next.port) {
    const answer = await Enquirer.prompt<{ port: string }>({
      type: "input",
      name: "port",
      message: "Runtime HTTP port",
      initial: String(DEFAULT_PORT),
      validate: (value) => {
        try {
          parsePort(String(value));
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : "Use a valid TCP port.";
        }
      },
    });
    next.port = parsePort(answer.port);
  }

  if (!next.outDir && !next.image) {
    const customize = await Enquirer.prompt<{ customize: boolean }>({
      type: "confirm",
      name: "customize",
      message: "Customize output directory, container image, or CI?",
      initial: false,
    });
    if (customize.customize) {
      const slug = toSlug(next.name ?? "my-piphi-integration");
      const advanced = await Enquirer.prompt<{ outDir: string; image: string; githubActions: boolean; releaseWorkflow: boolean; binaryBuild: boolean }>([
        {
          type: "input",
          name: "outDir",
          message: "Output directory",
          initial: slug,
        },
        {
          type: "input",
          name: "image",
          message: "Container image",
          initial: `piphinetwork/${slug}:0.1.0`,
        },
        {
          type: "confirm",
          name: "githubActions",
          message: "Generate GitHub Actions workflow?",
          initial: true,
        },
        {
          type: "confirm",
          name: "releaseWorkflow",
          message: "Generate release workflow?",
          initial: false,
        },
        {
          type: "confirm",
          name: "binaryBuild",
          message: "Generate native executable build scripts?",
          initial: false,
        },
      ]);
      next.outDir = advanced.outDir.trim() || undefined;
      next.image = advanced.image.trim() || undefined;
      next.githubActions = advanced.githubActions;
      next.releaseWorkflow = advanced.releaseWorkflow;
      next.binaryBuild = advanced.binaryBuild;
    }
  }

  return next;
}

function toSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`Could not create a project slug from "${value}".`);
  }
  return slug;
}

function toSnake(value: string): string {
  const snake = toSlug(value).replace(/-/g, "_");
  return /^\d/.test(snake) ? `piphi_${snake}` : snake;
}

function toPascal(value: string): string {
  return toSlug(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toTitle(value: string): string {
  return toSlug(value)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultPresetForKind(kind: ProjectKind): ProjectPreset {
  return kind === "sidecar" ? "sidecar-worker" : "sensor-device";
}

function defaultDomainForPreset(preset: ProjectPreset): ProjectDomain {
  if (preset === "cloud" || preset === "cloud-polling-api" || preset === "webhook-receiver") {
    return "cloud-api";
  }
  if (preset === "actuator-device") {
    return "actuator";
  }
  if (preset === "protocol-bridge") {
    return "bridge";
  }
  if (preset === "sidecar" || preset === "sidecar-worker" || preset === "platform-service") {
    return "sidecar-service";
  }
  return "sensor";
}

function initialDomainIndex(preset: ProjectPreset | undefined): number {
  const domain = defaultDomainForPreset(preset ?? "device");
  return supportedDomains.indexOf(domain);
}

async function ensureWritableTarget(options: ScaffoldOptions, force: boolean): Promise<void> {
  if (!existsSync(options.targetDir)) {
    return;
  }
  const entries = await readdir(options.targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Target directory is not empty: ${options.targetDir}\nUse --force to write into it.`,
    );
  }
}

async function writeProject(options: ScaffoldOptions, force: boolean): Promise<ProjectFile[]> {
  const files = await buildProjectFiles(options);
  await ensureWritableTarget(options, force);

  for (const file of files) {
    const destination = path.join(options.targetDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.contents, "utf8");
  }

  return files;
}

async function buildProjectFiles(options: ScaffoldOptions): Promise<ProjectFile[]> {
  let files: ProjectFile[];
  switch (options.language) {
    case "node":
      files = nodeFiles(options);
      break;
    case "python":
      files = pythonFiles(options);
      break;
    case "go":
      files = goFiles(options);
      break;
  }
  if (options.releaseWorkflow) {
    files = mergeProjectFiles(files, releaseWorkflowFiles(options));
  }
  if (options.binaryBuild) {
    files = mergeProjectFiles(files, binaryBuildFiles(options));
  }
  if (options.templatePack) {
    const rendered = await renderTemplatePackFiles(options.templatePack, templateContext(options));
    files = mergeProjectFiles(files, rendered);
  }
  return files;
}

function binaryBuildFiles(options: ScaffoldOptions): ProjectFile[] {
  if (options.language === "node") {
    return [
      {
        path: "scripts/build-binary.mjs",
        contents: renderNodeBinaryBuildScript(options),
      },
      {
        path: ".github/workflows/build-binary.yml",
        contents: renderNodeBinaryGithubActions(options),
      },
    ];
  }
  if (options.language === "go") {
    return [
      {
        path: "scripts/build_binary.py",
        contents: renderGoBinaryBuildScript(options),
      },
      {
        path: ".github/workflows/build-binary.yml",
        contents: renderGoBinaryGithubActions(options),
      },
    ];
  }
  return [
    {
      path: "scripts/binary_entry.py",
      contents: renderPythonBinaryEntry(options),
    },
    {
      path: "scripts/build_binary.py",
      contents: renderPythonBinaryBuildScript(options),
    },
    {
      path: ".github/workflows/build-binary.yml",
      contents: renderPythonBinaryGithubActions(options),
    },
  ];
}

function behaviorMetadataFiles(options: ScaffoldOptions): ProjectFile[] {
  if (options.kind !== "integration") {
    return [];
  }
  return [
    {
      path: options.language === "go" ? "behaviors.json" : "src/behaviors.json",
      contents: behaviorJson(options),
    },
  ];
}

function nodeFiles(options: ScaffoldOptions): ProjectFile[] {
  return [
    {
      path: "package.json",
      contents: json({
        name: options.slug,
        version: "0.1.0",
        description: `${options.title} PiPhi ${options.kind} runtime.`,
        type: "module",
        ...(nodePackageManagerField(options)),
        scripts: {
          dev: "tsx src/index.ts",
          build: "tsc -p tsconfig.json",
          start: "node dist/index.js",
          check: "tsc --noEmit -p tsconfig.json",
          test: "node --test --import tsx tests/**/*.test.ts",
          validate: "node scripts/validate.mjs",
          ...(options.binaryBuild ? { "build:binary": "node scripts/build-binary.mjs" } : {}),
        },
        dependencies: {
          fastify: "^5.3.0",
          "piphi-runtime-kit-node": NODE_SDK_VERSION,
        },
        devDependencies: {
          "@types/node": "^22.15.3",
          ...(options.binaryBuild ? { esbuild: "^0.25.0", postject: "^1.0.0-alpha.6" } : {}),
          tsx: "^4.19.3",
          typescript: "^6.0.2",
        },
        engines: {
          node: ">=18",
        },
      }),
    },
    {
      path: "tsconfig.json",
      contents: json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          types: ["node"],
          strict: true,
          outDir: "dist",
          rootDir: "src",
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      }),
    },
    {
      path: "src/index.ts",
      contents: nodeIndexSource(),
    },
    {
      path: "src/app.ts",
      contents: nodeAppSource(),
    },
    {
      path: "src/settings.ts",
      contents: nodeSettingsSource(options),
    },
    {
      path: "src/contract.ts",
      contents: nodeContractSource(options),
    },
    {
      path: "src/types.ts",
      contents: nodeTypesSource(),
    },
    {
      path: "src/state.ts",
      contents: nodeStateSource(),
    },
    {
      path: "src/routes/index.ts",
      contents: nodeRoutesIndexSource(),
    },
    {
      path: "src/routes/health.ts",
      contents: nodeHealthRoutesSource(),
    },
    {
      path: "src/routes/discovery.ts",
      contents: nodeDiscoveryRoutesSource(),
    },
    {
      path: "src/routes/config.ts",
      contents: nodeConfigRoutesSource(),
    },
    {
      path: "src/routes/runtime.ts",
      contents: nodeRuntimeRoutesSource(),
    },
    {
      path: "src/routes/entities.ts",
      contents: nodeEntityRoutesSource(),
    },
    {
      path: "src/routes/events.ts",
      contents: nodeEventRoutesSource(),
    },
    {
      path: "src/routes/telemetry.ts",
      contents: nodeTelemetryRoutesSource(),
    },
    {
      path: "src/routes/commands.ts",
      contents: nodeCommandRoutesSource(),
    },
    ...behaviorMetadataFiles(options),
    {
      path: "manifest.json",
      contents: manifestJson(options),
    },
    {
      path: "schema/piphi-manifest.schema.json",
      contents: manifestSchemaJson(),
    },
    {
      path: "Dockerfile",
      contents: `FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
${nodeDockerInstallCommand(options)}
COPY tsconfig.json ./
COPY src ./src
RUN ${nodeRunCommand(options, "build")}

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
${nodeDockerInstallCommand(options, true)}
COPY --from=build /app/dist ./dist
EXPOSE ${options.port}
CMD ["node", "dist/index.js"]
`,
    },
    {
      path: ".env.example",
      contents: envExampleSource(options),
    },
    {
      path: ".gitignore",
      contents: `node_modules/
dist/
build/
.env
*.log
`,
    },
    {
      path: "README.md",
      contents: projectReadme(options, nodeLocalCommands(options)),
    },
    {
      path: "tests/contract.test.ts",
      contents: nodeContractTestSource(),
    },
    {
      path: "tests/conformance.test.ts",
      contents: renderNodeConformanceTest(),
    },
    {
      path: "tests/fixtures/contract-conformance.json",
      contents: renderContractFixtures(),
    },
    {
      path: "scripts/validate.mjs",
      contents: nodeValidateSource(),
    },
    {
      path: "examples/curl.sh",
      contents: curlExampleSource(options),
    },
    ...exampleFiles(options),
    {
      path: "docs/contract.md",
      contents: contractDocSource(options),
    },
    ...(options.githubActions
      ? [
          {
            path: ".github/workflows/ci.yml",
            contents: nodeGithubActionsSource(options),
          },
        ]
      : []),
  ];
}

function pythonFiles(options: ScaffoldOptions): ProjectFile[] {
  return [
    {
      path: "pyproject.toml",
      contents: `[project]
name = "${options.slug}"
version = "0.1.0"
description = "${options.title} PiPhi ${options.kind} runtime."
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.30.0",
  "piphi-runtime-kit-python${PYTHON_SDK_VERSION}",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
  "httpx>=0.27.0",
]
${options.binaryBuild ? `binary = [
  "pyinstaller>=6.10.0",
]
` : ""}

[project.scripts]
${options.snakeName} = "${options.snakeName}.main:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/${options.snakeName}"]
`,
    },
    {
      path: `src/${options.snakeName}/__init__.py`,
      contents: `"""${options.title} PiPhi ${options.kind} runtime."""\n`,
    },
    {
      path: `src/${options.snakeName}/app.py`,
      contents: pythonAppSource(options),
    },
    {
      path: `src/${options.snakeName}/settings.py`,
      contents: pythonSettingsSource(options),
    },
    {
      path: `src/${options.snakeName}/schemas.py`,
      contents: pythonSchemasSource(),
    },
    {
      path: `src/${options.snakeName}/contract.py`,
      contents: pythonContractSource(options),
    },
    {
      path: `src/${options.snakeName}/state.py`,
      contents: pythonStateSource(options),
    },
    {
      path: `src/${options.snakeName}/lifecycle.py`,
      contents: pythonLifecycleSource(),
    },
    {
      path: `src/${options.snakeName}/main.py`,
      contents: pythonMainSource(options),
    },
    {
      path: `src/${options.snakeName}/routes/__init__.py`,
      contents: pythonRoutesInitSource(),
    },
    {
      path: `src/${options.snakeName}/routes/health.py`,
      contents: pythonHealthRoutesSource(options),
    },
    {
      path: `src/${options.snakeName}/routes/discovery.py`,
      contents: pythonDiscoveryRoutesSource(options),
    },
    {
      path: `src/${options.snakeName}/routes/config.py`,
      contents: pythonConfigRoutesSource(),
    },
    {
      path: `src/${options.snakeName}/routes/runtime.py`,
      contents: pythonRuntimeRoutesSource(),
    },
    {
      path: `src/${options.snakeName}/routes/entities.py`,
      contents: pythonEntityRoutesSource(),
    },
    {
      path: `src/${options.snakeName}/routes/events.py`,
      contents: pythonEventRoutesSource(),
    },
    {
      path: `src/${options.snakeName}/routes/telemetry.py`,
      contents: pythonTelemetryRoutesSource(),
    },
    {
      path: `src/${options.snakeName}/routes/commands.py`,
      contents: pythonCommandRoutesSource(),
    },
    ...behaviorMetadataFiles(options),
    {
      path: "manifest.json",
      contents: manifestJson(options),
    },
    {
      path: "schema/piphi-manifest.schema.json",
      contents: manifestSchemaJson(),
    },
    {
      path: "Dockerfile",
      contents: `FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
EXPOSE ${options.port}
CMD ["uvicorn", "${options.snakeName}.main:app", "--host", "0.0.0.0", "--port", "${options.port}"]
`,
    },
    {
      path: ".env.example",
      contents: envExampleSource(options),
    },
    {
      path: ".gitignore",
      contents: `.venv/
__pycache__/
*.pyc
.env
dist/
build/
*.spec
`,
    },
    {
      path: "README.md",
      contents: projectReadme(options, pythonLocalCommands(options)),
    },
    {
      path: "tests/test_contract.py",
      contents: pythonContractTestSource(options),
    },
    {
      path: "tests/test_conformance.py",
      contents: renderPythonConformanceTest(options),
    },
    {
      path: "tests/fixtures/contract-conformance.json",
      contents: renderContractFixtures(),
    },
    {
      path: "scripts/validate.py",
      contents: pythonValidateSource(options),
    },
    {
      path: "examples/curl.sh",
      contents: curlExampleSource(options),
    },
    ...exampleFiles(options),
    {
      path: "docs/contract.md",
      contents: contractDocSource(options),
    },
    ...(options.githubActions
      ? [
          {
            path: ".github/workflows/ci.yml",
            contents: pythonGithubActionsSource(options),
          },
        ]
      : []),
  ];
}

function goFiles(options: ScaffoldOptions): ProjectFile[] {
  const modulePath = `github.com/piphi-network/${options.slug}`;
  return [
    {
      path: "go.mod",
      contents: `module ${modulePath}

go 1.25.0
`,
    },
    {
      path: "main.go",
      contents: goMainSource(),
    },
    {
      path: "settings.go",
      contents: goSettingsSource(options),
    },
    {
      path: "contract.go",
      contents: goContractSource(options),
    },
    {
      path: "state.go",
      contents: goStateSource(options),
    },
    {
      path: "http.go",
      contents: goHTTPSource(),
    },
    {
      path: "routes_health.go",
      contents: goHealthRoutesSource(),
    },
    {
      path: "routes_discovery.go",
      contents: goDiscoveryRoutesSource(),
    },
    {
      path: "routes_config.go",
      contents: goConfigRoutesSource(),
    },
    {
      path: "routes_runtime.go",
      contents: goRuntimeRoutesSource(),
    },
    {
      path: "routes_entities.go",
      contents: goEntityRoutesSource(),
    },
    {
      path: "routes_events.go",
      contents: goEventRoutesSource(),
    },
    {
      path: "routes_telemetry.go",
      contents: goTelemetryRoutesSource(),
    },
    {
      path: "routes_commands.go",
      contents: goCommandRoutesSource(),
    },
    ...behaviorMetadataFiles(options),
    {
      path: "manifest.json",
      contents: manifestJson(options),
    },
    {
      path: "schema/piphi-manifest.schema.json",
      contents: manifestSchemaJson(),
    },
    {
      path: "Dockerfile",
      contents: `FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -o /runtime .

FROM alpine:3.22
WORKDIR /app
COPY --from=build /runtime /app/runtime
EXPOSE ${options.port}
CMD ["/app/runtime"]
`,
    },
    {
      path: ".env.example",
      contents: envExampleSource(options),
    },
    {
      path: ".gitignore",
      contents: `.env
${options.slug}
dist/
build/
*.log
`,
    },
    {
      path: "README.md",
      contents: projectReadme(options, [
        "go get github.com/piphi-network/piphi-runtime-kit-go",
        "go mod tidy",
        "go test ./...",
        "go run ./cmd/validate",
        "go run .",
      ]),
    },
    {
      path: "contract_test.go",
      contents: goContractTestSource(),
    },
    {
      path: "conformance_test.go",
      contents: renderGoConformanceTest(),
    },
    {
      path: "tests/fixtures/contract-conformance.json",
      contents: renderContractFixtures(),
    },
    {
      path: "cmd/validate/main.go",
      contents: goValidateSource(),
    },
    {
      path: "examples/curl.sh",
      contents: curlExampleSource(options),
    },
    ...exampleFiles(options),
    {
      path: "docs/contract.md",
      contents: contractDocSource(options),
    },
    ...(options.githubActions
      ? [
          {
            path: ".github/workflows/ci.yml",
            contents: goGithubActionsSource(),
          },
        ]
      : []),
  ];
}

function releaseWorkflowFiles(options: ScaffoldOptions): ProjectFile[] {
  return [
    {
      path: ".github/workflows/release.yml",
      contents: renderReleaseGithubActions(options, releaseCommandSet(options)),
    },
    {
      path: "scripts/release.py",
      contents: renderReleaseScript(),
    },
    {
      path: "docs/release.md",
      contents: renderReleaseGuide(options),
    },
  ];
}

function releaseCommandSet(options: ScaffoldOptions) {
  if (options.language === "node") {
    return {
      installCommand: nodeInstallCommand(options),
      checkCommand: nodeRunCommand(options, "check"),
      testCommand: nodeRunCommand(options, "test"),
      validateCommand: nodeRunCommand(options, "validate"),
    };
  }
  if (options.language === "python") {
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

function templateContext(options: ScaffoldOptions): JsonObject {
  return {
    projectName: options.name,
    name: options.name,
    slug: options.slug,
    title: options.title,
    language: options.language,
    kind: options.kind,
    preset: options.preset,
    domain: options.domain,
    image: options.image,
    port: options.port,
    packageName: options.language === "python" ? options.snakeName : options.slug,
    snakeName: options.snakeName,
    pascalName: options.pascalName,
    license: options.license,
    maintainerName: options.maintainerName,
    maintainerWebsite: options.maintainerWebsite,
    vars: options.templateValues,
  };
}

function mergeProjectFiles(baseFiles: ProjectFile[], overlayFiles: ProjectFile[]): ProjectFile[] {
  const merged = new Map<string, ProjectFile>();
  for (const file of baseFiles) {
    merged.set(file.path, file);
  }
  for (const file of overlayFiles) {
    merged.set(file.path, file);
  }
  return [...merged.values()];
}

function nodeLocalCommands(options: ScaffoldOptions): string[] {
  const run = (script: string) => nodeRunCommand(options, script);
  return [
    nodeInstallCommand(options),
    run("dev"),
    run("build"),
    run("test"),
    run("validate"),
  ];
}

function nodeInstallCommand(options: ScaffoldOptions): string {
  if (options.packageManager === "pnpm") {
    return "pnpm install";
  }
  if (options.packageManager === "yarn") {
    return "yarn install";
  }
  return "npm install";
}

function nodePackageManagerField(options: ScaffoldOptions): JsonObject {
  if (options.packageManager === "pnpm") {
    return { packageManager: "pnpm@10.0.0" };
  }
  if (options.packageManager === "yarn") {
    return { packageManager: "yarn@4.0.0" };
  }
  return {};
}

function nodeRunCommand(options: ScaffoldOptions, script: string): string {
  if (options.packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (options.packageManager === "yarn") {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
}

function nodeDockerInstallCommand(options: ScaffoldOptions, production = false): string {
  if (options.packageManager === "pnpm") {
    return [
      "RUN corepack enable",
      `RUN pnpm install${production ? " --prod" : ""}`,
    ].join("\n");
  }
  if (options.packageManager === "yarn") {
    return [
      "RUN corepack enable",
      `RUN yarn install${production ? " --production" : ""}`,
    ].join("\n");
  }
  return `RUN npm install${production ? " --omit=dev" : ""}`;
}

function pythonLocalCommands(options: ScaffoldOptions): string[] {
  if (options.pythonManager === "uv") {
    return [
      "uv venv",
      "source .venv/bin/activate",
      "uv pip install -e .[dev]",
      `uvicorn ${options.snakeName}.main:app --reload --port ${options.port}`,
      "uv run pytest",
      "uv run python scripts/validate.py",
    ];
  }
  if (options.pythonManager === "pdm") {
    return [
      "pdm install -G dev",
      `pdm run uvicorn ${options.snakeName}.main:app --reload --port ${options.port}`,
      "pdm run pytest",
      "pdm run python scripts/validate.py",
    ];
  }
  return [
    "python -m venv .venv",
    "source .venv/bin/activate",
    "pip install -e .[dev]",
    `uvicorn ${options.snakeName}.main:app --reload --port ${options.port}`,
    "pytest",
    "python scripts/validate.py",
  ];
}

function envExampleSource(options: ScaffoldOptions): string {
  const fields = presetShape(options.preset).configFields;
  const values = [
    ["PORT", String(options.port)],
    ["LOG_LEVEL", "info"],
    ...fields.map((field) => [toEnvName(field.id), field.placeholder ?? ""]),
  ];
  return `${values.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function exampleFiles(options: ScaffoldOptions): ProjectFile[] {
  const config = configExampleFor(options);
  const command = {
    contract_version: "automation.runtime.command.v1",
    command: Object.keys(commandsFor(options))[0] ?? "refresh",
    target: {
      config_id: "demo-device",
      device_id: "demo-device",
      entity_id: null,
    },
    params: {},
    capability: "device.refresh",
    capability_requirements: ["device.refresh"],
  };
  return [
    {
      path: "examples/discovery-request.json",
      contents: json({ inputs: { host: "127.0.0.1", alias: "Demo Device" } }),
    },
    {
      path: "examples/config.json",
      contents: json(config),
    },
    {
      path: "examples/command.json",
      contents: json(command),
    },
    {
      path: "examples/entity-response.json",
      contents: json({ entities: [entityFor(options)], capabilities: capabilitiesFor(options), commands: commandsFor(options) }),
    },
  ];
}

function configExampleFor(options: ScaffoldOptions): JsonObject {
  const fields = presetShape(options.preset).configFields;
  return {
    id: "demo-device",
    host: "127.0.0.1",
    alias: "Demo Device",
    ...Object.fromEntries(fields.map((field) => [field.id, exampleValueForField(field)])),
  };
}

function exampleValueForField(field: PresetConfigField): string | number {
  if (field.type === "integer") {
    return field.minimum ?? 30;
  }
  if (field.id === "api_key" || field.id === "webhook_secret") {
    return "change-me";
  }
  return field.placeholder ?? "";
}

function toEnvName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

type PresetConfigField = {
  id: string;
  title: string;
  type: "string" | "integer";
  placeholder?: string;
  minimum?: number;
};

type PresetShape = {
  summary: string;
  configFields: PresetConfigField[];
  capabilities: JsonObject;
  commands: JsonObject;
};

function presetShape(preset: ProjectPreset): PresetShape {
  switch (preset) {
    case "cloud":
    case "cloud-polling-api":
      return {
        summary: "Cloud API starter with vendor endpoint and token-oriented configuration.",
        configFields: [
          { id: "base_url", title: "Base URL", type: "string", placeholder: "https://api.vendor.example" },
          { id: "api_key", title: "API Key", type: "string", placeholder: "secret-token" },
          {
            id: "poll_interval_seconds",
            title: "Poll Interval Seconds",
            type: "integer",
            minimum: 15,
            placeholder: "60",
          },
        ],
        capabilities: {
          api_rate_limit_remaining: { kind: "sensor", unit: "requests" },
          api_latency_ms: { kind: "sensor", unit: "ms" },
        },
        commands: {
          sync_cloud: {
            description: "Synchronize state from the vendor cloud.",
            timeout_ms: 15000,
          },
        },
      };
    case "webhook-receiver":
      return {
        summary: "Webhook receiver starter with signed inbound event handling.",
        configFields: [
          { id: "webhook_secret", title: "Webhook Secret", type: "string", placeholder: "shared-secret" },
          { id: "source_name", title: "Source Name", type: "string", placeholder: "vendor-webhook" },
        ],
        capabilities: {
          webhook_events_total: { kind: "sensor", unit: "events" },
          last_event_age_seconds: { kind: "sensor", unit: "s" },
        },
        commands: {
          replay_webhook: {
            description: "Replay the latest received webhook payload.",
            timeout_ms: 10000,
          },
        },
      };
    case "protocol-bridge":
      return {
        summary: "Protocol bridge starter for translating an external local protocol.",
        configFields: [
          { id: "bridge_address", title: "Bridge Address", type: "string", placeholder: "tcp://127.0.0.1:9000" },
          { id: "protocol", title: "Protocol", type: "string", placeholder: "mqtt" },
        ],
        capabilities: {
          bridge_connected: { kind: "sensor", unit: "bool" },
          messages_per_minute: { kind: "sensor", unit: "msg/min" },
        },
        commands: {
          resync_bridge: {
            description: "Resynchronize protocol bridge state.",
            timeout_ms: 10000,
          },
        },
      };
    case "device":
    case "sensor-device":
      return {
        summary: "Local device starter with polling cadence and device diagnostics hooks.",
        configFields: [
          {
            id: "poll_interval_seconds",
            title: "Poll Interval Seconds",
            type: "integer",
            minimum: 5,
            placeholder: "30",
          },
        ],
        capabilities: {
          humidity_percent: { kind: "sensor", unit: "%" },
        },
        commands: {
          identify: {
            description: "Ask the device to identify itself.",
            timeout_ms: 5000,
          },
        },
      };
    case "actuator-device":
      return {
        summary: "Local actuator starter with command and safety-oriented controls.",
        configFields: [
          {
            id: "poll_interval_seconds",
            title: "Poll Interval Seconds",
            type: "integer",
            minimum: 5,
            placeholder: "30",
          },
          { id: "safety_mode", title: "Safety Mode", type: "string", placeholder: "enabled" },
        ],
        capabilities: {
          target_state: { kind: "sensor", unit: "state" },
          set_power: { kind: "action" },
        },
        commands: {
          set_power: {
            description: "Set actuator power state.",
            timeout_ms: 5000,
          },
          identify: {
            description: "Ask the device to identify itself.",
            timeout_ms: 5000,
          },
        },
      };
    case "sidecar":
    case "sidecar-worker":
      return {
        summary: "Sidecar starter with service health and queue-oriented command hooks.",
        configFields: [
          { id: "service_name", title: "Service Name", type: "string", placeholder: "local-helper" },
        ],
        capabilities: {
          service_available: { kind: "sensor", unit: "bool" },
          queue_depth: { kind: "sensor", unit: "items" },
        },
        commands: {
          restart_worker: {
            description: "Restart the sidecar worker loop.",
            timeout_ms: 10000,
          },
        },
      };
    case "platform-service":
      return {
        summary: "Platform service starter for shared local dependencies.",
        configFields: [
          { id: "service_name", title: "Service Name", type: "string", placeholder: "platform-service" },
        ],
        capabilities: {
          service_available: { kind: "sensor", unit: "bool" },
          request_latency_ms: { kind: "sensor", unit: "ms" },
        },
        commands: {
          reload_registry: {
            description: "Reload the platform service registry.",
            timeout_ms: 10000,
          },
        },
      };
    case "minimal":
      return {
        summary: "Minimal contract starter with one sensor and one action.",
        configFields: [],
        capabilities: {},
        commands: {},
      };
  }
}

function configSchemaFor(options: ScaffoldOptions): JsonObject {
  const fields = presetShape(options.preset).configFields;
  return {
    schema: {
      title: `${options.title} Setup`,
      type: "object",
      required: ["host"],
      properties: Object.fromEntries([
        ["host", { type: "string", title: "Host" }],
        ["alias", { type: "string", title: "Alias" }],
        ...fields.map((field) => [
          field.id,
          {
            type: field.type,
            title: field.title,
            ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
          },
        ]),
      ]),
    },
    uiSchema: Object.fromEntries([
      ["host", { placeholder: "192.168.1.50" }],
      ["alias", { placeholder: "Office Device" }],
      ...fields.map((field) => [
        field.id,
        field.placeholder ? { placeholder: field.placeholder } : {},
      ]),
    ]),
  };
}

function capabilitiesFor(options: ScaffoldOptions): JsonObject {
  const shape = presetShape(options.preset);
  return {
    connected: {
      kind: "sensor",
      unit: "bool",
    },
    temperature_c: {
      kind: "sensor",
      unit: "C",
    },
    refresh: {
      kind: "action",
    },
    ...shape.capabilities,
    ...Object.fromEntries(Object.keys(shape.commands).map((commandId) => [commandId, { kind: "action" }])),
  };
}

function commandsFor(options: ScaffoldOptions): JsonObject {
  return {
    refresh: {
      description: "Refresh the device state.",
      timeout_ms: 5000,
    },
    ...presetShape(options.preset).commands,
  };
}

function entityFor(options: ScaffoldOptions): JsonObject {
  const commandIds = Object.keys(commandsFor(options));
  return {
    id: "demo-device",
    name: "Demo Device",
    device_id: "demo-device",
    entity_type: options.kind === "sidecar" ? "service" : "sensor",
    capabilities: Object.keys(capabilitiesFor(options)),
    available_commands: commandIds.map((id) => ({
      id,
      label: humanize(id),
      kind: "action",
    })),
    dashboard: {
      allowed_widgets: ["tile", "stat", "button"],
      default_widget: "tile",
    },
  };
}

function editableFieldsFor(options: ScaffoldOptions): string[] {
  return ["host", "alias", ...presetShape(options.preset).configFields.map((field) => field.id)];
}

function behaviorJson(options: ScaffoldOptions): string {
  const capabilityIds = Object.keys(capabilitiesFor(options));
  const commandIds = Object.keys(commandsFor(options));
  const deviceId = `${options.slug.replace(/-/g, "_")}_device`;
  const isActuator = options.domain === "actuator" || options.preset === "actuator-device";
  const deviceClass = isActuator ? "actuator_device" : "sensor_device";
  const actionOptions = commandIds.map((commandId) => ({
    id: commandId,
    label: humanize(commandId),
    description: `Run ${humanize(commandId).toLowerCase()} on the selected device.`,
    capability: commandId === "refresh" ? "device.refresh" : `action.${commandId}`,
    capabilityRequirements: [commandId === "refresh" ? "device.refresh" : `action.${commandId}`],
    runtime: { command: commandId, endpoint: "/command", method: "POST", timeoutSeconds: 30 },
    safety: {
      riskLevel: commandId === "toggle" ? "medium" : "low",
      requiresConfirmation: false,
      liveRunAllowed: true,
    },
    targeting: {
      fanoutSafe: commandId !== "toggle",
      supportsMultiTarget: true,
      scopes: ["config", "configs", "room", "rooms", "group", "groups", "tag", "tags", "capability", "selection", "all_matching"],
    },
    failure: {
      strategy: "retry_then_continue",
      retry: { maxAttempts: 1, delaySeconds: 2, backoff: "fixed" },
      timeoutSeconds: 30,
      continueOnPartialFailure: true,
      idempotent: commandId !== "toggle",
    },
    ui: { group: "do_this" },
  }));

  return json({
    behaviorSchemaVersion: "integration.behaviors.v2",
    templates: [
      {
        id: "notify_on_state_change",
        label: "Tell me when this device changes",
        description: "Starts from a saved device update and sends a simple notification.",
        category: "Starter",
        deviceKey: deviceId,
        config: {
          automation_schema_version: "automation.behavior.v2",
          triggers: [
            {
              id: "state_changed",
              label: "Device updates",
              type: "integration_event",
              event: "device.state_changed",
              capability: "telemetry.state",
              enabled: true,
              sourceRef: {
                integrationId: "{{integrationId}}",
                integrationKey: "{{integrationKey}}",
                configId: "{{configId}}",
                behaviorDeviceKey: deviceId,
                optionKey: "state_changed",
                capability: "telemetry.state",
              },
            },
          ],
          trigger: {
            id: "state_changed",
            label: "Device updates",
            type: "integration_event",
            event: "device.state_changed",
            capability: "telemetry.state",
            enabled: true,
          },
          intent: "keep_updated",
          conditionTree: { op: "and", children: [] },
          actions: [
            {
              id: "starter_notification",
              label: "Send notification",
              action: commandIds[0] || "notify",
              sourceRef: {
                integrationId: "{{integrationId}}",
                integrationKey: "{{integrationKey}}",
                configId: "{{configId}}",
                behaviorDeviceKey: deviceId,
                optionKey: commandIds[0] || "notify",
              },
              target: { mode: "selection", configIds: ["{{configId}}"] },
              failure: {
                strategy: "retry_then_continue",
                retry: { maxAttempts: 2, delaySeconds: 2, timeoutSeconds: 10, backoff: "fixed" },
                continueOnPartialFailure: true,
              },
            },
          ],
          safety: { staleDataMode: "block", maxAgeSeconds: 300, requireFreshTrigger: true, dryRunFirst: false },
          failure: { strategy: "follow_edges", fallbackBehaviorId: "", conditionTree: { op: "and", children: [] } },
          stop: { never: true },
          override: { mode: "continue" },
          execution: { failureStrategy: "follow_edges", fallbackBehaviorId: "", dispatchMode: "runtime" },
          policies: {
            execution: { failureStrategy: "follow_edges", fallbackBehaviorId: "", dispatchMode: "runtime" },
            freshness: { staleDataMode: "block" },
            manualOverride: { mode: "continue" },
            cooldownSeconds: 0,
          },
        },
        metadata: { generated: true, recommended: true },
      },
    ],
    devices: [
      {
        id: deviceId,
        name: options.title,
        description: `Automation metadata for ${options.title}.`,
        deviceClass,
        entityType: isActuator ? "device" : "sensor",
        capabilities: capabilityIds,
        targeting: {
          scopes: ["config", "configs", "room", "rooms", "group", "groups", "tag", "tags", "capability", "selection", "all_matching"],
          fanout: { supported: true, defaultMode: "selection", allowedModes: ["config", "configs", "room", "rooms", "group", "groups", "tag", "tags", "capability", "selection", "all_matching"] },
        },
        freshness: { maxAgeSeconds: 300, staleDataMode: "block" },
        ui: { icon: isActuator ? "power" : "activity", category: options.domain },
        triggers: [
          {
            id: "state_changed",
            label: "Device updates",
            description: "Start when this device reports a new state.",
            capability: "telemetry.state",
            runtime: { event: "device.state_changed", source: "integration" },
            freshness: { maxAgeSeconds: 300, staleDataMode: "block" },
            ui: { group: "when" },
          },
        ],
        intents: [
          {
            id: "keep_updated",
            label: "Keep this device useful",
            description: "Build automations around this device's state and commands.",
          },
        ],
        conditions: [
          {
            id: "state_matches",
            label: "State matches",
            description: "Only run when a reported state value matches what you choose.",
            type: "text",
            capability: "telemetry.state",
            operators: ["eq", "neq", "contains"],
            runtime: { source: "state", field: "state", operator: "eq" },
            freshness: { maxAgeSeconds: 300, staleDataMode: "block" },
            ui: { group: "only_if" },
            params: [
              { name: "field", label: "State field", type: "text", required: true },
              { name: "value", label: "Value", type: "text", required: true },
            ],
          },
        ],
        actions: actionOptions,
        stop: [
          {
            id: "after_duration",
            label: "After a set time",
            type: "duration",
            params: [
              { name: "duration", label: "How long", type: "duration", default: "30m", required: true },
            ],
          },
        ],
        manualOverride: [
          { id: "continue", label: "Keep running" },
          {
            id: "pause",
            label: "Pause",
            params: [
              { name: "duration", label: "Pause time", type: "duration", default: "30m", required: true },
            ],
          },
        ],
      },
    ],
  });
}

function manifestJson(options: ScaffoldOptions): string {
  const capabilities = capabilitiesFor(options);
  const commands = commandsFor(options);
  const entity = entityFor(options);
  const metadata = manifestMetadataFor(options);
  return json({
    $schema: "./schema/piphi-manifest.schema.json",
    manifest_version: "1.0",
    ...(isPlatformService(options) ? { kind: "platform_service" } : {}),
    id: options.slug,
    name: options.title,
    version: "0.1.0",
    description: `Starter PiPhi ${options.kind} runtime generated by piphi-network-create using the ${options.preset} preset for ${options.domain}.`,
    metadata,
    maintainer: {
      name: options.maintainerName,
      website: options.maintainerWebsite,
    },
    license: options.license,
    image: options.image,
    platforms: platformsFor(options),
    runtime: runtimeFor(options),
    api: {
      required: ["health", "entities", "command", "config", "ui_config"],
      endpoints: {
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
      },
    },
    config: {
      source: "endpoint",
      endpoint: "/ui-config",
      required: true,
      editable_fields: editableFieldsFor(options),
      runtime_fields: ["id", "config_id", "container_id", "device_id"],
      identity_fields: ["host"],
    },
    identity: {
      fields: ["host"],
    },
    capabilities,
    commands,
    entities: [entity],
  });
}

function manifestMetadataFor(options: ScaffoldOptions): JsonObject {
  const metadata: JsonObject = {
    generator: "piphi-network-create",
    scaffold_version: SCAFFOLD_VERSION,
    preset: options.preset,
    domain: options.domain,
    preset_summary: presetShape(options.preset).summary,
  };
  if (isPlatformService(options)) {
    metadata.helper_runtime = {
      service: options.slug,
      linux: {
        mode: "container",
        supervisor: "docker",
        recommended_for: ["local_service", "network_service"],
      },
      windows: {
        mode: "native_process",
        supervisor: "pm2",
        recommended_for: ["local_service"],
        docker_supported_for: ["network_service"],
      },
      macos: {
        mode: "native_process",
        supervisor: "pm2",
        recommended_for: ["local_service"],
        docker_supported_for: ["network_service"],
      },
    };
  }
  return metadata;
}

function platformsFor(options: ScaffoldOptions): string[] {
  if (isPlatformService(options)) {
    return ["linux", "windows", "macos"];
  }
  return ["linux"];
}

function runtimeFor(options: ScaffoldOptions): JsonObject {
  const linux = {
    type: "container",
    container: {
      image: options.image,
      ports: [
        {
          container: options.port,
          host: options.port,
        },
      ],
      environment: {
        LOG_LEVEL: "info",
      },
      restart_policy: {
        name: "unless-stopped",
        maximum_retry_count: 0,
      },
    },
    discovery: {
      method: "passive",
    },
  };
  if (!isPlatformService(options)) {
    return { linux };
  }
  return {
    linux,
    windows: proxyRuntimeFor(options, "windows"),
    macos: proxyRuntimeFor(options, "macos"),
  };
}

function proxyRuntimeFor(options: ScaffoldOptions, platform: "windows" | "macos"): JsonObject {
  const dataPath = platform === "windows"
    ? `%PROGRAMDATA%\\PiPhi\\${options.slug}`
    : `~/Library/Application Support/PiPhi/${options.slug}`;
  const configPath = platform === "windows"
    ? `${dataPath}\\config.json`
    : `${dataPath}/config.json`;
  return {
    type: "proxy",
    proxy: {
      port: options.port,
      process: {
        kind: `${options.language}_executable`,
        command: executableCommandFor(options),
        supervisor: "chief",
      },
      managed_helpers: [
        {
          id: options.slug,
          kind: "native_process",
          supervisor: "pm2",
          process_name: `piphi-${options.slug}`,
          config_path: configPath,
          data_path: dataPath,
          preferred_for: ["local_service"],
          docker_mode: {
            supported: true,
            preferred_for: ["network_service"],
            reason: "Prefer native helpers for host-local hardware or OS resources; use Docker when no host device passthrough is required.",
          },
        },
      ],
    },
    discovery: {
      method: "proxy",
      inputs: [],
    },
  };
}

function executableCommandFor(options: ScaffoldOptions): string {
  if (options.language === "python") {
    return options.snakeName;
  }
  if (options.language === "node") {
    return options.slug;
  }
  return options.slug;
}

function isPlatformService(options: ScaffoldOptions): boolean {
  return options.preset === "platform-service";
}

function manifestSchemaJson(): string {
  return renderManifestSchemaJson();
}

function nodeIndexSource(): string {
  return `import { createApp } from "./app.js";
import { runtimePort } from "./settings.js";

const app = createApp();
const port = runtimePort();

await app.listen({ host: "0.0.0.0", port });
`;
}

function nodeAppSource(): string {
  return `import Fastify from "fastify";

import { registerRoutes } from "./routes/index.js";

export function createApp() {
  const app = Fastify({ logger: true });
  registerRoutes(app);
  return app;
}
`;
}

function nodeSettingsSource(options: ScaffoldOptions): string {
  return `export const integrationId = "${options.slug}";
export const integrationName = "${options.title}";
export const integrationVersion = "0.1.0";
export const projectKind = "${options.kind}";
export const projectPreset = "${options.preset}";
export const projectDomain = "${options.domain}";
export const defaultPort = ${options.port};

export function runtimePort(): number {
  const value = Number(process.env.PORT ?? defaultPort);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : defaultPort;
}
`;
}

function nodeContractSource(options: ScaffoldOptions): string {
  const capabilities = JSON.stringify(capabilitiesFor(options), null, 2);
  const commands = JSON.stringify(commandsFor(options), null, 2);
  const configSchema = JSON.stringify(configSchemaFor(options), null, 2);
  const fallbackEntity = JSON.stringify(entityFor(options), null, 2);
  return `export const endpoints = {
  health: "/health",
  diagnostics: "/diagnostics",
  discover: "/discover",
  entities: "/entities",
  state: "/state",
  config: "/config",
  configSync: "/config/sync",
  deconfigure: "/deconfigure",
  uiConfig: "/ui-config",
  events: "/events",
  command: "/command",
} as const;

export const requiredEndpoints = ["health", "entities", "command", "config", "ui_config"] as const;

export const capabilities = ${capabilities} as const;

export const commands = ${commands} as const;

export const configSchema = ${configSchema} as const;

export const fallbackEntity = ${fallbackEntity} as const;
`;
}

function nodeTypesSource(): string {
  return `import type { RuntimeConfig } from "piphi-runtime-kit-node";

export type DeviceState = {
  connected: boolean;
  host: string;
  alias?: string | null;
};

export interface DeviceConfig extends RuntimeConfig {
  host: string;
  alias?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  poll_interval_seconds?: number | null;
  service_name?: string | null;
}

export type DeviceEntry = {
  configId: string;
  deviceId: string;
  containerId?: string | null;
  integrationId?: string | null;
  host: string;
  alias?: string | null;
  config: DeviceConfig;
  latestState?: DeviceState;
};
`;
}

function nodeStateSource(): string {
  return `import {
  buildLocalEventRecord,
  createRuntimeStarter,
  type RuntimeRegistry,
} from "piphi-runtime-kit-node";

import { integrationId, integrationName, integrationVersion } from "./settings.js";
import type { DeviceConfig, DeviceEntry, DeviceState } from "./types.js";

export const starter = createRuntimeStarter({
  integrationId,
  integrationName,
  version: integrationVersion,
});

export const runtime = starter.runtime;
export const registry = starter.registry as unknown as RuntimeRegistry<
  DeviceState,
  DeviceEntry,
  Record<string, unknown>
>;
export const telemetry = starter.telemetryClient;
export const configSync = starter.configSync;

export function buildEntry(config: DeviceConfig): DeviceEntry {
  return {
    configId: config.configId ?? config.id,
    deviceId: config.deviceId ?? config.id,
    containerId: config.containerId,
    integrationId: config.integrationId ?? integrationId,
    host: config.host,
    alias: config.alias,
    config,
  };
}

export async function applyConfig(config: DeviceConfig): Promise<void> {
  const entry = buildEntry(config);
  registry.set(config.id, entry);
  registry.updateState(
    config.id,
    {
      connected: true,
      host: config.host,
      alias: config.alias,
    },
  );
  appendRuntimeEvent("runtime.config.applied", entry, {
    host: config.host,
    alias: config.alias ?? null,
  });
}

export async function removeConfig(configId: string): Promise<boolean> {
  const entry = registry.remove(configId);
  if (!entry) {
    return false;
  }
  appendRuntimeEvent("runtime.config.removed", entry, {
    host: entry.host,
    alias: entry.alias ?? null,
  });
  return true;
}

export function appendRuntimeEvent(
  eventType: string,
  entry: Partial<DeviceEntry> & { deviceId: string; configId: string },
  payload: Record<string, unknown>,
) {
  return registry.appendEvent(
    buildLocalEventRecord({
      eventType,
      deviceId: entry.deviceId,
      configId: entry.configId,
      containerId: entry.containerId ?? runtime.auth.containerId ?? null,
      integrationId: entry.integrationId ?? integrationId,
      source: integrationId,
      severity: "info",
      payload,
    }),
  );
}
`;
}

function nodeRoutesIndexSource(): string {
  return `import type { FastifyInstance } from "fastify";

import { registerCommandRoutes } from "./commands.js";
import { registerConfigRoutes } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { registerEntityRoutes } from "./entities.js";
import { registerEventRoutes } from "./events.js";
import { registerHealthRoutes } from "./health.js";
import { registerRuntimeRoutes } from "./runtime.js";
import { registerTelemetryRoutes } from "./telemetry.js";

export function registerRoutes(app: FastifyInstance): void {
  registerHealthRoutes(app);
  registerDiscoveryRoutes(app);
  registerConfigRoutes(app);
  registerRuntimeRoutes(app);
  registerEntityRoutes(app);
  registerEventRoutes(app);
  registerTelemetryRoutes(app);
  registerCommandRoutes(app);
}
`;
}

function nodeHealthRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";

import { endpoints, requiredEndpoints } from "../contract.js";
import { projectKind } from "../settings.js";
import { registry, starter } from "../state.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    return starter.healthResponse({ activeConfigs: registry.ids().length });
  });

  app.get("/diagnostics", async () => {
    return starter.diagnosticsResponse({
      activeConfigIds: registry.ids(),
      recentEventCount: registry.recentEvents.length,
      kind: projectKind,
      contract: {
        endpoints,
        required: requiredEndpoints,
      },
    });
  });
}
`;
}

function nodeDiscoveryRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";
import {
  buildDiscoveryResponse,
  normalizeDiscoveryInputs,
  type IntegrationDiscoveryRequest,
} from "piphi-runtime-kit-node";

import { configSchema } from "../contract.js";

export function registerDiscoveryRoutes(app: FastifyInstance): void {
  app.post("/discover", async (request) => {
    const body = (request.body ?? {}) as IntegrationDiscoveryRequest;
    const inputs = normalizeDiscoveryInputs(body.inputs);
    return buildDiscoveryResponse([
      {
        id: "demo-device",
        deviceId: "demo-device",
        host: String(inputs.host ?? "127.0.0.1"),
        alias: "Demo Device",
      },
    ]);
  });

  app.get("/ui-config", async () => {
    return configSchema;
  });
}
`;
}

function nodeConfigRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";
import {
  buildConfigApplyResponse,
  buildConfigRemoveResponse,
  type RuntimeConfigSnapshot,
} from "piphi-runtime-kit-node";
import { syncRuntimeAuthFromFastifyRequest } from "piphi-runtime-kit-node/adapters/fastify";

import { applyConfig, configSync, registry, removeConfig, runtime } from "../state.js";
import type { DeviceConfig } from "../types.js";

export function registerConfigRoutes(app: FastifyInstance): void {
  app.post("/config", async (request) => {
    const payload = request.body as DeviceConfig;
    syncRuntimeAuthFromFastifyRequest(runtime, request, payload.containerId);
    await applyConfig(payload);
    return buildConfigApplyResponse({
      configId: payload.configId ?? payload.id,
      containerId: payload.containerId,
      metadata: {
        host: payload.host,
        alias: payload.alias ?? null,
      },
    });
  });

  app.post("/config/sync", async (request) => {
    const snapshot = request.body as RuntimeConfigSnapshot<DeviceConfig>;
    syncRuntimeAuthFromFastifyRequest(runtime, request, snapshot.containerId);
    return configSync.applySnapshot(snapshot, {
      activeConfigIds: registry.ids(),
      applyConfig,
      removeConfig,
      getActiveConfigIds: () => registry.ids(),
    });
  });

  app.post("/deconfigure", async (request) => {
    const payload = (request.body ?? {}) as { config_id?: string; configId?: string };
    const configId = payload.config_id ?? payload.configId;
    if (!configId) {
      return { ok: false, reason: "missing config_id" };
    }
    const removed = await removeConfig(configId);
    return buildConfigRemoveResponse({
      configId,
      removed,
    });
  });

  app.post("/deconfigure/:configId", async (request) => {
    const { configId } = request.params as { configId: string };
    const removed = await removeConfig(configId);
    return buildConfigRemoveResponse({
      configId,
      removed,
    });
  });
}
`;
}

function nodeRuntimeRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";

import { endpoints, requiredEndpoints } from "../contract.js";
import { integrationId, integrationName, integrationVersion, projectDomain, projectKind, projectPreset } from "../settings.js";
import { registry } from "../state.js";

export function registerRuntimeRoutes(app: FastifyInstance): void {
  app.get("/state", async () => {
    return {
      summary: {
        activeConfigCount: registry.ids().length,
        recentEventCount: registry.recentEvents.length,
      },
      entries: Object.fromEntries(registry.entries),
      stateSnapshots: Object.fromEntries(registry.stateSnapshots),
    };
  });

  app.get("/contract", async () => {
    return {
      integration_id: integrationId,
      name: integrationName,
      version: integrationVersion,
      kind: projectKind,
      preset: projectPreset,
      domain: projectDomain,
      endpoints,
      required: requiredEndpoints,
    };
  });
}
`;
}

function nodeEntityRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";

import { capabilities, commands, fallbackEntity } from "../contract.js";
import { registry } from "../state.js";
import type { DeviceEntry } from "../types.js";

export function registerEntityRoutes(app: FastifyInstance): void {
  app.get("/entities", async () => {
    const entries = [...registry.entries.values()] as DeviceEntry[];
    return {
      entities: entries.length > 0
        ? entries.map((entry) => ({
            id: entry.deviceId,
            name: entry.alias ?? "Demo Device",
            config_id: entry.configId,
            device_id: entry.deviceId,
            entity_type: fallbackEntity.entity_type,
            capabilities: fallbackEntity.capabilities,
            available_commands: fallbackEntity.available_commands,
            dashboard: fallbackEntity.dashboard,
          }))
        : [fallbackEntity],
      capabilities,
      commands,
    };
  });
}
`;
}

function nodeEventRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";
import { buildEventIngestResponse, buildEventListResponse } from "piphi-runtime-kit-node";

import { integrationId } from "../settings.js";
import { appendRuntimeEvent, registry, runtime } from "../state.js";

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/events", async () => {
    return buildEventListResponse(registry.recentEvents);
  });

  app.post("/events/example", async () => {
    const entry = registry.primaryEntry();
    const event = appendRuntimeEvent(
      "runtime.event",
      {
        deviceId: entry?.deviceId ?? "demo-device",
        configId: entry?.configId ?? "demo-device",
        containerId: entry?.containerId ?? runtime.auth.containerId ?? null,
        integrationId: entry?.integrationId ?? integrationId,
      },
      { message: "Example local runtime event" },
    );
    return buildEventIngestResponse(event);
  });

  app.post("/events/device/:configId/example", async (request, reply) => {
    const { configId } = request.params as { configId: string };
    const entry = registry.get(configId);
    if (!entry) {
      return reply.code(404).send({ ok: false, reason: \`unknown config_id=\${configId}\` });
    }
    const event = appendRuntimeEvent("runtime.device.checked", entry, {
      message: "Example local runtime event for a configured device",
      host: entry.host,
    });
    return buildEventIngestResponse(event);
  });
}
`;
}

function nodeTelemetryRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";
import { scheduleTelemetryDelivery } from "piphi-runtime-kit-node";
import { syncRuntimeAuthFromFastifyRequest } from "piphi-runtime-kit-node/adapters/fastify";

import { registry, runtime, telemetry } from "../state.js";
import type { DeviceEntry } from "../types.js";

function queueTelemetry(entry: DeviceEntry): void {
  scheduleTelemetryDelivery({
    processState: runtime.processState,
    telemetryClient: telemetry,
    authContext: runtime.auth,
    deviceId: entry.deviceId,
    containerId: entry.containerId,
    metrics: {
      connected: true,
      temperature_c: 21.4,
    },
    units: {
      temperature_c: "C",
    },
  });
}

export function registerTelemetryRoutes(app: FastifyInstance): void {
  app.post("/telemetry/example", async (request, reply) => {
    syncRuntimeAuthFromFastifyRequest(runtime, request);
    const entry = registry.primaryEntry();
    if (!entry) {
      return reply.code(409).send({ ok: false, reason: "no configured devices" });
    }
    queueTelemetry(entry);
    return reply.code(202).send({ status: "queued" });
  });

  app.post("/telemetry/device/:configId/example", async (request, reply) => {
    syncRuntimeAuthFromFastifyRequest(runtime, request);
    const { configId } = request.params as { configId: string };
    const entry = registry.get(configId);
    if (!entry) {
      return reply.code(404).send({ ok: false, reason: \`unknown config_id=\${configId}\` });
    }
    queueTelemetry(entry);
    return reply.code(202).send({ status: "queued" });
  });
}
`;
}

function nodeCommandRoutesSource(): string {
  return `import type { FastifyInstance } from "fastify";
import { buildEventIngestResponse } from "piphi-runtime-kit-node";

import { commands } from "../contract.js";
import { appendRuntimeEvent, registry } from "../state.js";

export function registerCommandRoutes(app: FastifyInstance): void {
  app.post("/command", async (request, reply) => {
    const body = (request.body ?? {}) as {
      contract_version?: string;
      command?: string;
      capability_id?: string;
      capability?: string;
      capability_requirements?: string[];
      config_id?: string;
      device_id?: string;
      entity_id?: string;
      target?: Record<string, unknown>;
      params?: Record<string, unknown>;
      args?: Record<string, unknown>;
    };
    const commandName = String(body.command ?? body.capability_id ?? "").trim();
    if (!commandName) {
      return reply.code(400).send({ ok: false, reason: "Missing command" });
    }
    if (!(commandName in commands)) {
      return reply.code(400).send({ ok: false, reason: \`Unsupported command: \${commandName}\` });
    }

    const target = body.target && typeof body.target === "object" ? body.target : {};
    const deviceId = String(body.device_id ?? target.device_id ?? "demo-device");
    const configId = String(body.config_id ?? target.config_id ?? deviceId);
    const entry = registry.get(configId) ?? { deviceId, configId };
    const requestedCapabilities = [
      body.capability,
      ...(Array.isArray(body.capability_requirements) ? body.capability_requirements : []),
    ].filter((value): value is string => Boolean(value));
    const unsupportedCapability = requestedCapabilities.find((capability) => capability !== "device.refresh" && capability !== \`action.\${commandName}\`);
    if (unsupportedCapability) {
      return reply.code(400).send({
        ok: false,
        error: "unsupported_capability",
        message: \`This runtime does not support capability \${unsupportedCapability}\`,
      });
    }
    const event = appendRuntimeEvent("runtime.command.received", entry, {
      command: commandName,
      device_id: deviceId,
      entity_id: body.entity_id ?? null,
      args: body.params ?? body.args ?? {},
      target,
    });
    return {
      ...buildEventIngestResponse(event),
      ok: true,
      command: commandName,
      contract_version: body.contract_version ?? null,
      device_id: deviceId,
      config_id: configId,
      target,
      params: body.params ?? body.args ?? {},
    };
  });
}
`;
}

function nodeRuntimeSource(options: ScaffoldOptions): string {
  return `import Fastify from "fastify";
import {
  buildConfigApplyResponse,
  buildConfigRemoveResponse,
  buildDiscoveryResponse,
  buildEventIngestResponse,
  buildEventListResponse,
  buildLocalEventRecord,
  buildRuntimeIdentity,
  createRuntimeStarter,
  normalizeDiscoveryInputs,
  scheduleTelemetryDelivery,
  type IntegrationDiscoveryRequest,
  type RuntimeConfig,
  type RuntimeConfigSnapshot,
} from "piphi-runtime-kit-node";
import { syncRuntimeAuthFromFastifyRequest } from "piphi-runtime-kit-node/adapters/fastify";

const integrationId = "${options.slug}";
const integrationName = "${options.title}";
const integrationVersion = "0.1.0";
const port = Number(process.env.PORT ?? ${options.port});

type DeviceState = {
  connected: boolean;
  host: string;
  alias?: string | null;
};

interface DeviceConfig extends RuntimeConfig {
  host: string;
  alias?: string | null;
}

type DeviceEntry = {
  configId: string;
  deviceId: string;
  containerId?: string | null;
  integrationId?: string | null;
  host: string;
  alias?: string | null;
  config: DeviceConfig;
  latestState?: DeviceState;
};

const starter = createRuntimeStarter({
  integrationId,
  integrationName,
  version: integrationVersion,
});
const runtime = starter.runtime;
const registry = starter.registry as typeof starter.registry & {
  set(entryId: string, entry: DeviceEntry): DeviceEntry;
  get(entryId: string): DeviceEntry | undefined;
  primaryEntry(): DeviceEntry | undefined;
  remove(entryId: string): DeviceEntry | undefined;
};
const telemetry = starter.telemetryClient;
const configSync = starter.configSync;
const app = Fastify({ logger: true });

const capabilities = {
  connected: { kind: "sensor", unit: "bool" },
  temperature_c: { kind: "sensor", unit: "C" },
  refresh: { kind: "action" },
};
const commands = {
  refresh: { description: "Refresh the device state.", timeout_ms: 5000 },
};

function buildEntry(config: DeviceConfig): DeviceEntry {
  const identity = buildRuntimeIdentity(config, { integrationId });
  return {
    ...identity,
    host: config.host,
    alias: config.alias,
    config,
  };
}

async function applyConfig(config: DeviceConfig): Promise<void> {
  const entry = buildEntry(config);
  registry.set(config.id, entry);
  registry.updateState(
    config.id,
    {
      connected: true,
      host: config.host,
      alias: config.alias,
    },
    entry.deviceId,
  );
  appendRuntimeEvent("runtime.config.applied", entry, {
    host: config.host,
    alias: config.alias ?? null,
  });
}

async function removeConfig(configId: string): Promise<boolean> {
  const entry = registry.remove(configId);
  if (!entry) {
    return false;
  }
  appendRuntimeEvent("runtime.config.removed", entry, {
    host: entry.host,
    alias: entry.alias ?? null,
  });
  return true;
}

function appendRuntimeEvent(
  eventType: string,
  entry: Partial<DeviceEntry> & { deviceId: string; configId: string },
  payload: Record<string, unknown>,
) {
  return registry.appendEvent(
    buildLocalEventRecord({
      eventType,
      deviceId: entry.deviceId,
      configId: entry.configId,
      containerId: entry.containerId ?? runtime.auth.containerId ?? null,
      integrationId: entry.integrationId ?? integrationId,
      source: integrationId,
      severity: "info",
      payload,
    }),
  );
}

app.get("/health", async () => {
  return starter.healthResponse({ activeConfigs: registry.ids().length });
});

app.get("/diagnostics", async () => {
  return starter.diagnosticsResponse({
    activeConfigIds: registry.ids(),
    recentEventCount: registry.recentEvents.length,
    kind: "${options.kind}",
  });
});

app.post("/discover", async (request) => {
  const body = (request.body ?? {}) as IntegrationDiscoveryRequest;
  const inputs = normalizeDiscoveryInputs(body.inputs);
  return buildDiscoveryResponse([
    {
      id: "demo-device",
      deviceId: "demo-device",
      host: String(inputs.host ?? "127.0.0.1"),
      alias: "Demo Device",
    },
  ]);
});

app.get("/ui-config", async () => {
  return {
    schema: {
      title: "${options.title} Setup",
      type: "object",
      required: ["host"],
      properties: {
        host: { type: "string", title: "Host" },
        alias: { type: "string", title: "Alias" },
      },
    },
    uiSchema: {
      host: { placeholder: "192.168.1.50" },
      alias: { placeholder: "Office Device" },
    },
  };
});

app.post("/config", async (request) => {
  const payload = request.body as DeviceConfig;
  syncRuntimeAuthFromFastifyRequest(runtime, request, payload.containerId);
  await applyConfig(payload);
  return buildConfigApplyResponse({
    configId: payload.configId ?? payload.id,
    containerId: payload.containerId,
    metadata: {
      host: payload.host,
      alias: payload.alias ?? null,
    },
  });
});

app.post("/config/sync", async (request) => {
  const snapshot = request.body as RuntimeConfigSnapshot<DeviceConfig>;
  runtime.auth.syncFromHeaders(request.headers, snapshot.containerId);
  return configSync.applySnapshot(snapshot, {
    activeConfigIds: registry.ids(),
    applyConfig,
    removeConfig,
    getActiveConfigIds: () => registry.ids(),
  });
});

app.post("/deconfigure", async (request) => {
  const payload = (request.body ?? {}) as { config_id?: string; configId?: string };
  const configId = payload.config_id ?? payload.configId;
  if (!configId) {
    return { ok: false, reason: "missing config_id" };
  }
  const removed = await removeConfig(configId);
  return buildConfigRemoveResponse({
    configId,
    removed,
    metadata: { remainingConfigs: registry.ids() },
  });
});

app.get("/state", async () => {
  return {
    summary: {
      activeConfigCount: registry.ids().length,
      recentEventCount: registry.recentEvents.length,
    },
    entries: Object.fromEntries(registry.entries),
    stateSnapshots: Object.fromEntries(registry.stateSnapshots),
  };
});

app.get("/entities", async () => {
  const entries = [...registry.entries.values()] as DeviceEntry[];
  return {
    entities: entries.length > 0
      ? entries.map((entry) => ({
          id: entry.deviceId,
          name: entry.alias ?? "Demo Device",
          config_id: entry.configId,
          device_id: entry.deviceId,
          entity_type: "sensor",
          capabilities: ["connected", "temperature_c", "refresh"],
        }))
      : [
          {
            id: "demo-device",
            name: "Demo Device",
            entity_type: "sensor",
            capabilities: ["connected", "temperature_c", "refresh"],
          },
        ],
    capabilities,
    commands,
  };
});

app.get("/events", async () => {
  return buildEventListResponse(registry.recentEvents);
});

app.post("/events/example", async () => {
  const entry = registry.primaryEntry();
  const event = appendRuntimeEvent(
    "runtime.event",
    {
      deviceId: entry?.deviceId ?? "demo-device",
      configId: entry?.configId ?? "demo-device",
      containerId: entry?.containerId ?? runtime.auth.containerId ?? null,
      integrationId: entry?.integrationId ?? integrationId,
    },
    { message: "Example local runtime event" },
  );
  return buildEventIngestResponse(event);
});

app.post("/telemetry/example", async (request, reply) => {
  syncRuntimeAuthFromFastifyRequest(runtime, request);
  const entry = registry.primaryEntry();
  if (!entry) {
    return reply.code(409).send({ ok: false, reason: "no configured devices" });
  }
  scheduleTelemetryDelivery({
    processState: runtime.processState,
    telemetryClient: telemetry,
    authContext: runtime.auth,
    deviceId: entry.deviceId,
    containerId: entry.containerId,
    metrics: {
      connected: true,
      temperature_c: 21.4,
    },
    units: {
      temperature_c: "C",
    },
  });
  return reply.code(202).send({ status: "queued" });
});

app.post("/command", async (request) => {
  const body = (request.body ?? {}) as { command?: string };
  appendRuntimeEvent("runtime.command.received", {
    deviceId: "demo-device",
    configId: "demo-device",
  }, {
    command: body.command ?? "unknown",
  });
  return { ok: true };
});

await app.listen({ host: "0.0.0.0", port });
`;
}

function pythonAppSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from fastapi import FastAPI

from .lifecycle import lifespan
from .routes import routers
from .settings import INTEGRATION_NAME


def create_app() -> FastAPI:
    app = FastAPI(title=INTEGRATION_NAME, lifespan=lifespan)
    for router in routers:
        app.include_router(router)
    return app
`;
}

function pythonSettingsSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

import os

INTEGRATION_ID = "${options.slug}"
INTEGRATION_NAME = "${options.title}"
INTEGRATION_VERSION = "0.1.0"
PROJECT_KIND = "${options.kind}"
PROJECT_PRESET = "${options.preset}"
PROJECT_DOMAIN = "${options.domain}"
DEFAULT_PORT = ${options.port}


def runtime_port() -> int:
    raw_port = os.getenv("PORT", str(DEFAULT_PORT))
    try:
        return int(raw_port)
    except ValueError:
        return DEFAULT_PORT
`;
}

function pythonSchemasSource(): string {
  return `from __future__ import annotations

from piphi_runtime_kit_python import RuntimeConfig


class DeviceConfig(RuntimeConfig):
    host: str
    alias: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    poll_interval_seconds: int | None = None
    service_name: str | None = None
`;
}

function pythonContractSource(options: ScaffoldOptions): string {
  const capabilities = JSON.stringify(capabilitiesFor(options), null, 4);
  const commands = JSON.stringify(commandsFor(options), null, 4);
  const configSchema = JSON.stringify(configSchemaFor(options), null, 4);
  const fallbackEntity = JSON.stringify(entityFor(options), null, 4);
  return `from __future__ import annotations

from typing import Any

ENDPOINTS = {
    "health": "/health",
    "diagnostics": "/diagnostics",
    "discover": "/discover",
    "entities": "/entities",
    "state": "/state",
    "config": "/config",
    "config_sync": "/config/sync",
    "deconfigure": "/deconfigure",
    "ui_config": "/ui-config",
    "events": "/events",
    "command": "/command",
}

REQUIRED_ENDPOINTS = ["health", "entities", "command", "config", "ui_config"]

CAPABILITIES: dict[str, dict[str, Any]] = ${capabilities}

COMMANDS: dict[str, dict[str, Any]] = ${commands}

CONFIG_SCHEMA: dict[str, Any] = ${configSchema}

FALLBACK_ENTITY: dict[str, Any] = ${fallbackEntity}
`;
}

function pythonStateSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from piphi_runtime_kit_python import (
    build_local_event_record,
    build_runtime_identity,
    create_runtime_starter,
)

from .contract import CAPABILITIES, COMMANDS
from .schemas import DeviceConfig
from .settings import INTEGRATION_ID, INTEGRATION_NAME, INTEGRATION_VERSION

starter = create_runtime_starter(
    integration_id=INTEGRATION_ID,
    integration_name=INTEGRATION_NAME,
    version=INTEGRATION_VERSION,
)
runtime = starter.runtime
registry = starter.registry
telemetry = starter.telemetry_client
config_sync = starter.config_sync

capabilities = CAPABILITIES
commands = COMMANDS


def make_entry(config: DeviceConfig) -> dict[str, Any]:
    identity = build_runtime_identity(config, integration_id=INTEGRATION_ID)
    return {
        **identity,
        "host": config.host,
        "alias": config.alias,
        "config": config.model_dump(),
    }


def append_runtime_event(
    event_type: str,
    device: dict[str, Any],
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event = build_local_event_record(
        event_type=event_type,
        device=device,
        payload=payload or {},
        source=INTEGRATION_ID,
        severity="info",
    )
    registry.append_event(event)
    return event


def get_entry_or_404(config_id: str) -> dict[str, Any]:
    entry = registry.get(config_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"unknown config_id={config_id}")
    return entry


async def apply_config(config: DeviceConfig) -> None:
    entry = make_entry(config)
    registry.set(config.id, entry)
    registry.update_state(
        config.id,
        {
            "connected": True,
            "host": config.host,
            "alias": config.alias,
            "config_id": entry["config_id"],
        },
        device_id=entry["device_id"],
    )
    append_runtime_event(
        "runtime.config.applied",
        entry,
        {"host": config.host, "alias": config.alias},
    )


async def remove_config(config_id: str) -> bool:
    entry = registry.remove(config_id)
    if entry is None:
        return False
    append_runtime_event(
        "runtime.config.removed",
        entry,
        {"host": entry.get("host"), "alias": entry.get("alias")},
    )
    return True
`;
}

function pythonLifecycleSource(): string {
  return `from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from piphi_runtime_kit_python import runtime_lifespan

from .state import runtime


async def startup_sync(_runtime, _client) -> None:
    # Real integrations can fetch an existing config snapshot from Core here.
    return None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    async with runtime_lifespan(runtime, on_startup=startup_sync):
        yield
`;
}

function pythonMainSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from .app import create_app
from .settings import runtime_port

app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=runtime_port())


if __name__ == "__main__":
    main()
`;
}

function pythonRoutesInitSource(): string {
  return `from __future__ import annotations

from .commands import router as command_router
from .config import router as config_router
from .discovery import router as discovery_router
from .entities import router as entity_router
from .events import router as event_router
from .health import router as health_router
from .runtime import router as runtime_router
from .telemetry import router as telemetry_router

routers = [
    health_router,
    discovery_router,
    config_router,
    runtime_router,
    entity_router,
    event_router,
    telemetry_router,
    command_router,
]
`;
}

function pythonHealthRoutesSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from fastapi import APIRouter

from ..contract import ENDPOINTS, REQUIRED_ENDPOINTS
from ..settings import PROJECT_KIND
from ..state import registry, starter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return starter.health_response(metadata={"active_configs": len(registry.ids())})


@router.get("/diagnostics")
async def diagnostics():
    return starter.diagnostics_response(
        diagnostics={
            "active_config_ids": registry.ids(),
            "recent_event_count": len(registry.recent_events),
            "kind": PROJECT_KIND,
            "contract": {
                "endpoints": ENDPOINTS,
                "required": REQUIRED_ENDPOINTS,
            },
        }
    )
`;
}

function pythonDiscoveryRoutesSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from fastapi import APIRouter
from piphi_runtime_kit_python import (
    IntegrationDiscoveryRequest,
    build_discovery_response,
    normalize_discovery_inputs,
)

from ..contract import CONFIG_SCHEMA

router = APIRouter(tags=["discovery"])


@router.post("/discover")
async def discover(payload: IntegrationDiscoveryRequest | None = None):
    inputs = normalize_discovery_inputs(payload.inputs if payload else None)
    return build_discovery_response(
        [
            {
                "id": "demo-device",
                "device_id": "demo-device",
                "host": inputs.get("host", "127.0.0.1"),
                "alias": "Demo Device",
            }
        ]
    )


@router.get("/ui-config")
async def ui_config():
    return CONFIG_SCHEMA
`;
}

function pythonConfigRoutesSource(): string {
  return `from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from piphi_runtime_kit_python import (
    RuntimeConfigSnapshot,
    build_config_apply_response,
    build_config_remove_response,
    validate_typed_configs,
)
from piphi_runtime_kit_python.fastapi import sync_runtime_auth_from_fastapi_payload

from ..schemas import DeviceConfig
from ..state import (
    apply_config,
    config_sync,
    registry,
    remove_config,
    runtime,
)

router = APIRouter(tags=["config"])


@router.post("/config")
async def configure(payload: DeviceConfig, request: Request):
    sync_runtime_auth_from_fastapi_payload(runtime, request, payload)
    await apply_config(payload)
    return build_config_apply_response(
        config_id=payload.config_id or payload.id,
        container_id=payload.container_id,
        metadata={"host": payload.host, "alias": payload.alias},
    )


@router.post("/config/sync")
async def sync_config(snapshot: RuntimeConfigSnapshot, request: Request):
    runtime.auth.sync_from_headers(request.headers, payload_container_id=snapshot.container_id)
    typed_configs = validate_typed_configs(snapshot.configs, DeviceConfig)
    return await config_sync.apply_snapshot(
        snapshot=snapshot.model_copy(update={"configs": typed_configs}),
        active_config_ids=registry.ids(),
        apply_config=apply_config,
        remove_config=remove_config,
        get_active_config_ids=registry.ids,
    )


@router.post("/deconfigure")
async def deconfigure(payload: dict[str, Any]):
    config_id = payload.get("config_id") or payload.get("configId")
    if not config_id:
        return {"ok": False, "reason": "missing config_id"}
    removed = await remove_config(str(config_id))
    return build_config_remove_response(
        config_id=str(config_id),
        removed=removed,
        metadata={"remaining_configs": registry.ids()},
    )


@router.post("/deconfigure/{config_id}")
async def deconfigure_by_path(config_id: str):
    removed = await remove_config(config_id)
    return build_config_remove_response(
        config_id=config_id,
        removed=removed,
        metadata={"remaining_configs": registry.ids()},
    )
`;
}

function pythonRuntimeRoutesSource(): string {
  return `from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..contract import ENDPOINTS, REQUIRED_ENDPOINTS
from ..settings import (
    INTEGRATION_ID,
    INTEGRATION_NAME,
    INTEGRATION_VERSION,
    PROJECT_DOMAIN,
    PROJECT_KIND,
    PROJECT_PRESET,
)
from ..state import registry

router = APIRouter(tags=["runtime"])


@router.get("/state")
async def state() -> dict[str, Any]:
    return {
        "summary": {
            "active_config_count": len(registry.ids()),
            "recent_event_count": len(registry.recent_events),
        },
        "entries": registry.entries,
        "state_snapshots": registry.state_snapshots,
    }


@router.get("/contract")
async def contract() -> dict[str, Any]:
    return {
        "integration_id": INTEGRATION_ID,
        "name": INTEGRATION_NAME,
        "version": INTEGRATION_VERSION,
        "kind": PROJECT_KIND,
        "preset": PROJECT_PRESET,
        "domain": PROJECT_DOMAIN,
        "endpoints": ENDPOINTS,
        "required": REQUIRED_ENDPOINTS,
    }
`;
}

function pythonEntityRoutesSource(): string {
  return `from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..contract import FALLBACK_ENTITY
from ..state import capabilities, commands, registry

router = APIRouter(tags=["entities"])


@router.get("/entities")
async def entities() -> dict[str, Any]:
    entries = list(registry.entries.values())
    runtime_entities = [
        {
            "id": entry["device_id"],
            "name": entry.get("alias") or "Demo Device",
            "config_id": entry["config_id"],
            "device_id": entry["device_id"],
            "entity_type": FALLBACK_ENTITY["entity_type"],
            "capabilities": FALLBACK_ENTITY["capabilities"],
            "available_commands": FALLBACK_ENTITY["available_commands"],
            "dashboard": FALLBACK_ENTITY["dashboard"],
        }
        for entry in entries
    ] or [FALLBACK_ENTITY]
    return {"entities": runtime_entities, "capabilities": capabilities, "commands": commands}
`;
}

function pythonEventRoutesSource(): string {
  return `from __future__ import annotations

from fastapi import APIRouter
from piphi_runtime_kit_python import build_event_ingest_response, build_event_list_response

from ..settings import INTEGRATION_ID
from ..state import append_runtime_event, get_entry_or_404, registry, runtime

router = APIRouter(tags=["events"])


@router.get("/events")
async def events():
    return build_event_list_response(registry.recent_events)


@router.post("/events/example")
async def event_example():
    entry = registry.primary_entry() or {
        "device_id": "demo-device",
        "config_id": "demo-device",
        "integration_id": INTEGRATION_ID,
        "container_id": runtime.auth.container_id or None,
    }
    event = append_runtime_event(
        "runtime.event",
        entry,
        {"message": "Example local runtime event"},
    )
    return build_event_ingest_response(event)


@router.post("/events/device/{config_id}/example")
async def device_event_example(config_id: str):
    entry = get_entry_or_404(config_id)
    event = append_runtime_event(
        "runtime.device.checked",
        entry,
        {
            "message": "Example local runtime event for a configured device",
            "host": entry.get("host"),
        },
    )
    return build_event_ingest_response(event)
`;
}

function pythonTelemetryRoutesSource(): string {
  return `from __future__ import annotations

from fastapi import APIRouter, Request
from piphi_runtime_kit_python import schedule_telemetry_delivery
from piphi_runtime_kit_python.fastapi import sync_runtime_auth_from_fastapi_payload

from ..state import get_entry_or_404, registry, runtime, telemetry

router = APIRouter(tags=["telemetry"])


@router.post("/telemetry/example")
async def telemetry_example(request: Request):
    entry = registry.primary_entry()
    if entry is None:
        return {"ok": False, "reason": "no configured devices"}
    sync_runtime_auth_from_fastapi_payload(runtime, request, entry)
    schedule_telemetry_delivery(
        process_state=runtime.process_state,
        telemetry_client=telemetry,
        auth_context=runtime.auth,
        device_id=str(entry["device_id"]),
        container_id=entry.get("container_id"),
        metrics={"connected": True, "temperature_c": 21.4},
        units={"temperature_c": "C"},
    )
    return {"status": "queued"}


@router.post("/telemetry/device/{config_id}/example")
async def telemetry_for_device(config_id: str, request: Request):
    entry = get_entry_or_404(config_id)
    sync_runtime_auth_from_fastapi_payload(runtime, request, entry)
    schedule_telemetry_delivery(
        process_state=runtime.process_state,
        telemetry_client=telemetry,
        auth_context=runtime.auth,
        device_id=str(entry["device_id"]),
        container_id=entry.get("container_id"),
        metrics={
            "connected": True,
            "temperature_c": 21.4,
        },
        units={"temperature_c": "C"},
    )
    return {"status": "queued"}
`;
}

function pythonCommandRoutesSource(): string {
  return `from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from piphi_runtime_kit_python import build_event_ingest_response

from ..state import append_runtime_event, commands, registry

router = APIRouter(tags=["commands"])


@router.post("/command")
async def command(payload: dict[str, Any]):
    command_name = str(payload.get("command") or payload.get("capability_id") or "").strip()
    if not command_name:
        raise HTTPException(status_code=400, detail="Missing command")
    if command_name not in commands:
        raise HTTPException(status_code=400, detail=f"Unsupported command: {command_name}")

    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    device_id = str(payload.get("device_id") or target.get("device_id") or "demo-device")
    config_id = str(payload.get("config_id") or target.get("config_id") or device_id)
    requirements = payload.get("capability_requirements")
    requested_capabilities = [
        str(item).strip()
        for item in ([payload.get("capability")] + (requirements if isinstance(requirements, list) else []))
        if str(item or "").strip()
    ]
    unsupported_capability = next(
        (
            capability
            for capability in requested_capabilities
            if capability not in {"device.refresh", f"action.{command_name}"}
        ),
        None,
    )
    if unsupported_capability:
        raise HTTPException(
            status_code=400,
            detail={
                "ok": False,
                "error": "unsupported_capability",
                "message": f"This runtime does not support capability {unsupported_capability}",
            },
        )
    entry = registry.get(config_id) or {
        "device_id": device_id,
        "config_id": config_id,
    }
    event = append_runtime_event(
        "runtime.command.received",
        entry,
        {
            "command": command_name,
            "device_id": device_id,
            "entity_id": payload.get("entity_id"),
            "args": payload.get("params") or payload.get("args") or {},
            "target": target,
        },
    )
    response = build_event_ingest_response(event)
    response_payload = response.model_dump() if hasattr(response, "model_dump") else dict(response)
    return {
        **response_payload,
        "ok": True,
        "command": command_name,
        "contract_version": payload.get("contract_version"),
        "device_id": device_id,
        "config_id": config_id,
        "target": target,
        "params": payload.get("params") or payload.get("args") or {},
    }
`;
}

function goMainSource(): string {
  return `package main

import (
	"log"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	registerHealthRoutes(mux)
	registerDiscoveryRoutes(mux)
	registerConfigRoutes(mux)
	registerRuntimeRoutes(mux)
	registerEntityRoutes(mux)
	registerEventRoutes(mux)
	registerTelemetryRoutes(mux)
	registerCommandRoutes(mux)

	port := runtimePort()
	log.Printf("%s listening on :%s", integrationID, port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`;
}

function goSettingsSource(options: ScaffoldOptions): string {
  return `package main

import (
	"os"
	"strconv"
)

const (
	integrationID      = "${options.slug}"
	integrationName    = "${options.title}"
	integrationVersion = "0.1.0"
	projectKind        = "${options.kind}"
	projectPreset      = "${options.preset}"
	projectDomain      = "${options.domain}"
	defaultPort        = "${options.port}"
)

func runtimePort() string {
	value := os.Getenv("PORT")
	if value == "" {
		return defaultPort
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return defaultPort
	}
	return value
}
`;
}

function goAnyLiteral(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[]any{${value.map((item) => goAnyLiteral(item)).join(", ")}}`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .map(([key, item]) => `${JSON.stringify(key)}: ${goAnyLiteral(item)}`)
      .join(", ");
    return `map[string]any{${entries}}`;
  }
  return "nil";
}

function goContractSource(options: ScaffoldOptions): string {
  const capabilities = goAnyLiteral(capabilitiesFor(options));
  const commands = goAnyLiteral(commandsFor(options));
  const configSchema = goAnyLiteral(configSchemaFor(options));
  const fallbackEntity = goAnyLiteral(entityFor(options));
  return `package main

var endpoints = map[string]string{
	"health":      "/health",
	"diagnostics": "/diagnostics",
	"discover":    "/discover",
	"entities":    "/entities",
	"state":       "/state",
	"config":      "/config",
	"config_sync": "/config/sync",
	"deconfigure": "/deconfigure",
	"ui_config":   "/ui-config",
	"events":      "/events",
	"command":     "/command",
}

var requiredEndpoints = []string{"health", "entities", "command", "config", "ui_config"}

var capabilities = ${capabilities}

var commands = ${commands}

var configSchema = ${configSchema}

var fallbackEntity = ${fallbackEntity}
`;
}

function goStateSource(options: ScaffoldOptions): string {
  return `package main

import runtimekit "github.com/piphi-network/piphi-runtime-kit-go"

type deviceConfig struct {
	runtimekit.RuntimeConfig
	Host                string \`json:"host"\`
	Alias               string \`json:"alias,omitempty"\`
	APIKey              string \`json:"api_key,omitempty"\`
	BaseURL             string \`json:"base_url,omitempty"\`
	PollIntervalSeconds int    \`json:"poll_interval_seconds,omitempty"\`
	ServiceName         string \`json:"service_name,omitempty"\`
}

type deviceEntry struct {
	ConfigID      string         \`json:"config_id"\`
	DeviceID      string         \`json:"device_id"\`
	ContainerID   string         \`json:"container_id,omitempty"\`
	IntegrationID string         \`json:"integration_id,omitempty"\`
	Host          string         \`json:"host"\`
	Alias         string         \`json:"alias,omitempty"\`
	Config        deviceConfig   \`json:"config"\`
	LatestState   map[string]any \`json:"latest_state,omitempty"\`
}

var (
	starter = runtimekit.NewRuntimeStarter[deviceEntry, map[string]any, map[string]any](
		integrationID,
		integrationName,
		integrationVersion,
		"",
		100,
	)
	runtime   = starter.Runtime
	registry  = starter.Registry
	telemetry = starter.Telemetry
)

func buildEntry(config deviceConfig) deviceEntry {
	identity := runtimekit.BuildRuntimeIdentity(config.RuntimeConfig, integrationID)
	return deviceEntry{
		ConfigID:      identity.ConfigID,
		DeviceID:      identity.DeviceID,
		ContainerID:   identity.ContainerID,
		IntegrationID: identity.IntegrationID,
		Host:          config.Host,
		Alias:         config.Alias,
		Config:        config,
		LatestState: map[string]any{
			"connected": true,
			"host":      config.Host,
			"alias":     config.Alias,
		},
	}
}

func applyConfig(config deviceConfig) deviceEntry {
	entry := buildEntry(config)
	registry.Set(config.ID, entry)
	registry.UpdateState(config.ID, entry.LatestState, entry.DeviceID)
	appendRuntimeEvent("runtime.config.applied", entry, map[string]any{
		"host":  config.Host,
		"alias": config.Alias,
	})
	return entry
}

func removeConfig(configID string) (deviceEntry, bool) {
	entry, removed := registry.Remove(configID)
	if removed {
		appendRuntimeEvent("runtime.config.removed", entry, map[string]any{
			"host":  entry.Host,
			"alias": entry.Alias,
		})
	}
	return entry, removed
}

func appendRuntimeEvent(eventType string, entry deviceEntry, payload map[string]any) map[string]any {
	return registry.AppendEvent(runtimekit.BuildLocalEventRecord(map[string]any{
		"event_type":     eventType,
		"source":         integrationID,
		"severity":       "info",
		"device_id":      entry.DeviceID,
		"config_id":      entry.ConfigID,
		"container_id":   entry.ContainerID,
		"integration_id": firstNonEmpty(entry.IntegrationID, integrationID),
		"payload":        payload,
	}))
}
`;
}

function goHTTPSource(): string {
  return `package main

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func methodAllowed(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
	return false
}

func valueOrDefault(value any, fallback string) string {
	if typed, ok := value.(string); ok && typed != "" {
		return typed
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
`;
}

function goHealthRoutesSource(): string {
  return `package main

import "net/http"

func registerHealthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/diagnostics", handleDiagnostics)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, starter.HealthResponse(map[string]any{
		"active_configs": len(registry.IDs()),
	}))
}

func handleDiagnostics(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, starter.DiagnosticsResponse(map[string]any{
		"active_config_ids":  registry.IDs(),
		"recent_event_count": len(registry.RecentEvents()),
		"kind":               projectKind,
		"contract": map[string]any{
			"endpoints": endpoints,
			"required":  requiredEndpoints,
		},
	}))
}
`;
}

function goDiscoveryRoutesSource(): string {
  return `package main

import (
	"encoding/json"
	"net/http"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
)

func registerDiscoveryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/discover", handleDiscover)
	mux.HandleFunc("/ui-config", handleUIConfig)
}

func handleDiscover(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	var payload runtimekit.IntegrationDiscoveryRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	inputs := runtimekit.NormalizeDiscoveryInputs(payload.Inputs)
	writeJSON(w, http.StatusOK, runtimekit.BuildDiscoveryResponse([]map[string]any{
		{
			"id":        "demo-device",
			"device_id": "demo-device",
			"host":      valueOrDefault(inputs["host"], "127.0.0.1"),
			"alias":     "Demo Device",
		},
	}))
}

func handleUIConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, configSchema)
}
`;
}

function goConfigRoutesSource(): string {
  return `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
	"github.com/piphi-network/piphi-runtime-kit-go/adapters"
)

func registerConfigRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/config", handleConfig)
	mux.HandleFunc("/config/sync", handleConfigSync)
	mux.HandleFunc("/deconfigure", handleDeconfigure)
	mux.HandleFunc("/deconfigure/", handleDeconfigure)
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	var payload deviceConfig
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, payload.ContainerID)
	entry := applyConfig(payload)
	writeJSON(w, http.StatusOK, runtimekit.BuildConfigApplyResponse(
		entry.ConfigID,
		payload.ContainerID,
		map[string]any{"host": payload.Host, "alias": payload.Alias},
	))
}

func handleConfigSync(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	var snapshot struct {
		ContainerID string         \`json:"container_id"\`
		Configs     []deviceConfig \`json:"configs"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&snapshot); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, snapshot.ContainerID)
	incoming := map[string]bool{}
	for _, config := range snapshot.Configs {
		incoming[config.ID] = true
		applyConfig(config)
	}
	removed := []string{}
	for _, configID := range registry.IDs() {
		if !incoming[configID] {
			if _, ok := removeConfig(configID); ok {
				removed = append(removed, configID)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":              "synced",
		"active_config_ids":   registry.IDs(),
		"applied_config_ids":  keysOf(incoming),
		"removed_config_ids":  removed,
		"active_config_count": len(registry.IDs()),
	})
}

func handleDeconfigure(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	configID := strings.TrimPrefix(r.URL.Path, "/deconfigure/")
	if configID == r.URL.Path || configID == "" {
		var payload struct {
			ConfigID string \`json:"config_id"\`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		configID = payload.ConfigID
	}
	if configID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "missing config_id"})
		return
	}
	_, removed := removeConfig(configID)
	writeJSON(w, http.StatusOK, runtimekit.BuildConfigRemoveResponse(configID, removed, map[string]any{
		"remaining_configs": registry.IDs(),
	}))
}

func keysOf(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}
`;
}

function goRuntimeRoutesSource(): string {
  return `package main

import "net/http"

func registerRuntimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/state", handleState)
	mux.HandleFunc("/contract", handleContract)
}

func handleState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"summary": map[string]any{
			"active_config_count": len(registry.IDs()),
			"recent_event_count":  len(registry.RecentEvents()),
		},
		"entries":         registry.EntriesSnapshot(),
		"state_snapshots": registry.StateSnapshots(),
	})
}

func handleContract(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"integration_id": integrationID,
		"name":           integrationName,
		"version":        integrationVersion,
		"kind":           projectKind,
		"preset":         projectPreset,
		"domain":         projectDomain,
		"endpoints":      endpoints,
		"required":       requiredEndpoints,
	})
}
`;
}

function goEntityRoutesSource(): string {
  return `package main

import "net/http"

func registerEntityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/entities", handleEntities)
}

func handleEntities(w http.ResponseWriter, _ *http.Request) {
	entities := []map[string]any{}
	for _, entry := range registry.EntriesSnapshot() {
		entities = append(entities, map[string]any{
			"id":           entry.DeviceID,
			"name":         firstNonEmpty(entry.Alias, "Demo Device"),
			"config_id":    entry.ConfigID,
			"device_id":    entry.DeviceID,
			"entity_type":  fallbackEntity["entity_type"],
			"capabilities": fallbackEntity["capabilities"],
			"available_commands": fallbackEntity["available_commands"],
			"dashboard": fallbackEntity["dashboard"],
		})
	}
	if len(entities) == 0 {
		entities = append(entities, fallbackEntity)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entities":     entities,
		"capabilities": capabilities,
		"commands":     commands,
	})
}
`;
}

function goEventRoutesSource(): string {
  return `package main

import (
	"net/http"
	"strings"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
)

func registerEventRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/events", handleEvents)
	mux.HandleFunc("/events/example", handleEventExample)
	mux.HandleFunc("/events/device/", handleEventForDevice)
}

func handleEvents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, runtimekit.BuildEventListResponse(registry.RecentEvents()))
}

func handleEventExample(w http.ResponseWriter, _ *http.Request) {
	entry, ok := registry.PrimaryEntry()
	if !ok {
		entry = deviceEntry{
			DeviceID:      "demo-device",
			ConfigID:      "demo-device",
			ContainerID:   runtime.Auth.ContainerID(),
			IntegrationID: integrationID,
		}
	}
	event := appendRuntimeEvent("runtime.event", entry, map[string]any{
		"message": "Example local runtime event",
	})
	writeJSON(w, http.StatusOK, runtimekit.BuildEventIngestResponse(event))
}

func handleEventForDevice(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	configID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/events/device/"), "/example")
	entry, ok := registry.Get(configID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "reason": "unknown config_id=" + configID})
		return
	}
	event := appendRuntimeEvent("runtime.device.checked", entry, map[string]any{
		"message": "Example local runtime event for a configured device",
		"host":    entry.Host,
	})
	writeJSON(w, http.StatusOK, runtimekit.BuildEventIngestResponse(event))
}
`;
}

function goTelemetryRoutesSource(): string {
  return `package main

import (
	"net/http"
	"strings"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
	"github.com/piphi-network/piphi-runtime-kit-go/adapters"
)

func registerTelemetryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/telemetry/example", handleTelemetryExample)
	mux.HandleFunc("/telemetry/device/", handleTelemetryForDevice)
}

func handleTelemetryExample(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, "")
	entry, ok := registry.PrimaryEntry()
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "no configured devices"})
		return
	}
	queueTelemetry(entry)
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued"})
}

func handleTelemetryForDevice(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, "")
	configID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/telemetry/device/"), "/example")
	entry, ok := registry.Get(configID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "reason": "unknown config_id=" + configID})
		return
	}
	queueTelemetry(entry)
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued"})
}

func queueTelemetry(entry deviceEntry) {
	runtimekit.ScheduleTelemetryDelivery(
		runtime.ProcessState,
		telemetry,
		runtime.Auth,
		runtimekit.TelemetryPayload{
			DeviceID:    entry.DeviceID,
			ContainerID: entry.ContainerID,
			Metrics: map[string]any{
				"connected":     true,
				"temperature_c": 21.4,
			},
			Units: map[string]any{
				"temperature_c": "C",
			},
		},
	)
}
`;
}

function goCommandRoutesSource(): string {
  return `package main

import (
	"encoding/json"
	"net/http"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
)

func registerCommandRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/command", handleCommand)
}

func handleCommand(w http.ResponseWriter, r *http.Request) {
	if !methodAllowed(w, r, http.MethodPost) {
		return
	}
	var payload map[string]any
	_ = json.NewDecoder(r.Body).Decode(&payload)
	commandName := firstNonEmpty(asString(payload["command"]), asString(payload["capability_id"]))
	if commandName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "Missing command"})
		return
	}
	if _, ok := commands[commandName]; !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "Unsupported command: " + commandName})
		return
	}
	target, _ := payload["target"].(map[string]any)
	deviceID := firstNonEmpty(asString(payload["device_id"]), asString(target["device_id"]), "demo-device")
	configID := firstNonEmpty(asString(payload["config_id"]), asString(target["config_id"]), deviceID)
	requestedCapabilities := []string{}
	if capability := asString(payload["capability"]); capability != "" {
		requestedCapabilities = append(requestedCapabilities, capability)
	}
	if requirements, ok := payload["capability_requirements"].([]any); ok {
		for _, item := range requirements {
			if capability := asString(item); capability != "" {
				requestedCapabilities = append(requestedCapabilities, capability)
			}
		}
	}
	for _, capability := range requestedCapabilities {
		if capability != "device.refresh" && capability != "action."+commandName {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":      false,
				"error":   "unsupported_capability",
				"message": "This runtime does not support capability " + capability,
			})
			return
		}
	}
	entry, ok := registry.Get(configID)
	if !ok {
		entry = deviceEntry{
			DeviceID:      deviceID,
			ConfigID:      configID,
			IntegrationID: integrationID,
		}
	}
	event := appendRuntimeEvent("runtime.command.received", entry, map[string]any{
		"command":   commandName,
		"device_id": deviceID,
		"entity_id": payload["entity_id"],
		"args":      valueOrEmptyMap(firstNonNil(payload["params"], payload["args"])),
		"target":    target,
	})
	response := runtimekit.BuildEventIngestResponse(event)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"command":          commandName,
		"contract_version": payload["contract_version"],
		"device_id":        deviceID,
		"config_id":        configID,
		"target":           target,
		"params":           valueOrEmptyMap(firstNonNil(payload["params"], payload["args"])),
		"event":            response,
	})
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func asString(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}

func valueOrEmptyMap(value any) any {
	if value == nil {
		return map[string]any{}
	}
	return value
}
`;
}

function goRuntimeSource(options: ScaffoldOptions): string {
  return `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"

	runtimekit "github.com/piphi-network/piphi-runtime-kit-go"
	"github.com/piphi-network/piphi-runtime-kit-go/adapters"
)

type deviceConfig struct {
	runtimekit.RuntimeConfig
	Host  string \`json:"host"\`
	Alias string \`json:"alias,omitempty"\`
}

type deviceEntry struct {
	ConfigID      string         \`json:"config_id"\`
	DeviceID      string         \`json:"device_id"\`
	ContainerID   string         \`json:"container_id,omitempty"\`
	IntegrationID string         \`json:"integration_id,omitempty"\`
	Host          string         \`json:"host"\`
	Alias         string         \`json:"alias,omitempty"\`
	Config        deviceConfig   \`json:"config"\`
	LatestState   map[string]any \`json:"latest_state,omitempty"\`
}

var (
	starter = runtimekit.NewRuntimeStarter[deviceEntry, map[string]any, map[string]any](
		"${options.slug}",
		"${options.title}",
		"0.1.0",
		"",
		100,
	)
	runtime   = starter.Runtime
	registry  = starter.Registry
	telemetry = starter.Telemetry
)

func main() {
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/diagnostics", handleDiagnostics)
	http.HandleFunc("/discover", handleDiscover)
	http.HandleFunc("/ui-config", handleUIConfig)
	http.HandleFunc("/config", handleConfig)
	http.HandleFunc("/config/sync", handleConfigSync)
	http.HandleFunc("/deconfigure", handleDeconfigure)
	http.HandleFunc("/state", handleState)
	http.HandleFunc("/entities", handleEntities)
	http.HandleFunc("/events", handleEvents)
	http.HandleFunc("/events/example", handleEventExample)
	http.HandleFunc("/telemetry/example", handleTelemetryExample)
	http.HandleFunc("/command", handleCommand)

	port := getenv("PORT", "${options.port}")
	log.Printf("${options.slug} listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, starter.HealthResponse(map[string]any{
		"active_configs": len(registry.IDs()),
	}))
}

func handleDiagnostics(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, starter.DiagnosticsResponse(map[string]any{
		"active_config_ids":  registry.IDs(),
		"recent_event_count": len(registry.RecentEvents()),
		"kind":               "${options.kind}",
	}))
}

func handleDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload runtimekit.IntegrationDiscoveryRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	inputs := runtimekit.NormalizeDiscoveryInputs(payload.Inputs)
	writeJSON(w, http.StatusOK, runtimekit.BuildDiscoveryResponse([]map[string]any{
		{
			"id":        "demo-device",
			"device_id": "demo-device",
			"host":      valueOrDefault(inputs["host"], "127.0.0.1"),
			"alias":     "Demo Device",
		},
	}))
}

func handleUIConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema": map[string]any{
			"title":    "${options.title} Setup",
			"type":     "object",
			"required": []string{"host"},
			"properties": map[string]any{
				"host":  map[string]any{"type": "string", "title": "Host"},
				"alias": map[string]any{"type": "string", "title": "Alias"},
			},
		},
		"uiSchema": map[string]any{
			"host":  map[string]any{"placeholder": "192.168.1.50"},
			"alias": map[string]any{"placeholder": "Office Device"},
		},
	})
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload deviceConfig
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, payload.ContainerID)
	entry := buildEntry(payload)
	registry.Set(payload.ID, entry)
	registry.UpdateState(payload.ID, entry.LatestState, entry.DeviceID)
	appendRuntimeEvent("runtime.config.applied", entry, map[string]any{
		"host":  payload.Host,
		"alias": payload.Alias,
	})
	writeJSON(w, http.StatusOK, runtimekit.BuildConfigApplyResponse(
		entry.ConfigID,
		payload.ContainerID,
		map[string]any{"host": payload.Host, "alias": payload.Alias},
	))
}

func handleConfigSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusNotImplemented, map[string]any{
		"ok":     false,
		"reason": "wire config snapshot reconciliation here once this runtime owns vendor state",
	})
}

func handleDeconfigure(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload struct {
		ConfigID string \`json:"config_id"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	entry, removed := registry.Remove(payload.ConfigID)
	if removed {
		appendRuntimeEvent("runtime.config.removed", entry, map[string]any{
			"host":  entry.Host,
			"alias": entry.Alias,
		})
	}
	writeJSON(w, http.StatusOK, runtimekit.BuildConfigRemoveResponse(payload.ConfigID, removed, map[string]any{
		"remaining_configs": registry.IDs(),
	}))
}

func handleState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"summary": map[string]any{
			"active_config_count": len(registry.IDs()),
			"recent_event_count":  len(registry.RecentEvents()),
		},
		"entries":         registry.EntriesSnapshot(),
		"state_snapshots": registry.StateSnapshots(),
	})
}

func handleEntities(w http.ResponseWriter, _ *http.Request) {
	entities := []map[string]any{}
	for _, entry := range registry.EntriesSnapshot() {
		entities = append(entities, map[string]any{
			"id":           entry.DeviceID,
			"name":         firstNonEmpty(entry.Alias, "Demo Device"),
			"config_id":    entry.ConfigID,
			"device_id":    entry.DeviceID,
			"entity_type":  "sensor",
			"capabilities": []string{"connected", "temperature_c", "refresh"},
		})
	}
	if len(entities) == 0 {
		entities = append(entities, map[string]any{
			"id":           "demo-device",
			"name":         "Demo Device",
			"entity_type":  "sensor",
			"capabilities": []string{"connected", "temperature_c", "refresh"},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entities": entities,
		"capabilities": map[string]any{
			"connected":     map[string]any{"kind": "sensor", "unit": "bool"},
			"temperature_c": map[string]any{"kind": "sensor", "unit": "C"},
			"refresh":       map[string]any{"kind": "action"},
		},
		"commands": map[string]any{
			"refresh": map[string]any{"description": "Refresh the device state.", "timeout_ms": 5000},
		},
	})
}

func handleEvents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, runtimekit.BuildEventListResponse(registry.RecentEvents()))
}

func handleEventExample(w http.ResponseWriter, _ *http.Request) {
	entry, ok := registry.PrimaryEntry()
	if !ok {
		entry = deviceEntry{
			DeviceID:      "demo-device",
			ConfigID:      "demo-device",
			ContainerID:   runtime.Auth.ContainerID(),
			IntegrationID: "${options.slug}",
		}
	}
	event := appendRuntimeEvent("runtime.event", entry, map[string]any{
		"message": "Example local runtime event",
	})
	writeJSON(w, http.StatusOK, runtimekit.BuildEventIngestResponse(event))
}

func handleTelemetryExample(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	adapters.SyncRuntimeAuthFromRequest(runtime, r, "")
	entry, ok := registry.PrimaryEntry()
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "no configured devices"})
		return
	}
	runtimekit.ScheduleTelemetryDelivery(
		runtime.ProcessState,
		telemetry,
		runtime.Auth,
		runtimekit.TelemetryPayload{
			DeviceID:    entry.DeviceID,
			ContainerID: entry.ContainerID,
			Metrics: map[string]any{
				"connected":     true,
				"temperature_c": 21.4,
			},
			Units: map[string]any{
				"temperature_c": "C",
			},
		},
	)
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued"})
}

func handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload map[string]any
	_ = json.NewDecoder(r.Body).Decode(&payload)
	event := appendRuntimeEvent("runtime.command.received", deviceEntry{
		DeviceID:      "demo-device",
		ConfigID:      "demo-device",
		IntegrationID: "${options.slug}",
	}, map[string]any{
		"command": payload["command"],
	})
	writeJSON(w, http.StatusOK, runtimekit.BuildEventIngestResponse(event))
}

func buildEntry(config deviceConfig) deviceEntry {
	identity := runtimekit.BuildRuntimeIdentity(config.RuntimeConfig, "${options.slug}")
	return deviceEntry{
		ConfigID:      identity.ConfigID,
		DeviceID:      identity.DeviceID,
		ContainerID:   identity.ContainerID,
		IntegrationID: identity.IntegrationID,
		Host:          config.Host,
		Alias:         config.Alias,
		Config:        config,
		LatestState: map[string]any{
			"connected": true,
			"host":      config.Host,
			"alias":     config.Alias,
		},
	}
}

func appendRuntimeEvent(eventType string, entry deviceEntry, payload map[string]any) map[string]any {
	return registry.AppendEvent(runtimekit.BuildLocalEventRecord(map[string]any{
		"event_type":     eventType,
		"source":         "${options.slug}",
		"severity":       "info",
		"device_id":      entry.DeviceID,
		"config_id":      entry.ConfigID,
		"container_id":   entry.ContainerID,
		"integration_id": firstNonEmpty(entry.IntegrationID, "${options.slug}"),
		"payload":        payload,
	}))
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func valueOrDefault(value any, fallback string) string {
	if typed, ok := value.(string); ok && typed != "" {
		return typed
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	if key == "PORT" {
		if _, err := strconv.Atoi(value); err != nil {
			return fallback
		}
	}
	return value
}
`;
}

function nodeContractTestSource(): string {
  return `import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";
import { commands } from "../src/contract.js";

test("runtime implements the advertised contract routes", async (t) => {
  const app = createApp();
  t.after?.(() => app.close());

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  const diagnostics = await app.inject({ method: "GET", url: "/diagnostics" });
  assert.equal(diagnostics.statusCode, 200);
  assert.deepEqual(JSON.parse(diagnostics.body).diagnostics.contract.required, [
    "health",
    "entities",
    "command",
    "config",
    "ui_config",
  ]);

  for (const url of ["/ui-config", "/entities", "/state", "/contract", "/events"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
  }

  const missingCommand = await app.inject({
    method: "POST",
    url: "/command",
    payload: { command: "does_not_exist" },
  });
  assert.equal(missingCommand.statusCode, 400);

  assert.ok("refresh" in commands);
});
`;
}

function nodeValidateSource(): string {
  return renderNodeValidateSource();
}

function pythonContractTestSource(options: ScaffoldOptions): string {
  return `from __future__ import annotations

from ${options.snakeName}.contract import COMMANDS, REQUIRED_ENDPOINTS
from ${options.snakeName}.main import app


def test_runtime_implements_contract_routes() -> None:
    routes = {
        route.path
        for route in app.routes
        if hasattr(route, "path")
    }
    for path in [
        "/health",
        "/diagnostics",
        "/discover",
        "/config",
        "/config/sync",
        "/deconfigure",
        "/deconfigure/{config_id}",
        "/ui-config",
        "/entities",
        "/state",
        "/contract",
        "/events",
        "/events/device/{config_id}/example",
        "/telemetry/example",
        "/telemetry/device/{config_id}/example",
        "/command",
    ]:
        assert path in routes

    assert REQUIRED_ENDPOINTS == ["health", "entities", "command", "config", "ui_config"]
    assert "refresh" in COMMANDS
`;
}

function pythonValidateSource(options: ScaffoldOptions): string {
  return renderPythonValidateSource(options);
}

function goContractTestSource(): string {
  return `package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func testMux() *http.ServeMux {
	mux := http.NewServeMux()
	registerHealthRoutes(mux)
	registerDiscoveryRoutes(mux)
	registerConfigRoutes(mux)
	registerRuntimeRoutes(mux)
	registerEntityRoutes(mux)
	registerEventRoutes(mux)
	registerTelemetryRoutes(mux)
	registerCommandRoutes(mux)
	return mux
}

func TestRuntimeImplementsContractRoutes(t *testing.T) {
	mux := testMux()
	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/health"},
		{http.MethodGet, "/diagnostics"},
		{http.MethodGet, "/ui-config"},
		{http.MethodGet, "/entities"},
		{http.MethodGet, "/state"},
		{http.MethodGet, "/contract"},
		{http.MethodGet, "/events"},
	} {
		req := httptest.NewRequest(route.method, route.path, nil)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s %s returned %d", route.method, route.path, res.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/command", nil)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unknown command guard returned %d", res.Code)
	}
}
`;
}

function goValidateSource(): string {
  return renderGoValidateSource();
}

function curlExampleSource(options: ScaffoldOptions): string {
  return renderCurlExample(options);
}

function contractDocSource(options: ScaffoldOptions): string {
  return renderContractDoc(options);
}

function nodeGithubActionsSource(options: ScaffoldOptions): string {
  return renderNodeGithubActions(options, {
    installCommand: nodeInstallCommand(options),
    checkCommand: nodeRunCommand(options, "check"),
    testCommand: nodeRunCommand(options, "test"),
    validateCommand: nodeRunCommand(options, "validate"),
  });
}

function pythonGithubActionsSource(options: ScaffoldOptions): string {
  return renderPythonGithubActions(options);
}

function goGithubActionsSource(): string {
  return renderGoGithubActions();
}

function projectReadme(options: ScaffoldOptions, commands: string[]): string {
  return renderProjectReadme(options, commands);
}

function json(value: unknown): string {
  return renderJson(value);
}

export async function runCreate(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const options = await resolveOptions(parsed);
  const files = parsed.dryRun ? await buildProjectFiles(options) : await writeProject(options, parsed.force);

  console.log(
    `${parsed.dryRun ? "Previewed" : "Created"} ${options.language} ${options.kind} scaffold at ${options.targetDir}`,
  );
  console.log(`${parsed.dryRun ? "Would write" : "Wrote"} ${files.length} files.`);
  console.log(
    `Preset ${options.preset} | domain ${options.domain} | port ${options.port} | scaffold ${SCAFFOLD_VERSION}`,
  );
  if (parsed.printTree || parsed.dryRun) {
    console.log("");
    console.log("Files:");
    printFileTree(files);
  }
  if (parsed.dryRun) {
    return;
  }
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${formatTargetForShell(options.targetDir)}`);
  if (options.language === "node") {
    console.log(`  ${nodeInstallCommand(options)}`);
    console.log(`  ${nodeRunCommand(options, "dev")}`);
  } else if (options.language === "python") {
    for (const command of pythonLocalCommands(options).slice(0, options.pythonManager === "pip" ? 4 : 2)) {
      console.log(`  ${command}`);
    }
  } else {
    console.log("  go get github.com/piphi-network/piphi-runtime-kit-go");
    console.log("  go mod tidy");
    console.log("  go run .");
  }
}

function printFileTree(files: ProjectFile[]): void {
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    console.log(`  ${file.path}`);
  }
}

function formatTargetForShell(targetDir: string): string {
  const relative = path.relative(process.cwd(), targetDir);
  if (!relative || relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return targetDir;
  }
  return relative;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
