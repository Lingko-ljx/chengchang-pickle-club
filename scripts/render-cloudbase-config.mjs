import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const targetPath = path.join(repositoryRoot, "cloudbaserc.json");

function readEnvironmentId(environment) {
  const environmentId = environment.CLOUDBASE_ENV_ID?.trim();
  if (!environmentId) {
    throw new Error("Missing configuration: CLOUDBASE_ENV_ID");
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(environmentId)) {
    throw new Error("Invalid configuration: CLOUDBASE_ENV_ID");
  }
  return environmentId;
}

function readDeploymentRevision(environment) {
  const revision = environment.CLOUDBASE_DEPLOYMENT_REVISION?.trim();
  if (!revision) {
    throw new Error("Missing configuration: CLOUDBASE_DEPLOYMENT_REVISION");
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Invalid configuration: CLOUDBASE_DEPLOYMENT_REVISION");
  }
  return revision;
}

export function cloudbaseConfiguration(environment) {
  const envId = readEnvironmentId(environment);
  const revision = readDeploymentRevision(environment);
  const sharedFunctionConfiguration = {
    description: `deployment-revision:${revision}`,
    runtime: "Nodejs20.19",
    handler: "index.main",
    installDependency: true,
  };
  return {
    $schema: "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
    envId,
    functionRoot: "cloudbase/functions",
    functions: [
      { name: "booking-public-api", ...sharedFunctionConfiguration },
      { name: "booking-admin-api", ...sharedFunctionConfiguration },
      {
        name: "booking-mailer",
        ...sharedFunctionConfiguration,
        triggers: [
          {
            name: "booking-mailer-every-minute",
            type: "timer",
            config: "0 * * * * * *",
          },
        ],
      },
    ],
  };
}

async function replaceAtomically(target, contents) {
  const temporaryPath = path.join(
    path.dirname(target),
    `.cloudbaserc.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, target);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function renderCloudbaseConfiguration(environment = process.env) {
  const configuration = cloudbaseConfiguration(environment);
  await replaceAtomically(targetPath, `${JSON.stringify(configuration, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await renderCloudbaseConfiguration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CloudBase config render failed");
    process.exitCode = 1;
  }
}
