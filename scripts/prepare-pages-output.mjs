import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("out");

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
    (tag, attributes) =>
      /\bdata-booking-enhancement\b/i.test(attributes) ? tag : "",
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
if (!/action="https:\/\/formspree\.io\/f\/[A-Za-z0-9_-]+"/.test(homepage)) {
  throw new Error(
    "NEXT_PUBLIC_FORMSPREE_ENDPOINT must be a valid Formspree endpoint",
  );
}
