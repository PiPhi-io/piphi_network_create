import type { TemplateScaffoldOptions } from "./types.js";

export function renderContractFixtures(): string {
  return `${JSON.stringify(
    {
      version: "1.0",
      cases: [
        {
          id: "health",
          method: "GET",
          path: "/health",
          status: 200,
          required_any_keys: [["ok", "status"]],
        },
        {
          id: "ui_config",
          method: "GET",
          path: "/ui-config",
          status: 200,
          required_keys: ["schema", "uiSchema"],
        },
        {
          id: "contract",
          method: "GET",
          path: "/contract",
          status: 200,
          required_keys: ["integration_id", "name", "version", "kind", "preset", "domain", "endpoints", "required"],
        },
        {
          id: "config",
          method: "POST",
          path: "/config",
          status: 200,
          body: {
            id: "demo-device",
            host: "127.0.0.1",
            alias: "Demo Device",
          },
          required_any_keys: [["config_id", "configId"], ["status", "ok"]],
        },
        {
          id: "entities",
          method: "GET",
          path: "/entities",
          status: 200,
          required_keys: ["entities", "capabilities", "commands"],
        },
        {
          id: "command",
          method: "POST",
          path: "/command",
          status: 200,
          body: {
            contract_version: "automation.runtime.command.v1",
            command: "refresh",
            target: {
              device_id: "demo-device",
              config_id: "demo-device",
            },
            params: {},
            capability: "device.refresh",
            capability_requirements: ["device.refresh"],
          },
          required_any_keys: [["ok", "status"], ["command", "event"]],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function renderNodeConformanceTest(): string {
  return `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createApp } from "../src/app.js";

type FixtureCase = {
  id: string;
  method: "GET" | "POST";
  path: string;
  status: number;
  body?: Record<string, unknown>;
  required_keys?: string[];
  required_any_keys?: string[][];
};

const fixtures = JSON.parse(fs.readFileSync("tests/fixtures/contract-conformance.json", "utf8")) as {
  cases: FixtureCase[];
};

test("runtime conforms to shared PiPhi contract fixtures", async (t) => {
  const app = createApp();
  t.after?.(() => app.close());

  for (const fixture of fixtures.cases) {
    const response = await app.inject({
      method: fixture.method,
      url: fixture.path,
      payload: fixture.body,
    });
    assert.equal(response.statusCode, fixture.status, fixture.id);
    const body = JSON.parse(response.body);
    assertRequiredKeys(body, fixture.required_keys ?? [], fixture.id);
    assertRequiredAnyKeys(body, fixture.required_any_keys ?? [], fixture.id);
  }
});

function assertRequiredKeys(body: Record<string, unknown>, keys: string[], fixtureId: string): void {
  for (const key of keys) {
    assert.ok(key in body, \`\${fixtureId} missing \${key}\`);
  }
}

function assertRequiredAnyKeys(body: Record<string, unknown>, groups: string[][], fixtureId: string): void {
  for (const group of groups) {
    assert.ok(group.some((key) => key in body), \`\${fixtureId} missing one of \${group.join(", ")}\`);
  }
}
`;
}

export function renderPythonConformanceTest(options: TemplateScaffoldOptions): string {
  return `from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from ${options.snakeName}.main import app


FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "contract-conformance.json").read_text())


@pytest.mark.anyio
async def test_runtime_conforms_to_shared_contract_fixtures() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        for fixture in FIXTURES["cases"]:
            response = await client.request(
                fixture["method"],
                fixture["path"],
                json=fixture.get("body"),
            )
            assert response.status_code == fixture["status"], fixture["id"]
            body = response.json()
            _assert_required_keys(body, fixture.get("required_keys", []), fixture["id"])
            _assert_required_any_keys(body, fixture.get("required_any_keys", []), fixture["id"])


def _assert_required_keys(body: dict[str, Any], keys: list[str], fixture_id: str) -> None:
    for key in keys:
        assert key in body, f"{fixture_id} missing {key}"


def _assert_required_any_keys(body: dict[str, Any], groups: list[list[str]], fixture_id: str) -> None:
    for group in groups:
        assert any(key in body for key in group), f"{fixture_id} missing one of {', '.join(group)}"
`;
}

export function renderGoConformanceTest(): string {
  return `package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type contractFixtureSet struct {
	Cases []contractFixtureCase \`json:"cases"\`
}

type contractFixtureCase struct {
	ID              string           \`json:"id"\`
	Method          string           \`json:"method"\`
	Path            string           \`json:"path"\`
	Status          int              \`json:"status"\`
	Body            map[string]any   \`json:"body"\`
	RequiredKeys    []string         \`json:"required_keys"\`
	RequiredAnyKeys [][]string       \`json:"required_any_keys"\`
}

func TestRuntimeConformsToSharedContractFixtures(t *testing.T) {
	raw, err := os.ReadFile("tests/fixtures/contract-conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures contractFixtureSet
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	mux := testMux()
	for _, fixture := range fixtures.Cases {
		var body *bytes.Reader
		if fixture.Body != nil {
			rawBody, err := json.Marshal(fixture.Body)
			if err != nil {
				t.Fatal(err)
			}
			body = bytes.NewReader(rawBody)
		} else {
			body = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(fixture.Method, fixture.Path, body)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != fixture.Status {
			t.Fatalf("%s returned %d", fixture.ID, res.Code)
		}
		var responseBody map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &responseBody); err != nil {
			t.Fatalf("%s returned invalid JSON: %v", fixture.ID, err)
		}
		assertRequiredKeys(t, fixture.ID, responseBody, fixture.RequiredKeys)
		assertRequiredAnyKeys(t, fixture.ID, responseBody, fixture.RequiredAnyKeys)
	}
}

func assertRequiredKeys(t *testing.T, fixtureID string, body map[string]any, keys []string) {
	t.Helper()
	for _, key := range keys {
		if _, ok := body[key]; !ok {
			t.Fatalf("%s missing %s", fixtureID, key)
		}
	}
}

func assertRequiredAnyKeys(t *testing.T, fixtureID string, body map[string]any, groups [][]string) {
	t.Helper()
	for _, group := range groups {
		found := false
		for _, key := range group {
			if _, ok := body[key]; ok {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s missing one of %s", fixtureID, strings.Join(group, ", "))
		}
	}
}
`;
}
