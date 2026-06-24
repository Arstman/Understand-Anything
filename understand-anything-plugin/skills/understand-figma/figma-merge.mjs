#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mergeDesignGraph } from "@understand-anything/core/figma";

const [, , projectRoot] = process.argv;
const interDir = join(projectRoot, ".understand-anything", "intermediate");
const manifest = JSON.parse(readFileSync(join(interDir, "scan-manifest.json"), "utf8"));
const analyses = readdirSync(interDir)
  .filter((f) => /^analysis-batch-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(interDir, f), "utf8")));

const result = mergeDesignGraph(
  { nodes: manifest.nodes, edges: manifest.edges },
  analyses,
  manifest.project,
);
if (!result.success || !result.data) {
  console.error("Merge failed:", result.fatal ?? "unknown error");
  process.exit(1);
}

const outDir = join(projectRoot, ".understand-anything");
writeFileSync(join(outDir, "knowledge-graph.json"), JSON.stringify(result.data, null, 2));
writeFileSync(join(outDir, "meta.json"), JSON.stringify({
  lastAnalyzedAt: new Date().toISOString(),
  gitCommitHash: "",
  figmaVersion: manifest.figmaVersion ?? "",
  version: "1.0.0",
  analyzedFiles: result.data.nodes.length,
}, null, 2));

console.error(
  `Design graph: ${result.data.nodes.length} nodes, ${result.data.edges.length} edges, ` +
  `${result.data.layers.length} layers, ${result.data.tour.length} tour steps`,
);
for (const issue of result.issues) {
  if (issue.level !== "auto-corrected") console.error(`[${issue.level}] ${issue.message}`);
}
