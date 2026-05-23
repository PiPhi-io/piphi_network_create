import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

export type TemplatePackVariable = {
  name: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
};

export type TemplatePackFile = {
  path: string;
  template?: string;
  content?: string;
  languages?: string[];
};

export type TemplatePack = {
  name: string;
  description?: string;
  languages?: string[];
  kind?: string;
  preset?: string;
  domain?: string;
  variables?: TemplatePackVariable[];
  files: TemplatePackFile[];
  directory: string;
};

export type TemplatePackFinding = {
  level: "error" | "warning" | "info";
  message: string;
};

export type TemplateRenderContext = Record<string, unknown>;

export type RenderedTemplateFile = {
  path: string;
  contents: string;
};

const supportedLanguages = new Set(["node", "python", "go"]);
const supportedKinds = new Set(["integration", "sidecar"]);
const supportedPresets = new Set([
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
]);
const supportedDomains = new Set(["sensor", "actuator", "bridge", "cloud-api", "local-device", "sidecar-service"]);

export async function loadTemplatePack(templatePath: string, cwd = process.cwd()): Promise<TemplatePack> {
  const directory = path.resolve(cwd, templatePath);
  const manifestPath = path.join(directory, "template.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Template pack is missing template.json: ${directory}`);
  }
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
  const pack = normalizeTemplatePack(raw, directory);
  const findings = await validateTemplatePackDirectory(pack);
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    throw new Error(`Template pack is invalid:\n${errors.map((finding) => `- ${finding.message}`).join("\n")}`);
  }
  return pack;
}

export async function validateTemplatePack(templatePath: string, cwd = process.cwd()): Promise<TemplatePackFinding[]> {
  const directory = path.resolve(cwd, templatePath);
  const manifestPath = path.join(directory, "template.json");
  if (!existsSync(manifestPath)) {
    return [{ level: "error", message: `template.json is missing in ${directory}` }];
  }
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
    return validateTemplatePackDirectory(normalizeTemplatePack(raw, directory));
  } catch (error) {
    return [
      {
        level: "error",
        message: `template.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

export function templatePackDefaults(pack: TemplatePack | undefined): {
  language?: "node" | "python" | "go";
  kind?: "integration" | "sidecar";
  preset?: string;
  domain?: string;
} {
  if (!pack) {
    return {};
  }
  const firstLanguage = pack.languages?.find((language) => supportedLanguages.has(language));
  return {
    language: firstLanguage as "node" | "python" | "go" | undefined,
    kind: pack.kind === "sidecar" ? "sidecar" : pack.kind === "integration" ? "integration" : undefined,
    preset: pack.preset,
    domain: pack.domain,
  };
}

export function templateVariableValues(
  pack: TemplatePack | undefined,
  rawValues: Record<string, string> = {},
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const variable of pack?.variables ?? []) {
    if (variable.default !== undefined) {
      values[variable.name] = variable.default;
    }
  }
  return { ...values, ...rawValues };
}

export async function renderTemplatePackFiles(
  pack: TemplatePack,
  context: TemplateRenderContext,
): Promise<RenderedTemplateFile[]> {
  const language = String(context.language ?? "");
  const files: RenderedTemplateFile[] = [];
  for (const file of pack.files) {
    if (file.languages && !file.languages.includes(language)) {
      continue;
    }
    const source = file.content !== undefined
      ? file.content
      : await readFile(path.join(pack.directory, file.template ?? ""), "utf8");
    files.push({
      path: renderTemplateString(file.path, context),
      contents: renderTemplateString(source, context),
    });
  }
  return files;
}

async function validateTemplatePackDirectory(pack: TemplatePack): Promise<TemplatePackFinding[]> {
  const findings: TemplatePackFinding[] = [];
  if (!pack.name) {
    findings.push({ level: "error", message: "template.json must include a non-empty name." });
  }
  if (!Array.isArray(pack.files) || pack.files.length === 0) {
    findings.push({ level: "error", message: "template.json must include at least one file entry." });
  }
  for (const language of pack.languages ?? []) {
    if (!supportedLanguages.has(language)) {
      findings.push({ level: "error", message: `Unsupported template language '${language}'.` });
    }
  }
  if (pack.kind && !supportedKinds.has(pack.kind)) {
    findings.push({ level: "error", message: `Unsupported template kind '${pack.kind}'.` });
  }
  if (pack.preset && !supportedPresets.has(pack.preset)) {
    findings.push({ level: "error", message: `Unsupported template preset '${pack.preset}'.` });
  }
  if (pack.domain && !supportedDomains.has(pack.domain)) {
    findings.push({ level: "error", message: `Unsupported template domain '${pack.domain}'.` });
  }
  for (const variable of pack.variables ?? []) {
    if (!variable.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) {
      findings.push({ level: "error", message: `Invalid template variable name '${variable.name}'.` });
    }
  }
  for (const file of pack.files ?? []) {
    if (!isSafeRelativePath(file.path)) {
      findings.push({ level: "error", message: `Unsafe template output path '${file.path}'.` });
    }
    if (file.content === undefined && !file.template) {
      findings.push({ level: "error", message: `Template file '${file.path}' must define content or template.` });
    }
    if (file.content !== undefined && file.template) {
      findings.push({ level: "error", message: `Template file '${file.path}' cannot define both content and template.` });
    }
    if (file.template) {
      if (!isSafeRelativePath(file.template)) {
        findings.push({ level: "error", message: `Unsafe template source path '${file.template}'.` });
      } else if (!existsSync(path.join(pack.directory, file.template))) {
        findings.push({ level: "error", message: `Template source '${file.template}' is missing.` });
      }
    }
    for (const language of file.languages ?? []) {
      if (!supportedLanguages.has(language)) {
        findings.push({ level: "error", message: `Unsupported language '${language}' in file '${file.path}'.` });
      }
    }
  }
  if (findings.length === 0) {
    findings.push({ level: "info", message: `Template pack '${pack.name}' is valid.` });
  }
  return findings;
}

function normalizeTemplatePack(raw: JsonObject, directory: string): TemplatePack {
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : undefined,
    languages: stringArray(raw.languages),
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    preset: typeof raw.preset === "string" ? raw.preset : undefined,
    domain: typeof raw.domain === "string" ? raw.domain : undefined,
    variables: Array.isArray(raw.variables)
      ? raw.variables.map((value) => normalizeVariable(asObject(value)))
      : [],
    files: Array.isArray(raw.files)
      ? raw.files.map((value) => normalizeFile(asObject(value)))
      : [],
    directory,
  };
}

function normalizeVariable(value: JsonObject): TemplatePackVariable {
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : undefined,
    default: isPrimitive(value.default) ? value.default : undefined,
    required: value.required === true,
  };
}

function normalizeFile(value: JsonObject): TemplatePackFile {
  return {
    path: typeof value.path === "string" ? value.path : "",
    template: typeof value.template === "string" ? value.template : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    languages: stringArray(value.languages),
  };
}

function renderTemplateString(value: string, context: TemplateRenderContext): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const resolved = resolveKey(context, key);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

function resolveKey(context: TemplateRenderContext, key: string): unknown {
  return key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, context);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]+/).some((part) => part === "..");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
