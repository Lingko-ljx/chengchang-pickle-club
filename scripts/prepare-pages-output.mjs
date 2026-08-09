import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("out");
const allowedClientScript =
  /\b(?:data-booking-form-client|data-booking-result-client|data-booking-status-client|data-admin-client)(?:\s|=|$)/i;

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectHtmlFiles(target);
      return entry.isFile() && entry.name.endsWith(".html") ? [target] : [];
    }),
  );
  return nested.flat();
}

function removeClientRuntime(html) {
  const withoutScripts = html.replace(
    /<script\b([^>]*)>[\s\S]*?<\/script>/gi,
    (tag, attributes) => (allowedClientScript.test(attributes) ? tag : ""),
  );

  return withoutScripts.replace(/<link\b[^>]*>/gi, (tag) => {
    const isModulePreload = /\brel=["']modulepreload["']/i.test(tag);
    const isScriptPreload =
      /\brel=["']preload["']/i.test(tag) &&
      /\bas=["']script["']/i.test(tag);
    return isModulePreload || isScriptPreload ? "" : tag;
  });
}

const htmlFiles = await collectHtmlFiles(outputDirectory);

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  await writeFile(file, removeClientRuntime(html), "utf8");
}

const homepage = await readFile(path.join(outputDirectory, "index.html"), "utf8");
const configuredBaseUrl = (
  process.env.NEXT_PUBLIC_BOOKING_API_BASE_URL ?? ""
).trim();
const expectedAction = `${configuredBaseUrl.replace(/\/+$/, "")}/v1/bookings`;

if (!configuredBaseUrl || !homepage.includes(`action="${expectedAction}"`)) {
  throw new Error(
    "NEXT_PUBLIC_BOOKING_API_BASE_URL must match the exported booking form action",
  );
}
if (/formspree/i.test(homepage)) {
  throw new Error("The exported booking form must not reference Formspree");
}
