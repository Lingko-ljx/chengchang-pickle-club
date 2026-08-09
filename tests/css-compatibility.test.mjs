import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";

function physicalInsetValues(value) {
  const values = value.trim().split(/\s+/);

  if (values.length === 1) {
    return { top: values[0], right: values[0], bottom: values[0], left: values[0] };
  }
  if (values.length === 2) {
    return { top: values[0], right: values[1], bottom: values[0], left: values[1] };
  }
  if (values.length === 3) {
    return { top: values[0], right: values[1], bottom: values[2], left: values[1] };
  }
  return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
}

function declarationsFor(container, selector) {
  const declarations = new Map();
  container.walkRules((rule) => {
    const selectors = rule.selectors.map((value) => value.trim());
    if (!selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

function directDeclarationsFor(container, selector) {
  const declarations = new Map();
  for (const rule of container.nodes ?? []) {
    if (rule.type !== "rule") continue;
    const selectors = rule.selectors.map((value) => value.trim());
    if (!selectors.includes(selector)) continue;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  }
  return declarations;
}

function findAtRule(container, name, params) {
  let match;
  container.walkAtRules(name, (rule) => {
    if (rule.params === params) match = rule;
  });
  return match;
}

function findDirectAtRule(container, name, params) {
  return (container.nodes ?? []).find(
    (rule) => rule.type === "atrule" && rule.name === name && rule.params === params,
  );
}

function ratioFor(container, selector) {
  const value = directDeclarationsFor(container, selector).get("aspect-ratio");
  assert.ok(value, `expected ${selector} to define an aspect ratio`);
  const [width, height = "1"] = value.split("/").map(Number);
  return width / height;
}

function assertAspectFallback(declarations, ratio) {
  assert.equal(declarations.get("height"), "0");
  assert.equal(declarations.get("padding-top"), "0");
  assert.match(declarations.get("padding-bottom") ?? "", /%$/);
  assert.ok(
    Math.abs(Number.parseFloat(declarations.get("padding-bottom")) - 100 / ratio) < 0.0001,
  );
}

test("critical modern CSS has old-browser fallbacks with matching semantics", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const root = postcss.parse(css);

  root.walkDecls("font-size", (declaration) => {
    if (!declaration.value.includes("clamp(")) return;

    let previous = declaration.prev();
    while (previous && previous.type === "comment") previous = previous.prev();

    assert.equal(previous?.type, "decl");
    assert.equal(previous?.prop, "font-size");
    assert.equal(previous.value.includes("clamp("), false);
  });

  root.walkDecls(/^(margin|padding)-inline$/, (logical) => {
    const base = logical.prop.startsWith("margin") ? "margin" : "padding";
    const earlier = new Map();
    let previous = logical.prev();
    while (previous) {
      if (previous.type === "decl") earlier.set(previous.prop, previous.value);
      previous = previous.prev();
    }

    assert.equal(earlier.get(`${base}-left`), logical.value);
    assert.equal(earlier.get(`${base}-right`), logical.value);
  });

  root.walkDecls("inset", (logical) => {
    const expected = physicalInsetValues(logical.value);
    const earlier = new Map();
    let previous = logical.prev();
    while (previous) {
      if (previous.type === "decl") earlier.set(previous.prop, previous.value);
      previous = previous.prev();
    }

    for (const [property, value] of Object.entries(expected)) {
      assert.equal(earlier.get(property), value, `${logical.parent.selector}: ${property}`);
    }
  });

  const aspectFallback = findAtRule(root, "supports", "not (aspect-ratio: 1 / 1)");
  assert.ok(aspectFallback);
  const tablet = findDirectAtRule(root, "media", "(max-width: 860px)");
  const mobile = findDirectAtRule(root, "media", "(max-width: 620px)");
  const tabletFallback = findDirectAtRule(
    aspectFallback,
    "media",
    "(max-width: 860px)",
  );
  const mobileFallback = findDirectAtRule(
    aspectFallback,
    "media",
    "(max-width: 620px)",
  );

  assert.ok(tablet);
  assert.ok(mobile);
  assert.ok(tabletFallback);
  assert.ok(mobileFallback);
  assertAspectFallback(
    directDeclarationsFor(aspectFallback, ".venue-board"),
    ratioFor(root, ".venue-board"),
  );
  assertAspectFallback(
    directDeclarationsFor(tabletFallback, ".venue-board"),
    ratioFor(tablet, ".venue-board"),
  );
  assertAspectFallback(
    directDeclarationsFor(mobileFallback, ".venue-board"),
    ratioFor(mobile, ".venue-board"),
  );
  assert.deepEqual(directDeclarationsFor(aspectFallback, ".coach-portrait"), new Map([
    ["height", "0"],
    ["padding-bottom", "122%"],
  ]));

  const gapFallback = findAtRule(root, "supports", "not (gap: 1rem)");
  assert.ok(gapFallback);
  for (const selector of [
    ".booking-layout > * + *",
    ".contact-layout > * + *",
    ".honors-layout > * + *",
  ]) {
    assert.equal(declarationsFor(gapFallback, selector).get("margin-top"), "42px");
  }
  assert.equal(
    declarationsFor(gapFallback, ".input-grid > * + *").get("margin-top"),
    "16px",
  );

  assert.equal(declarationsFor(root, ".honeypot-field").get("position"), "absolute");
  assert.equal(declarationsFor(root, ".privacy-consent").get("display"), "flex");
  assert.equal(declarationsFor(root, ".booking-disclaimer").get("color"), "var(--muted)");
  assert.equal(
    declarationsFor(root, ".booking-success-message").get("border"),
    "1px solid var(--lime)",
  );
});
