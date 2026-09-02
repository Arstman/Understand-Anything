import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/publish-demo-data.yml"),
  "utf8",
);

describe("demo data publication workflow", () => {
  it("is manual and binds authorization to exact live main", () => {
    expect(workflow).toMatch(/^on:\r?\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(workflow).toContain('GITHUB_REF" != "refs/heads/main');
    expect(workflow).toContain('CANDIDATE_SHA" == "$GITHUB_SHA');
    expect(workflow).toContain("git rev-parse HEAD");
    expect(workflow.match(/git ls-remote/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain(
      "PUBLISH_UA_DEMO_DATA_PROD:${CANDIDATE_SHA}",
    );
  });

  it("validates before assuming the dedicated publisher role", () => {
    expect(workflow).toContain(
      "arn:aws:iam::309965488466:role/egonex-prod-understand-anything-demo-publisher",
    );
    expect(workflow).toContain("egonex-prod-understand-anything-demo");
    expect(workflow).toContain("vars.DEMO_CLOUDFRONT_DISTRIBUTION_ID");
    expect(workflow).toContain("vars.DEMO_CLOUDFRONT_DOMAIN");
    expect(workflow.indexOf("node scripts/validate-demo-data.mjs")).toBeLessThan(
      workflow.indexOf("aws-actions/configure-aws-credentials@"),
    );
  });

  it("publishes only the manifest allowlist and verifies both storage layers", () => {
    expect(workflow).not.toContain("aws s3 sync");
    expect(workflow).toContain("aws s3api put-object");
    expect(workflow).toContain("aws s3api head-object");
    expect(workflow).toContain("aws s3 cp");
    expect(workflow).toContain("cloudfront wait invalidation-completed");
    expect(workflow).toContain('Origin: $EXPECTED_ORIGIN');
    expect(workflow).toContain("actual_sha");
    expect(workflow).toContain("aws s3api delete-object");
  });
});
