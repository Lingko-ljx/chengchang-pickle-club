# GitHub Pages Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing pickleball club website to a public GitHub Pages project URL without changing its visible behavior or breaking the existing Sites build.

**Architecture:** Add a conditional Next.js static-export mode that is enabled only for GitHub Pages builds. A GitHub Actions workflow builds `out/` with the repository base path, uploads it as a Pages artifact, and deploys it while the existing vinext/Sites path remains unchanged.

**Tech Stack:** Next.js 16, React 19, Node.js 22, Node test runner, GitHub Actions, GitHub Pages

## Global Constraints

- Preserve the current Chinese single-page design and responsive behavior.
- Keep the booking flow browser-only; it must not store or transmit visitor data.
- Preserve the existing `npm run build` Sites-compatible output.
- Publish from a public repository named `chengchang-pickle-club`.
- GitHub Pages assets must resolve below `/chengchang-pickle-club/`.
- Do not delete or change access to the existing ChatGPT Sites deployment.

---

### Task 1: Add a failing static-export artifact test

**Files:**
- Create: `tests/pages-static-export.test.mjs`

**Interfaces:**
- Consumes: GitHub Pages build output at `out/index.html`
- Produces: A regression test that validates the exported title, repository base path, and client bundle references

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exports a GitHub Pages-ready homepage", async () => {
  const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");

  assert.match(html, /澄场 PICKLE CLUB/);
  assert.match(html, /\/chengchang-pickle-club\/_next\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test tests/pages-static-export.test.mjs
```

Expected: FAIL because `out/index.html` does not exist.

- [ ] **Step 3: Commit the failing test**

```powershell
git add tests/pages-static-export.test.mjs
git commit -m "test: define GitHub Pages export contract"
```

### Task 2: Add conditional static export support

**Files:**
- Modify: `next.config.ts`
- Modify: `app/layout.tsx`
- Modify: `package.json`
- Test: `tests/pages-static-export.test.mjs`

**Interfaces:**
- Consumes: `GITHUB_PAGES`, `PAGES_BASE_PATH`, and `NEXT_PUBLIC_SITE_URL`
- Produces: `npm run build:pages`, generating a static `out/` directory

- [ ] **Step 1: Make Pages mode conditional in `next.config.ts`**

```ts
import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const pagesBasePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: "export",
      trailingSlash: true,
      basePath: pagesBasePath,
    }
  : {};

export default nextConfig;
```

- [ ] **Step 2: Replace request-dependent metadata with build-time metadata**

In `app/layout.tsx`, remove `headers()` and `generateMetadata()`. Export a static `metadata` object whose `metadataBase`, icon, Open Graph image, and X image use:

```ts
const defaultSiteUrl =
  "https://chengchang-pickle-club.hujingseuits.chatgpt.site/";
const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? defaultSiteUrl);
const faviconUrl = new URL("favicon.svg", siteUrl).toString();
const socialImageUrl = new URL("og.png", siteUrl).toString();
```

- [ ] **Step 3: Add the Pages build script**

Add this script to `package.json`:

```json
"build:pages": "next build"
```

- [ ] **Step 4: Build the static export**

Run:

```powershell
$env:GITHUB_PAGES='true'
$env:PAGES_BASE_PATH='/chengchang-pickle-club'
$env:NEXT_PUBLIC_SITE_URL='https://example.github.io/chengchang-pickle-club/'
npm run build:pages
```

Expected: PASS and create `out/index.html`.

- [ ] **Step 5: Run the artifact test**

Run:

```powershell
node --test tests/pages-static-export.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run the existing regression suite**

Run:

```powershell
npm test
```

Expected: PASS with all existing and new tests.

- [ ] **Step 7: Commit static export support**

```powershell
git add next.config.ts app/layout.tsx package.json package-lock.json tests/pages-static-export.test.mjs
git commit -m "feat: add GitHub Pages static export"
```

### Task 3: Add the GitHub Pages deployment workflow

**Files:**
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: A public GitHub repository named `chengchang-pickle-club`
- Produces: A GitHub Pages deployment and `page_url` from `actions/deploy-pages`

- [ ] **Step 1: Create the workflow**

```yaml
name: Deploy GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: actions/configure-pages@v5
      - run: npm ci
      - name: Build static site
        env:
          GITHUB_PAGES: "true"
          PAGES_BASE_PATH: /${{ github.event.repository.name }}
          NEXT_PUBLIC_SITE_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/
        run: npm run build:pages
      - run: touch out/.nojekyll
      - uses: actions/upload-pages-artifact@v4
        with:
          path: out

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Verify workflow syntax and local build**

Run:

```powershell
npm run lint
npm test
```

Expected: PASS with no lint or test failures.

- [ ] **Step 3: Commit the workflow**

```powershell
git add .github/workflows/pages.yml
git commit -m "ci: deploy site to GitHub Pages"
```

### Task 4: Create and publish the GitHub repository

**Files:**
- No local source changes

**Interfaces:**
- Consumes: The verified local `main` branch
- Produces: Public repository `chengchang-pickle-club` and a successful Pages workflow run

- [ ] **Step 1: Create the public repository through the logged-in GitHub web UI**

Create `chengchang-pickle-club` without README, license, or `.gitignore` so the existing history can be pushed cleanly.

- [ ] **Step 2: Add the repository as a remote and push `main`**

Use the exact HTTPS repository URL shown by GitHub, then run:

```powershell
git remote add github <exact-repository-url>
git push -u github main
```

- [ ] **Step 3: Enable GitHub Actions as the Pages source**

In repository settings, set Pages build and deployment source to GitHub Actions if the workflow has not enabled it automatically.

- [ ] **Step 4: Wait for the workflow**

Inspect the `Deploy GitHub Pages` workflow until both `build` and `deploy` succeed.

- [ ] **Step 5: Verify the public URL**

Open:

```text
https://<github-owner>.github.io/chengchang-pickle-club/
```

Confirm the title, styling, anchor navigation, and booking demo work without signing in.
