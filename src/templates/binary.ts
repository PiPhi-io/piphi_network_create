import type { TemplateScaffoldOptions } from "./types.js";

export function renderNodeBinaryBuildScript(options: TemplateScaffoldOptions): string {
  return `import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { arch, platform } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const baseName = "${options.slug}";
const buildDir = path.join(root, "build", "binary");
const distDir = path.join(root, "dist", "binary");

await mkdir(buildDir, { recursive: true });
await mkdir(distDir, { recursive: true });

const bundledEntry = path.join(buildDir, "entry.cjs");
const seaBlob = path.join(buildDir, "sea-prep.blob");
const seaConfig = path.join(buildDir, "sea-config.json");
const binaryPath = path.join(distDir, defaultBinaryName());

run(process.execPath, [
  path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
  "src/index.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  \`--outfile=\${bundledEntry}\`,
]);

await writeFile(
  seaConfig,
  JSON.stringify(
    {
      main: bundledEntry,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

run(process.execPath, ["--experimental-sea-config", seaConfig]);
await copyFile(process.execPath, binaryPath);

if (platform() === "darwin") {
  runIfAvailable("codesign", ["--remove-signature", binaryPath]);
}

const postjectArgs = [
  binaryPath,
  "NODE_SEA_BLOB",
  seaBlob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (platform() === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(process.execPath, [path.join(root, "node_modules", "postject", "dist", "cli.js"), ...postjectArgs]);

if (platform() === "darwin") {
  runIfAvailable("codesign", ["--sign", "-", binaryPath]);
}
if (platform() !== "win32") {
  await chmod(binaryPath, 0o755);
}

console.log(\`Built \${binaryPath}\`);

function defaultBinaryName() {
  const system = platform() === "win32" ? "windows" : platform();
  const machine = normalizeMachine(arch());
  const suffix = platform() === "win32" ? ".exe" : ".bin";
  return \`\${baseName}-\${system}-\${machine}\${suffix}\`;
}

function normalizeMachine(machine) {
  if (machine === "x64") {
    return "x86_64";
  }
  if (machine === "arm64") {
    return "arm64";
  }
  return machine || "unknown";
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(\`\${command} \${args.join(" ")} failed with exit code \${result.status}\`);
  }
}

function runIfAvailable(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    return;
  }
  if (result.status !== 0) {
    throw new Error(\`\${command} \${args.join(" ")} failed with exit code \${result.status}\`);
  }
}
`;
}

export function renderNodeBinaryGithubActions(options: TemplateScaffoldOptions): string {
  return `name: Build Binary

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build-binary:
    name: \${{ matrix.os }}
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
          - windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: ${nodeInstallCommand(options)}
      - run: ${nodeRunCommand(options, "check")}
      - run: ${nodeTestCommand(options)}
      - run: ${nodeRunCommand(options, "validate")}
      - run: ${nodeRunCommand(options, "build:binary")}
      - uses: actions/upload-artifact@v4
        with:
          name: ${options.slug}-\${{ runner.os }}-\${{ runner.arch }}
          path: dist/binary/*
          if-no-files-found: error
`;
}

export function renderGoBinaryBuildScript(options: TemplateScaffoldOptions): string {
  return `from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_NAME = "${options.slug}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a native executable with go build.")
    parser.add_argument("--clean", action="store_true", help="remove binary build output before building")
    parser.add_argument("--name", default=default_binary_name(), help="output executable name")
    args = parser.parse_args()

    dist_dir = ROOT / "dist" / "binary"
    if args.clean:
        shutil.rmtree(dist_dir, ignore_errors=True)
    dist_dir.mkdir(parents=True, exist_ok=True)

    output = dist_dir / args.name
    subprocess.run(["go", "build", "-trimpath", "-o", str(output), "."], cwd=ROOT, check=True)
    print(f"Built {output}")


def default_binary_name() -> str:
    system = platform.system().lower() or "unknown"
    machine = normalize_machine(platform.machine())
    suffix = ".exe" if system == "windows" else ".bin"
    return f"{BASE_NAME}-{system}-{machine}{suffix}"


def normalize_machine(machine: str) -> str:
    normalized = machine.lower().replace("amd64", "x86_64")
    if normalized in {"arm64", "aarch64"}:
        return "arm64"
    return normalized or "unknown"


if __name__ == "__main__":
    main()
`;
}

export function renderGoBinaryGithubActions(options: TemplateScaffoldOptions): string {
  return `name: Build Binary

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build-binary:
    name: \${{ matrix.os }}
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
          - windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.25"
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: go mod tidy
      - run: go test ./...
      - run: go run ./cmd/validate
      - run: python scripts/build_binary.py --clean
      - uses: actions/upload-artifact@v4
        with:
          name: ${options.slug}-\${{ runner.os }}-\${{ runner.arch }}
          path: dist/binary/*
          if-no-files-found: error
`;
}

export function renderPythonBinaryEntry(options: TemplateScaffoldOptions): string {
  return `from __future__ import annotations

from ${options.snakeName}.main import main


if __name__ == "__main__":
    main()
`;
}

export function renderPythonBinaryBuildScript(options: TemplateScaffoldOptions): string {
  return `from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "scripts" / "binary_entry.py"
BASE_NAME = "${options.slug}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a native executable with PyInstaller.")
    parser.add_argument("--clean", action="store_true", help="remove PyInstaller build directories before building")
    parser.add_argument("--name", default=default_binary_name(), help="output executable name")
    args = parser.parse_args()

    if args.clean:
        shutil.rmtree(ROOT / "build" / "pyinstaller", ignore_errors=True)
        shutil.rmtree(ROOT / "dist" / "binary", ignore_errors=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--onefile",
        "--name",
        args.name,
        "--distpath",
        str(ROOT / "dist" / "binary"),
        "--workpath",
        str(ROOT / "build" / "pyinstaller"),
        "--specpath",
        str(ROOT / "build" / "pyinstaller"),
        "--collect-submodules",
        "uvicorn",
        "--collect-submodules",
        "httptools",
        "--collect-submodules",
        "watchfiles",
        "--collect-submodules",
        "websockets",
        "--hidden-import",
        "${options.snakeName}.main",
        str(ENTRYPOINT),
    ]
    subprocess.run(command, cwd=ROOT, check=True)


def default_binary_name() -> str:
    system = platform.system().lower() or "unknown"
    machine = normalize_machine(platform.machine())
    suffix = ".exe" if system == "windows" else ".bin"
    return f"{BASE_NAME}-{system}-{machine}{suffix}"


def normalize_machine(machine: str) -> str:
    normalized = machine.lower().replace("amd64", "x86_64")
    if normalized in {"arm64", "aarch64"}:
        return "arm64"
    return normalized or "unknown"


if __name__ == "__main__":
    main()
`;
}

export function renderPythonBinaryGithubActions(options: TemplateScaffoldOptions): string {
  return `name: Build Binary

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build-binary:
    name: \${{ matrix.os }}
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
          - windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: python -m pip install --upgrade pip
      - run: python -m pip install -e .[dev,binary]
      - run: python scripts/validate.py
      - run: pytest
      - run: python scripts/build_binary.py --clean
      - uses: actions/upload-artifact@v4
        with:
          name: ${options.slug}-\${{ runner.os }}-\${{ runner.arch }}
          path: dist/binary/*
          if-no-files-found: error
`;
}

function nodeInstallCommand(options: TemplateScaffoldOptions): string {
  if (options.packageManager === "pnpm") {
    return "corepack enable && pnpm install";
  }
  if (options.packageManager === "yarn") {
    return "corepack enable && yarn install";
  }
  return "npm install";
}

function nodeRunCommand(options: TemplateScaffoldOptions, script: string): string {
  if (options.packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (options.packageManager === "yarn") {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
}

function nodeTestCommand(options: TemplateScaffoldOptions): string {
  if (options.packageManager === "pnpm") {
    return "pnpm test";
  }
  if (options.packageManager === "yarn") {
    return "yarn test";
  }
  return "npm test";
}
