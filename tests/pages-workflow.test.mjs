import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

async function readPagesWorkflow() {
  const workflowSource = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  return parse(workflowSource);
}

test("Pages build receives the public Formspree endpoint", async () => {
  const workflow = await readPagesWorkflow();
  const buildStep = workflow.jobs.build.steps.find(
    (step) => step.name === "Build static site",
  );

  assert.ok(buildStep, "workflow must include the named Pages build step");
  assert.equal(
    buildStep.env?.NEXT_PUBLIC_FORMSPREE_ENDPOINT,
    "${{ vars.FORMSPREE_ENDPOINT }}",
  );
});

test("Pages workflow verifies the static site immediately after building", async () => {
  const workflow = await readPagesWorkflow();
  const steps = workflow.jobs.build.steps;
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build static site",
  );

  assert.notEqual(buildIndex, -1, "workflow must include the named Pages build step");
  assert.deepEqual(steps[buildIndex + 1], {
    name: "Verify static site",
    run: "npm run test:pages",
  });
});
