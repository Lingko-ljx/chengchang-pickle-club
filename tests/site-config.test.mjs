import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SITE_URL,
  resolveSiteConfiguration,
} from "../app/site-config.ts";

test("normalizes GitHub project Pages and custom-domain root directory URLs", () => {
  assert.deepEqual(
    resolveSiteConfiguration({
      GITHUB_PAGES: "true",
      NODE_ENV: "production",
      PAGES_BASE_PATH: "/chengchang-pickle-club/",
      NEXT_PUBLIC_SITE_URL:
        "https://lingko-ljx.github.io/chengchang-pickle-club",
    }),
    {
      basePath: "/chengchang-pickle-club",
      siteUrl: "https://lingko-ljx.github.io/chengchang-pickle-club/",
    },
  );

  assert.deepEqual(
    resolveSiteConfiguration({
      GITHUB_PAGES: "true",
      NODE_ENV: "production",
      PAGES_BASE_PATH: "",
      NEXT_PUBLIC_SITE_URL: "https://pickle.example.com",
    }),
    { basePath: "", siteUrl: "https://pickle.example.com/" },
  );
});

test("ordinary builds use the canonical default while development permits loopback HTTP", () => {
  assert.deepEqual(resolveSiteConfiguration({}), {
    basePath: "",
    siteUrl: DEFAULT_SITE_URL,
  });
  assert.deepEqual(
    resolveSiteConfiguration({
      NODE_ENV: "development",
      PAGES_BASE_PATH: "/demo",
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000/demo",
    }),
    { basePath: "/demo", siteUrl: "http://127.0.0.1:3000/demo/" },
  );
});

test("site URLs reject credentials, query, fragment, production HTTP, and path mismatch", () => {
  const invalidValues = [
    "https://user:password@pages.example/repository/",
    "https://pages.example/repository/?token=secret",
    "https://pages.example/repository/#fragment",
    "https://pages.example/repository/?",
    "https://pages.example/repository/#",
    "http://pages.example/repository/",
    "http://localhost:3000/repository/",
    "https:pages.example/repository/",
    "https://pages.example/other/",
  ];

  for (const value of invalidValues) {
    assert.throws(
      () =>
        resolveSiteConfiguration({
          GITHUB_PAGES: "true",
          NODE_ENV: "production",
          PAGES_BASE_PATH: "/repository",
          NEXT_PUBLIC_SITE_URL: value,
        }),
      (error) => {
        assert.match(error.message, /NEXT_PUBLIC_SITE_URL/);
        assert.doesNotMatch(error.message, /password|token|fragment|pages\.example/);
        return true;
      },
      value,
    );
  }
});

test("unsafe base paths and missing Pages site URLs fail closed", () => {
  for (const value of [
    "repository",
    "//repository",
    "/repository//nested",
    "/repository/../private",
    "/repository?query",
  ]) {
    assert.throws(
      () =>
        resolveSiteConfiguration({
          GITHUB_PAGES: "true",
          NODE_ENV: "production",
          PAGES_BASE_PATH: value,
          NEXT_PUBLIC_SITE_URL: "https://pages.example/repository/",
        }),
      /PAGES_BASE_PATH/,
      value,
    );
  }

  assert.throws(
    () =>
      resolveSiteConfiguration({
        GITHUB_PAGES: "true",
        NODE_ENV: "production",
        PAGES_BASE_PATH: "/repository",
      }),
    /NEXT_PUBLIC_SITE_URL/,
  );
});
