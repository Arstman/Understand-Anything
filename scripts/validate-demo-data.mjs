import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_FILENAMES = [
  "knowledge-graph.json",
  "domain-graph.json",
  "meta.json",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DATASET_REPOSITORY = "Lum1104/microservices-demo";
const DATASET_PATH = ".understand-anything";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateManifest(manifest) {
  invariant(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "manifest must be a JSON object",
  );
  invariant(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  invariant(
    manifest.dataset && typeof manifest.dataset === "object",
    "manifest dataset must be an object",
  );
  invariant(
    manifest.dataset.repository === DATASET_REPOSITORY,
    `manifest dataset.repository must be ${DATASET_REPOSITORY}`,
  );
  invariant(
    COMMIT_PATTERN.test(manifest.dataset.commit ?? ""),
    "manifest dataset.commit must be a lowercase 40-character Git SHA",
  );
  invariant(
    manifest.dataset.path === DATASET_PATH,
    `manifest dataset.path must be ${DATASET_PATH}`,
  );
  invariant(
    COMMIT_PATTERN.test(manifest.dataset.analyzedCommit ?? ""),
    "manifest dataset.analyzedCommit must be a lowercase 40-character Git SHA",
  );
  invariant(Array.isArray(manifest.files), "manifest files must be an array");

  const names = [];
  for (const [index, file] of manifest.files.entries()) {
    const label = `manifest files[${index}]`;
    invariant(file && typeof file === "object", `${label} must be an object`);
    invariant(
      typeof file.filename === "string" &&
        file.filename.length > 0 &&
        !isAbsolute(file.filename) &&
        basename(file.filename) === file.filename,
      `${label}.filename must be a plain filename`,
    );
    invariant(
      Number.isSafeInteger(file.bytes) && file.bytes > 0,
      `${label}.bytes must be a positive safe integer`,
    );
    invariant(
      SHA256_PATTERN.test(file.sha256 ?? ""),
      `${label}.sha256 must be a lowercase SHA-256 digest`,
    );
    invariant(
      file.contentType === "application/json",
      `${label}.contentType must be application/json`,
    );
    invariant(
      file.cacheControl === "public,max-age=3600,must-revalidate",
      `${label}.cacheControl does not match the public demo cache contract`,
    );
    names.push(file.filename);
  }

  invariant(
    new Set(names).size === names.length,
    "manifest contains duplicate filenames",
  );
  invariant(
    JSON.stringify([...names].sort()) ===
      JSON.stringify([...EXPECTED_FILENAMES].sort()),
    `manifest must contain exactly: ${EXPECTED_FILENAMES.join(", ")}`,
  );
}

function validateDatasetBinding(filename, value, analyzedCommit) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${filename} must contain a JSON object`,
  );

  if (filename === "meta.json") {
    invariant(
      value.gitCommitHash === analyzedCommit,
      `${filename} gitCommitHash does not match manifest analyzed commit`,
    );
    return;
  }

  invariant(Array.isArray(value.nodes), `${filename} nodes must be an array`);
  invariant(Array.isArray(value.edges), `${filename} edges must be an array`);
  invariant(
    value.project && value.project.gitCommitHash === analyzedCommit,
    `${filename} project.gitCommitHash does not match manifest analyzed commit`,
  );
}

export function validateDemoData(dataDirectory) {
  const directory = resolve(dataDirectory);
  const manifestPath = resolve(directory, "manifest.json");
  invariant(
    lstatSync(manifestPath).isFile(),
    "manifest.json must be a regular file, not a symlink",
  );
  const manifest = parseJson(manifestPath, "manifest.json");
  validateManifest(manifest);

  const expectedEntries = ["manifest.json", ...EXPECTED_FILENAMES].sort();
  const actualEntries = readdirSync(directory).sort();
  invariant(
    JSON.stringify(actualEntries) === JSON.stringify(expectedEntries),
    `demo-data directory must contain exactly: ${expectedEntries.join(", ")}`,
  );

  let totalBytes = 0;
  for (const file of manifest.files) {
    const path = resolve(directory, file.filename);
    invariant(
      dirname(path) === directory,
      `${file.filename} resolves outside the demo-data directory`,
    );

    const stat = lstatSync(path);
    invariant(
      stat.isFile(),
      `${file.filename} must be a regular file, not a symlink`,
    );
    const bytes = readFileSync(path);
    const digest = createHash("sha256").update(bytes).digest("hex");

    invariant(
      bytes.byteLength === file.bytes,
      `${file.filename} byte size mismatch: expected ${file.bytes}, got ${bytes.byteLength}`,
    );
    invariant(
      digest === file.sha256,
      `${file.filename} SHA-256 mismatch: expected ${file.sha256}, got ${digest}`,
    );

    const value = parseJson(path, file.filename);
    validateDatasetBinding(
      file.filename,
      value,
      manifest.dataset.analyzedCommit,
    );
    totalBytes += bytes.byteLength;
  }

  return {
    datasetRepository: manifest.dataset.repository,
    datasetCommit: manifest.dataset.commit,
    datasetPath: manifest.dataset.path,
    analyzedCommit: manifest.dataset.analyzedCommit,
    fileCount: manifest.files.length,
    totalBytes,
    files: manifest.files.map(({ filename, bytes, sha256 }) => ({
      filename,
      bytes,
      sha256,
    })),
  };
}

const scriptPath = fileURLToPath(import.meta.url);
const defaultDirectory = resolve(dirname(scriptPath), "../demo-data");
const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  try {
    const summary = validateDemoData(process.argv[2] ?? defaultDirectory);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`demo-data validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
