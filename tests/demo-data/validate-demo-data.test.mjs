import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { validateDemoData } from "../../scripts/validate-demo-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const canonicalData = resolve(repoRoot, "demo-data");
const temporaryDirectories = [];

async function copyFixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "ua-demo-data-test-"));
  temporaryDirectories.push(directory);
  await cp(canonicalData, directory, { recursive: true });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("demo data manifest validation", () => {
  it("accepts the exact recovered dataset", () => {
    const result = validateDemoData(canonicalData);

    expect(result.datasetRepository).toBe(
      "Lum1104/microservices-demo",
    );
    expect(result.datasetCommit).toBe(
      "f0120e4544c41104f0d9b45d320764f1b1148fe4",
    );
    expect(result.datasetPath).toBe(".understand-anything");
    expect(result.analyzedCommit).toBe(
      "c9857ee54fba10486013f15ba6b31411986f530c",
    );
    expect(result.fileCount).toBe(3);
    expect(result.totalBytes).toBe(373605);
  });

  it("rejects a same-length byte-level change to a source object", async () => {
    const directory = await copyFixture();
    const graphPath = resolve(directory, "knowledge-graph.json");
    const bytes = readFileSync(graphPath);
    bytes[0] ^= 1;
    writeFileSync(graphPath, bytes);

    expect(() => validateDemoData(directory)).toThrow(/SHA-256 mismatch/);
  });

  it("rejects an analyzed commit that does not bind the objects", async () => {
    const directory = await copyFixture();
    const manifestPath = resolve(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dataset.analyzedCommit = "0".repeat(40);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateDemoData(directory)).toThrow(
      /gitCommitHash does not match manifest analyzed commit/,
    );
  });

  it("rejects symlinked data objects", async () => {
    const directory = await copyFixture();
    const graphPath = resolve(directory, "knowledge-graph.json");
    rmSync(graphPath);
    symlinkSync(resolve(canonicalData, "knowledge-graph.json"), graphPath);

    expect(() => validateDemoData(directory)).toThrow(/regular file, not a symlink/);
  });

  it("rejects filenames outside the fixed three-object allowlist", async () => {
    const directory = await copyFixture();
    const manifestPath = resolve(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].filename = "../knowledge-graph.json";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateDemoData(directory)).toThrow(/plain filename/);
  });
});
