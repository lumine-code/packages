"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { assertSafePackageSource, createSnapshot } = require("../catalog");
const {
  fetchManifest,
  MANIFEST_FILENAMES,
  MAX_MANIFEST_BYTES,
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

test("private GitHub raw 404s fall back to Git at the exact selected SHA", async () => {
  const parsed = assertSafePackageSource("owner/private-package");
  const requests = [];
  const calls = [];
  const expected = manifest("owner/private-package");
  const actual = await fetchManifest(parsed, SHA_1, {
    assertHostname: async (host) =>
      assert.equal(host, "raw.githubusercontent.com"),
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(null, { status: 404 });
    },
    run: async (args, options) => {
      calls.push({ args, ...options });
      return args[0] === "show" ? JSON.stringify(expected) : "";
    },
  });
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    requests,
    MANIFEST_FILENAMES.map(
      (name) =>
        `https://raw.githubusercontent.com/owner/private-package/${SHA_1}/${name}`,
    ),
  );
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["init"],
      ["remote", "add", "origin", parsed.cloneUrl],
      ["fetch", "--depth", "1", "origin", SHA_1],
      ["show", "FETCH_HEAD:package.json"],
    ],
  );
  assert.ok(
    calls.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 60000),
  );
  assert.equal(fs.existsSync(calls[0].cwd), false);
});

test("public GitHub manifests retain the raw fast path without invoking Git", async () => {
  const parsed = assertSafePackageSource("owner/public-package");
  const expected = manifest("owner/public-package");
  for (const filename of ["package.json", "package.jsonc"]) {
    let requests = 0;
    assert.deepEqual(
      await fetchManifest(parsed, SHA_1, {
        assertHostname: async () => {},
        fetchImpl: async (url) => {
          requests++;
          return url.endsWith(filename)
            ? new Response(JSON.stringify(expected))
            : new Response(null, { status: 404 });
        },
        run: async () =>
          assert.fail("A successful raw manifest must not invoke Git"),
      }),
      expected,
    );
    assert.equal(requests, filename === "package.json" ? 1 : 2);
  }
});

test("genuinely missing manifests still fail and clean up the Git fallback", async () => {
  const calls = [];
  await assert.rejects(
    fetchManifest(assertSafePackageSource("owner/missing"), SHA_1, {
      assertHostname: async () => {},
      fetchImpl: async () => new Response(null, { status: 404 }),
      run: async (args, options) => {
        calls.push({ args, ...options });
        if (args[0] === "show")
          throw new Error("Manifest is absent in this exact Git tree");
        return "";
      },
    }),
    /Manifest is absent in this exact Git tree/,
  );
  assert.deepEqual(
    calls.filter(({ args }) => args[0] === "show").map(({ args }) => args[1]),
    MANIFEST_FILENAMES.map((name) => `FETCH_HEAD:${name}`),
  );
  assert.equal(fs.existsSync(calls[0].cwd), false);
});

test("the private Git fallback retains the manifest size limit", async () => {
  await assert.rejects(
    fetchManifest(assertSafePackageSource("owner/oversized"), SHA_1, {
      assertHostname: async () => {},
      fetchImpl: async () => new Response(null, { status: 404 }),
      run: async (args) =>
        args[0] === "show" ? " ".repeat(MAX_MANIFEST_BYTES + 1) : "",
    }),
    /Manifest exceeds the .*byte limit/,
  );
});

test("non-404 errors cannot enable the credentialed Git fallback", async () => {
  const parsed = assertSafePackageSource("owner/package");
  for (const [name, fetchImpl, expected] of [
    ["invalid JSON", async () => new Response("{"), /Syntax error/],
    [
      "oversized content",
      async () =>
        new Response("", {
          headers: { "content-length": String(MAX_MANIFEST_BYTES + 1) },
        }),
      /Response exceeds/,
    ],
    [
      "a forbidden response followed by missing alternatives",
      async (url) =>
        new Response(null, {
          status: url.endsWith("package.json") ? 403 : 404,
        }),
      /HTTP 403/,
    ],
    [
      "an aborted request",
      async () => {
        throw Object.assign(new Error("Aborted request"), {
          name: "AbortError",
          retryable: false,
        });
      },
      /Aborted request/,
    ],
  ]) {
    await assert.rejects(
      fetchManifest(parsed, SHA_1, {
        assertHostname: async () => {},
        fetchImpl,
        run: async () => assert.fail(`${name} must not invoke Git`),
      }),
      expected,
      name,
    );
  }
});

test("unsafe package sources fail before any private-manifest transport", async () => {
  await assert.rejects(
    scrapeSource("https://127.0.0.1/private", {
      listRefsImpl: async () =>
        assert.fail("An unsafe source must not resolve refs"),
      fetchManifestImpl: async () =>
        assert.fail("An unsafe source must not fetch a manifest"),
    }),
    /private|loopback/i,
  );
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
