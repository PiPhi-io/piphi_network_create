#!/usr/bin/env node

import { Command } from "commander";

import { runCreate } from "./generator.js";
import {
  addCapability,
  addAuth,
  addBinaryBuild,
  addCommand,
  addDiscovery,
  addPoller,
  addReleaseWorkflow,
  addRoute,
  addTelemetry,
  addWebhook,
  doctorProject,
  fixProject,
  hasErrors,
  inspectProject,
  printFindings,
  printInspection,
  publishCheckProject,
  upgradeProject,
  validateProject,
} from "./project-tools.js";
import { validateTemplatePack } from "./template-packs.js";

const VERSION = "0.1.0";
const subcommands = new Set([
  "create",
  "validate",
  "inspect",
  "publish-check",
  "template",
  "doctor",
  "add-command",
  "add-capability",
  "add-route",
  "add-webhook",
  "add-poller",
  "add-auth",
  "add-discovery",
  "add-telemetry",
  "release-workflow",
  "binary-build",
  "upgrade",
]);

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || shouldUseCreateCompatibility(argv)) {
    await runCreate(argv);
    return;
  }

  if (argv[0] === "create") {
    await runCreate(argv.slice(1));
    return;
  }

  const program = new Command();
  program
    .name("piphi-network-create")
    .description("Create, validate, and maintain PiPhi runtime integrations and sidecars.")
    .version(VERSION, "-v, --version", "print the CLI version");

  program
    .command("validate")
    .description("Validate a generated PiPhi runtime project.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .option("--fix", "repair common manifest/schema/Docker drift before validating")
    .action(async (options: { cwd: string; fix?: boolean }) => {
      const fixFindings = options.fix ? await fixProject({ cwd: options.cwd }) : [];
      const findings = await validateProject({ cwd: options.cwd });
      printFindings([
        ...fixFindings,
        ...(findings.length > 0 ? findings : [{ level: "info" as const, message: "Project is valid." }]),
      ]);
      if (hasErrors(findings)) {
        process.exitCode = 1;
      }
    });

  program
    .command("inspect")
    .description("Summarize a generated PiPhi runtime project.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const inspection = await inspectProject({ cwd: options.cwd });
      printInspection(inspection);
      if (hasErrors(inspection.findings)) {
        process.exitCode = 1;
      }
    });

  program
    .command("publish-check")
    .description("Run strict release readiness checks for a generated project.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const findings = await publishCheckProject({ cwd: options.cwd });
      printFindings(findings);
      if (hasErrors(findings)) {
        process.exitCode = 1;
      }
    });

  const template = program
    .command("template")
    .description("Validate and inspect local PiPhi scaffold template packs.");

  template
    .command("validate")
    .description("Validate a local template pack directory.")
    .argument("<path>", "template pack directory")
    .action(async (templatePath: string) => {
      const findings = await validateTemplatePack(templatePath);
      printFindings(findings);
      if (hasErrors(findings)) {
        process.exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description("Run broader health checks on a generated PiPhi runtime project.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const findings = await doctorProject({ cwd: options.cwd });
      printFindings(findings);
      if (hasErrors(findings)) {
        process.exitCode = 1;
      }
    });

  program
    .command("add-command")
    .description("Add an action capability and command entry to manifest.json.")
    .argument("<command-id>", "command id, for example refresh_devices")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .option("--description <text>", "command description")
    .action(async (commandId: string, options: { cwd: string; description?: string }) => {
      await addCommand(commandId, { cwd: options.cwd, description: options.description });
      console.log(`Added command '${commandId}' to manifest.json.`);
    });

  program
    .command("add-capability")
    .description("Add a capability entry to manifest.json.")
    .argument("<capability-id>", "capability id, for example humidity_percent")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .option("--kind <kind>", "capability kind", "sensor")
    .option("--unit <unit>", "capability unit")
    .action(async (capabilityId: string, options: { cwd: string; kind?: string; unit?: string }) => {
      await addCapability(capabilityId, {
        cwd: options.cwd,
        kind: options.kind,
        unit: options.unit,
      });
      console.log(`Added capability '${capabilityId}' to manifest.json.`);
    });

  program
    .command("add-route")
    .description("Add or update an api.endpoints entry in manifest.json.")
    .argument("<endpoint-key>", "endpoint key, for example diagnostics")
    .argument("<endpoint-path>", "endpoint path, for example /diagnostics")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (endpointKey: string, endpointPath: string, options: { cwd: string }) => {
      await addRoute(endpointKey, endpointPath, { cwd: options.cwd });
      console.log(`Added endpoint '${endpointKey}' -> '${endpointPath}' to manifest.json.`);
    });

  program
    .command("add-webhook")
    .description("Add webhook receiver manifest metadata and add-on docs.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      await addWebhook({ cwd: options.cwd });
      console.log("Added webhook receiver add-on metadata.");
    });

  program
    .command("add-poller")
    .description("Add polling loop manifest metadata and add-on docs.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .option("--interval <seconds>", "default poll interval", parseIntegerOption)
    .action(async (options: { cwd: string; interval?: number }) => {
      await addPoller({ cwd: options.cwd, interval: options.interval });
      console.log("Added polling loop add-on metadata.");
    });

  program
    .command("add-auth")
    .description("Add auth-oriented config fields and add-on docs.")
    .argument("<strategy>", "auth strategy, for example api-key or oauth2")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (strategy: string, options: { cwd: string }) => {
      await addAuth(strategy, { cwd: options.cwd });
      console.log(`Added ${strategy} auth add-on metadata.`);
    });

  program
    .command("add-discovery")
    .description("Set discovery strategy metadata.")
    .argument("<strategy>", "discovery strategy, for example mdns, ssdp, ble, or passive")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (strategy: string, options: { cwd: string }) => {
      await addDiscovery(strategy, { cwd: options.cwd });
      console.log(`Set discovery strategy to '${strategy}'.`);
    });

  program
    .command("add-telemetry")
    .description("Add one or more telemetry sensor capabilities.")
    .argument("<metric-ids...>", "metric ids, for example temperature_c humidity_percent battery_percent")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (metricIds: string[], options: { cwd: string }) => {
      await addTelemetry(metricIds, { cwd: options.cwd });
      console.log(`Added telemetry metrics: ${metricIds.join(", ")}.`);
    });

  program
    .command("release-workflow")
    .description("Add a publish-oriented GitHub Actions release workflow and release guide.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      await addReleaseWorkflow({ cwd: options.cwd });
      console.log("Added release workflow and release guide.");
    });

  program
    .command("binary-build")
    .description("Add native executable build scripts and workflow when supported.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      await addBinaryBuild({ cwd: options.cwd });
      console.log("Added native executable build scripts and workflow.");
    });

  program
    .command("upgrade")
    .description("Apply scaffold metadata/schema migrations.")
    .option("-C, --cwd <path>", "project directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const findings = await upgradeProject({ cwd: options.cwd });
      printFindings(findings);
    });

  await program.parseAsync(argv, { from: "user" });
}

function parseIntegerOption(value: string): number {
  const next = Number(value);
  if (!Number.isInteger(next) || next < 1) {
    throw new Error(`Expected a positive integer, received "${value}".`);
  }
  return next;
}

function shouldUseCreateCompatibility(argv: string[]): boolean {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "--version" || first === "-v") {
    return false;
  }
  return !subcommands.has(first);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
