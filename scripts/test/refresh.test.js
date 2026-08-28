"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSnapshot } = require("../catalog");
const {
  parseManifestBody,
  refreshEntries,
  retry,
  scrapeSource,
} = require("../refresh");

const SHA_1 = "1111111111111111111111111111111111111111";
const SHA_2 = "2222222222222222222222222222222222222222";

function refs(version = "1.0.0") {
  return [
    "ref: refs/heads/main\tHEAD",
    `${SHA_1}\tHEAD`,
    `${SHA_1}\trefs/heads/main`,
    `${SHA_2}\trefs/tags/v${version}`,
  ].join("\n");
}

function manifest(repository, version = "1.0.0") {
  return {
    name: repository.split("/").pop(),
    version,
    description: "Package.",
    repository: `https://github.com/${repository}.git`,
    engines: { lumine: "^1.0.0" },
  };
}

test("JSON, JSONC, and CSON manifests use their declared parsers", () => {
  assert.equal(
    parseManifestBody("package.json", '{"name":"json"}').name,
    "json",
  );
  assert.equal(
    parseManifestBody("package.jsonc", '{\n  // comment\n  "name": "jsonc",\n}')
      .name,
    "jsonc",
  );
  assert.equal(
    parseManifestBody("package.cson", 'name: "cson"\nversion: "1.0.0"').name,
    "cson",
  );
  assert.throws(() => parseManifestBody("package.json", "{"), /Syntax error/);
});

test("scrapeSource fetches the manifest from the exact selected SHA", async () => {
  let fetchedSha;
  const snapshot = await scrapeSource("owner/package", {
    listRefsImpl: async () => refs("1.0.0"),
    fetchManifestImpl: async (_parsed, sha) => {
      fetchedSha = sha;
      return manifest("owner/package");
    },
  });
  assert.equal(fetchedSha, SHA_2);
  assert.equal(snapshot.resolvedSha, SHA_2);
  assert.deepEqual(snapshot.selectedRef, { type: "latest", value: "v1.0.0" });
});

test("refresh preserves order, strings and old snapshots on per-entry failure", async () => {
  const oldSnapshot = createSnapshot({
    source: "owner/old",
    refOutput: refs("1.0.0"),
    manifest: manifest("owner/old"),
    featured: true,
  });
  const entries = ["owner/good", "owner/bad", oldSnapshot];
  const warnings = [];
  const result = await refreshEntries(entries, {
    onWarning: (warning) => warnings.push(warning),
    scrape: async (source, { featured }) => {
      if (source !== "owner/good") throw new Error("offline");
      return createSnapshot({
        source,
        refOutput: refs("1.0.0"),
        manifest: manifest(source),
        featured,
      });
    },
  });
  assert.equal(result.entries[0].source, "owner/good");
  assert.equal(result.entries[1], "owner/bad");
  assert.equal(result.entries[2], oldSnapshot);
  assert.equal(result.entries[2].featured, true);
  assert.deepEqual(
    warnings.map(({ source }) => source),
    ["owner/bad", "owner/old"],
  );
  assert.deepEqual(
    { changed: result.changed, failed: result.failed },
    { changed: 1, failed: 2 },
  );
});

test("a successful refresh preserves a manually selected featured flag", async () => {
  const oldSnapshot = createSnapshot({
    source: "owner/featured",
    refOutput: refs("1.0.0"),
    manifest: manifest("owner/featured"),
    featured: true,
  });
  const result = await refreshEntries([oldSnapshot], {
    scrape: async (source, { featured }) =>
      createSnapshot({
        source,
        refOutput: refs("1.0.0"),
        manifest: manifest(source),
        featured,
      }),
  });
  assert.equal(result.entries[0].featured, true);
});

test("refresh caps same-host work at eight concurrent entries", async () => {
  const entries = Array.from(
    { length: 20 },
    (_, index) => `owner/package-${index}`,
  );
  let active = 0;
  let maximum = 0;
  await refreshEntries(entries, {
    scrape: async (source) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return createSnapshot({
        source,
        refOutput: refs("1.0.0"),
        manifest: manifest(source),
      });
    },
  });
  assert.equal(maximum, 8);
});

test("retry retries transient work and stops on permanent errors", async () => {
  let attempts = 0;
  const value = await retry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    },
    { wait: async () => {} },
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts++;
        const error = new Error("permanent");
        error.retryable = false;
        throw error;
      },
      { wait: async () => {} },
    ),
    /permanent/,
  );
  assert.equal(attempts, 1);
});
