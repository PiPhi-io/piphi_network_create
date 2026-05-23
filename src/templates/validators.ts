import type { TemplateScaffoldOptions } from "./types.js";

export function renderNodeValidateSource(): string {
  return `import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const behaviorPath = fs.existsSync("src/behaviors.json") ? "src/behaviors.json" : "behaviors.json";
const behavior = fs.existsSync(behaviorPath) ? JSON.parse(fs.readFileSync(behaviorPath, "utf8")) : null;
const dockerfile = fs.existsSync("Dockerfile") ? fs.readFileSync("Dockerfile", "utf8") : "";
const required = ["health", "entities", "command", "config", "ui_config"];
const endpoints = manifest.api?.endpoints ?? {};
const errors = [];
const riskLevels = new Set(["low", "medium", "high", "critical"]);
const automationSchemaVersions = new Set(["automation.behavior.v1", "automation.behavior.v2"]);

if (manifest.$schema !== "./schema/piphi-manifest.schema.json") {
  errors.push("manifest must reference ./schema/piphi-manifest.schema.json");
}
if (!fs.existsSync("schema/piphi-manifest.schema.json")) {
  errors.push("schema/piphi-manifest.schema.json is missing");
}

for (const key of required) {
  if (!manifest.api?.required?.includes(key)) {
    errors.push(\`api.required is missing \${key}\`);
  }
  if (typeof endpoints[key] !== "string" || !endpoints[key].startsWith("/")) {
    errors.push(\`api.endpoints.\${key} must be an absolute path\`);
  }
}

const port = manifest.runtime?.linux?.container?.ports?.[0]?.container;
if (!Number.isInteger(port)) {
  errors.push("runtime.linux.container.ports[0].container must be an integer");
} else if (dockerfile && !dockerfile.includes(\`EXPOSE \${port}\`)) {
  errors.push(\`Dockerfile must expose manifest port \${port}\`);
}

for (const [capabilityId, capability] of Object.entries(manifest.capabilities ?? {})) {
  if (capability?.kind === "action" && !manifest.commands?.[capabilityId]) {
    errors.push(\`action capability \${capabilityId} must map to a command\`);
  }
}

if (!behavior) {
  errors.push("behaviors.json is missing");
} else {
  if (behavior.behaviorSchemaVersion !== "integration.behaviors.v2") {
    errors.push("behaviors.json must use behaviorSchemaVersion integration.behaviors.v2");
  }
  const deviceIds = new Set();
  for (const [deviceIndex, device] of (behavior.devices ?? []).entries()) {
    if (deviceIds.has(device.id)) {
      errors.push(\`behaviors.devices[\${deviceIndex}].id duplicates another device id\`);
    }
    deviceIds.add(device.id);
    const actionIds = new Set();
    for (const [actionIndex, action] of (device.actions ?? []).entries()) {
      if (actionIds.has(action.id)) {
        errors.push(\`behaviors.devices[\${deviceIndex}].actions[\${actionIndex}].id duplicates another action id\`);
      }
      actionIds.add(action.id);
      if (typeof action.runtime?.command !== "string" || action.runtime.command.trim() === "") {
        errors.push(\`behaviors.devices[\${deviceIndex}].actions[\${actionIndex}].runtime.command is required\`);
      }
      const riskLevel = action.safety?.riskLevel ?? action.riskLevel ?? action.runtime?.riskLevel;
      if (typeof riskLevel !== "string" || !riskLevels.has(riskLevel)) {
        errors.push(\`behaviors.devices[\${deviceIndex}].actions[\${actionIndex}].safety.riskLevel must be low, medium, high, or critical\`);
      }
    }
  }
  if ((behavior.devices ?? []).length === 0 && (behavior.templates ?? []).length === 0) {
    errors.push("behaviors.json must define at least one device or template");
  }
  for (const [templateIndex, template] of (behavior.templates ?? []).entries()) {
    if (template.deviceKey && !deviceIds.has(template.deviceKey)) {
      errors.push(\`behaviors.templates[\${templateIndex}].deviceKey must reference a defined device\`);
    }
    const automationSchemaVersion = template.config?.automation_schema_version;
    if (automationSchemaVersion && !automationSchemaVersions.has(automationSchemaVersion)) {
      errors.push(\`behaviors.templates[\${templateIndex}].config.automation_schema_version is unsupported\`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\\n"));
  process.exit(1);
}

console.log("PiPhi scaffold validation passed.");
`;
}

export function renderPythonValidateSource(options: TemplateScaffoldOptions): string {
  return `from __future__ import annotations

import json
from pathlib import Path

from ${options.snakeName}.contract import COMMANDS, ENDPOINTS, REQUIRED_ENDPOINTS

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "manifest.json").read_text())
behavior_path = ROOT / "src" / "behaviors.json"
if not behavior_path.exists():
    behavior_path = ROOT / "behaviors.json"
behavior = json.loads(behavior_path.read_text()) if behavior_path.exists() else None
dockerfile = (ROOT / "Dockerfile").read_text() if (ROOT / "Dockerfile").exists() else ""
errors: list[str] = []
risk_levels = {"low", "medium", "high", "critical"}
automation_schema_versions = {"automation.behavior.v1", "automation.behavior.v2"}

if manifest.get("$schema") != "./schema/piphi-manifest.schema.json":
    errors.append("manifest must reference ./schema/piphi-manifest.schema.json")
if not (ROOT / "schema" / "piphi-manifest.schema.json").exists():
    errors.append("schema/piphi-manifest.schema.json is missing")

for key in REQUIRED_ENDPOINTS:
    if key not in manifest.get("api", {}).get("required", []):
        errors.append(f"api.required is missing {key}")
    endpoint = manifest.get("api", {}).get("endpoints", {}).get(key)
    if not isinstance(endpoint, str) or not endpoint.startswith("/"):
        errors.append(f"api.endpoints.{key} must be an absolute path")
    if ENDPOINTS.get(key) != endpoint:
        errors.append(f"contract endpoint {key} does not match manifest")

port = manifest.get("runtime", {}).get("linux", {}).get("container", {}).get("ports", [{}])[0].get("container")
if not isinstance(port, int):
    errors.append("runtime.linux.container.ports[0].container must be an integer")
elif dockerfile and f"EXPOSE {port}" not in dockerfile:
    errors.append(f"Dockerfile must expose manifest port {port}")

for capability_id, capability in manifest.get("capabilities", {}).items():
    if capability.get("kind") == "action" and capability_id not in COMMANDS:
        errors.append(f"action capability {capability_id} must map to a command")

if behavior is None:
    errors.append("behaviors.json is missing")
else:
    if behavior.get("behaviorSchemaVersion") != "integration.behaviors.v2":
        errors.append("behaviors.json must use behaviorSchemaVersion integration.behaviors.v2")
    device_ids: set[str] = set()
    for device_index, device in enumerate(behavior.get("devices") or []):
        device_id = str(device.get("id") or "").strip()
        if device_id in device_ids:
            errors.append(f"behaviors.devices[{device_index}].id duplicates another device id")
        if device_id:
            device_ids.add(device_id)
        action_ids: set[str] = set()
        for action_index, action in enumerate(device.get("actions") or []):
            action_id = str(action.get("id") or "").strip()
            if action_id in action_ids:
                errors.append(f"behaviors.devices[{device_index}].actions[{action_index}].id duplicates another action id")
            if action_id:
                action_ids.add(action_id)
            runtime = action.get("runtime") if isinstance(action.get("runtime"), dict) else {}
            safety = action.get("safety") if isinstance(action.get("safety"), dict) else {}
            command = str(runtime.get("command") or "").strip()
            risk_level = str(safety.get("riskLevel") or action.get("riskLevel") or runtime.get("riskLevel") or "").strip()
            if not command:
                errors.append(f"behaviors.devices[{device_index}].actions[{action_index}].runtime.command is required")
            if risk_level not in risk_levels:
                errors.append(f"behaviors.devices[{device_index}].actions[{action_index}].safety.riskLevel must be low, medium, high, or critical")
    if not behavior.get("devices") and not behavior.get("templates"):
        errors.append("behaviors.json must define at least one device or template")
    for template_index, template in enumerate(behavior.get("templates") or []):
        device_key = str(template.get("deviceKey") or template.get("device_key") or "").strip()
        if device_key and device_ids and device_key not in device_ids:
            errors.append(f"behaviors.templates[{template_index}].deviceKey must reference a defined device")
        config = template.get("config") if isinstance(template.get("config"), dict) else {}
        automation_schema_version = str(config.get("automation_schema_version") or "").strip()
        if automation_schema_version and automation_schema_version not in automation_schema_versions:
            errors.append(f"behaviors.templates[{template_index}].config.automation_schema_version is unsupported")

if errors:
    raise SystemExit("\\n".join(errors))

print("PiPhi scaffold validation passed.")
`;
}

export function renderGoValidateSource(): string {
  return `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func main() {
	raw, err := os.ReadFile("manifest.json")
	if err != nil {
		panic(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		panic(err)
	}
	behaviorPath := "src/behaviors.json"
	if _, err := os.Stat(behaviorPath); err != nil {
		behaviorPath = "behaviors.json"
	}
	behaviorRaw, err := os.ReadFile(behaviorPath)
	if err != nil {
		behaviorRaw = nil
	}
	var behavior map[string]any
	if behaviorRaw != nil {
		if err := json.Unmarshal(behaviorRaw, &behavior); err != nil {
			panic(err)
		}
	}
	errors := []string{}
	if manifest["$schema"] != "./schema/piphi-manifest.schema.json" {
		errors = append(errors, "manifest must reference ./schema/piphi-manifest.schema.json")
	}
	if _, err := os.Stat("schema/piphi-manifest.schema.json"); err != nil {
		errors = append(errors, "schema/piphi-manifest.schema.json is missing")
	}
	api, _ := manifest["api"].(map[string]any)
	endpoints, _ := api["endpoints"].(map[string]any)
	requiredValues, _ := api["required"].([]any)
	required := map[string]bool{}
	for _, value := range requiredValues {
		required[fmt.Sprint(value)] = true
	}
	for _, key := range []string{"health", "entities", "command", "config", "ui_config"} {
		if !required[key] {
			errors = append(errors, "api.required is missing "+key)
		}
		if endpoint, ok := endpoints[key].(string); !ok || !strings.HasPrefix(endpoint, "/") {
			errors = append(errors, "api.endpoints."+key+" must be an absolute path")
		}
	}
	capabilities, _ := manifest["capabilities"].(map[string]any)
	commands, _ := manifest["commands"].(map[string]any)
	for capabilityID, rawCapability := range capabilities {
		capability, _ := rawCapability.(map[string]any)
		if capability["kind"] == "action" {
			if _, ok := commands[capabilityID]; !ok {
			errors = append(errors, "action capability "+capabilityID+" must map to a command")
		}
	}
	if behavior == nil {
		errors = append(errors, "behaviors.json is missing")
	} else {
		if behavior["behaviorSchemaVersion"] != "integration.behaviors.v2" {
			errors = append(errors, "behaviors.json must use behaviorSchemaVersion integration.behaviors.v2")
		}
		devices, _ := behavior["devices"].([]any)
		templates, _ := behavior["templates"].([]any)
		deviceIDs := map[string]bool{}
		for deviceIndex, rawDevice := range devices {
			device, _ := rawDevice.(map[string]any)
			deviceID := fmt.Sprint(device["id"])
			if deviceIDs[deviceID] {
				errors = append(errors, fmt.Sprintf("behaviors.devices[%d].id duplicates another device id", deviceIndex))
			}
			if strings.TrimSpace(deviceID) != "" {
				deviceIDs[deviceID] = true
			}
			actions, _ := device["actions"].([]any)
			actionIDs := map[string]bool{}
			for actionIndex, rawAction := range actions {
				action, _ := rawAction.(map[string]any)
				actionID := fmt.Sprint(action["id"])
				if actionIDs[actionID] {
					errors = append(errors, fmt.Sprintf("behaviors.devices[%d].actions[%d].id duplicates another action id", deviceIndex, actionIndex))
				}
				if strings.TrimSpace(actionID) != "" {
					actionIDs[actionID] = true
				}
				runtime, _ := action["runtime"].(map[string]any)
				safety, _ := action["safety"].(map[string]any)
				if strings.TrimSpace(fmt.Sprint(runtime["command"])) == "" {
					errors = append(errors, fmt.Sprintf("behaviors.devices[%d].actions[%d].runtime.command is required", deviceIndex, actionIndex))
				}
				riskLevel := strings.TrimSpace(fmt.Sprint(safety["riskLevel"]))
				if riskLevel == "" {
					riskLevel = strings.TrimSpace(fmt.Sprint(action["riskLevel"]))
				}
				if riskLevel == "" {
					riskLevel = strings.TrimSpace(fmt.Sprint(runtime["riskLevel"]))
				}
				if riskLevel != "low" && riskLevel != "medium" && riskLevel != "high" && riskLevel != "critical" {
					errors = append(errors, fmt.Sprintf("behaviors.devices[%d].actions[%d].safety.riskLevel must be low, medium, high, or critical", deviceIndex, actionIndex))
				}
			}
		}
		if len(devices) == 0 && len(templates) == 0 {
			errors = append(errors, "behaviors.json must define at least one device or template")
		}
		for templateIndex, rawTemplate := range templates {
			template, _ := rawTemplate.(map[string]any)
			deviceKey := strings.TrimSpace(fmt.Sprint(template["deviceKey"]))
			if deviceKey != "" && len(deviceIDs) > 0 && !deviceIDs[deviceKey] {
				errors = append(errors, fmt.Sprintf("behaviors.templates[%d].deviceKey must reference a defined device", templateIndex))
			}
		}
	}
	}
	if len(errors) > 0 {
		panic(strings.Join(errors, "\\n"))
	}
	fmt.Println("PiPhi scaffold validation passed.")
}
`;
}
