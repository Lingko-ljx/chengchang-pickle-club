import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

async function readPagesWorkflow() {
  const workflowSource = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  return { source: workflowSource, workflow: parse(workflowSource) };
}

test("Pages build receives the public booking API and CloudBase env identifiers", async () => {
  const { source, workflow } = await readPagesWorkflow();
  const configureStep = workflow.jobs.build.steps.find(
    (step) => step.uses === "actions/configure-pages@v5",
  );
  const buildStep = workflow.jobs.build.steps.find(
    (step) => step.name === "Build static site",
  );

  assert.ok(buildStep, "workflow must include the named Pages build step");
  assert.equal(configureStep?.id, "pages");
  assert.equal(buildStep.env?.PAGES_BASE_PATH, "${{ steps.pages.outputs.base_path }}");
  assert.equal(
    buildStep.env?.NEXT_PUBLIC_SITE_URL,
    "${{ steps.pages.outputs.base_url }}",
  );
  assert.equal(
    buildStep.env?.NEXT_PUBLIC_BOOKING_API_BASE_URL,
    "${{ vars.BOOKING_API_BASE_URL }}",
  );
  assert.equal(
    buildStep.env?.NEXT_PUBLIC_CLOUDBASE_ENV_ID,
    "${{ vars.CLOUDBASE_ENV_ID }}",
  );
  assert.doesNotMatch(source, /FORMSPREE/i);
  assert.doesNotMatch(source, /github\.io|github\.event\.repository\.name/);
});

test("Pages workflow verifies the static site immediately after building", async () => {
  const { workflow } = await readPagesWorkflow();
  const steps = workflow.jobs.build.steps;
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build static site",
  );

  assert.notEqual(buildIndex, -1, "workflow must include the named Pages build step");
  assert.deepEqual(steps[buildIndex + 1], {
    name: "Verify static site",
    env: {
      PAGES_BASE_PATH: "${{ steps.pages.outputs.base_path }}",
      NEXT_PUBLIC_SITE_URL: "${{ steps.pages.outputs.base_url }}",
      NEXT_PUBLIC_BOOKING_API_BASE_URL: "${{ vars.BOOKING_API_BASE_URL }}",
      NEXT_PUBLIC_CLOUDBASE_ENV_ID: "${{ vars.CLOUDBASE_ENV_ID }}",
    },
    run: "npm run test:pages",
  });
});
