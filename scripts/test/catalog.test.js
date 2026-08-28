"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSnapshot,
  parseRemoteRefs,
  serializeCatalog,
  validateCatalog,
  validateSnapshot,
} = require("../catalog");

const SHA_1 = "1111111111111111111111111111111111111111";
const SHA_2 = "2222222222222222222222222222222222222222";
const SHA_3 = "3333333333333333333333333333333333333333";
const SHA_4 = "4444444444444444444444444444444444444444";

function manifest(
  repository = "https://github.com/owner/package.git",
  version = "2.0.0",
) {
  return {
    name: "sample-package",
    version,
    description: "A sample package.",
    keywords: ["sample"],
    engines: { lumine: "^1.0.0", node: ">=20" },
    repository,
    license: "MIT",
    readme: "This must not be copied.",
    badges: [{ image: "https://example.test/a.svg" }],
    featured: true,
  };
}

function taggedRefs() {
  return [
    "ref: refs/heads/main\tHEAD",
    `${SHA_1}\tHEAD`,
    `${SHA_1}\trefs/heads/main`,
    `${SHA_1}\trefs/tags/v1.0.0`,
    `${SHA_3}\trefs/tags/v2.0.0`,
    `${SHA_2}\trefs/tags/v2.0.0^{}`,
    `${SHA_4}\trefs/tags/v3.0.0-beta.1`,
  ].join("\n");
}

test("a catalog may remain entirely source-only", () => {
  const entries = [
    "owner/one",
    "owner/two@1.0.0",
    "owner/three~develop",
    `owner/four#${SHA_1}`,
    `owner/upper#${SHA_1.toUpperCase()}`,
    "https://example.test/owner/five.git#branch:next",
  ];
  assert.equal(validateCatalog(entries), entries);
});

test("latest snapshots use the newest stable tag and peeled annotated SHA", () => {
  const snapshot = createSnapshot({
    source: "owner/package",
    refOutput: taggedRefs(),
    manifest: manifest(),
  });
  assert.deepEqual(snapshot.selectedRef, { type: "latest", value: "v2.0.0" });
  assert.equal(snapshot.resolvedSha, SHA_2);
  assert.deepEqual(
    snapshot.refs.tags.map(({ name, version }) => ({ name, version })),
    [
      { name: "v2.0.0", version: "2.0.0" },
      { name: "v1.0.0", version: "1.0.0" },
      { name: "v3.0.0-beta.1", version: "3.0.0-beta.1" },
    ],
  );
  assert.deepEqual(snapshot.refs.latestStable, {
    name: "v2.0.0",
    version: "2.0.0",
    sha: SHA_2,
  });
  assert.equal(Object.hasOwn(snapshot.metadata, "readme"), false);
  assert.equal(Object.hasOwn(snapshot.metadata, "badges"), false);
  assert.equal(Object.hasOwn(snapshot.metadata, "featured"), false);
});

test("latest snapshots without a stable tag select default HEAD", () => {
  const refs = [
    "ref: refs/heads/trunk\tHEAD",
    `${SHA_1}\tHEAD`,
    `${SHA_2}\trefs/tags/v2.0.0-beta.1`,
  ].join("\n");
  const snapshot = createSnapshot({
    source: "owner/package",
    refOutput: refs,
    manifest: manifest(undefined, "1.0.0"),
  });
  assert.deepEqual(snapshot.selectedRef, { type: "default", value: "trunk" });
  assert.equal(snapshot.resolvedSha, SHA_1);
  assert.equal(snapshot.refs.latestStable, null);
});

test("explicit branches, semantic tags, textual tags, and commits resolve exactly", () => {
  const branch = createSnapshot({
    source: "owner/package~develop",
    refOutput: `${SHA_1}\tHEAD\n${SHA_2}\trefs/heads/develop`,
    manifest: manifest(undefined, "1.5.0"),
  });
  assert.deepEqual(branch.selectedRef, { type: "branch", value: "develop" });
  assert.equal(branch.resolvedSha, SHA_2);

  const semanticTag = createSnapshot({
    source: "owner/package@2.0.0",
    refOutput: `${SHA_1}\tHEAD\n${SHA_2}\trefs/tags/v2.0.0`,
    manifest: manifest(),
  });
  assert.deepEqual(semanticTag.selectedRef, { type: "tag", value: "v2.0.0" });

  const textualTag = createSnapshot({
    source: "owner/package@release",
    refOutput: `${SHA_1}\tHEAD\n${SHA_2}\trefs/tags/release`,
    manifest: manifest(undefined, "1.5.0"),
  });
  assert.deepEqual(textualTag.refs.tags, [
    { name: "release", version: null, sha: SHA_2 },
  ]);
  assert.deepEqual(textualTag.selectedRef, { type: "tag", value: "release" });

  const commit = createSnapshot({
    source: `owner/package#${SHA_3}`,
    refOutput: `${SHA_1}\tHEAD`,
    manifest: manifest(undefined, "1.5.0"),
  });
  assert.deepEqual(commit.selectedRef, { type: "commit", value: SHA_3 });
  assert.equal(commit.resolvedSha, SHA_3);
});

test("featured is catalog-owned, true-only, and survives valid snapshots", () => {
  const snapshot = createSnapshot({
    source: "owner/package",
    refOutput: taggedRefs(),
    manifest: manifest(),
    featured: true,
  });
  assert.equal(snapshot.featured, true);
  assert.throws(
    () => validateSnapshot({ ...snapshot, featured: false }),
    /true or omitted/,
  );
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot,
        metadata: { ...snapshot.metadata, featured: true },
      }),
    /unsupported field/,
  );
});

test("snapshot validation rejects incoherent refs and duplicate origins", () => {
  const snapshot = createSnapshot({
    source: "owner/package",
    refOutput: taggedRefs(),
    manifest: manifest(),
  });
  assert.throws(
    () => validateSnapshot({ ...snapshot, resolvedSha: SHA_1 }),
    /inconsistent with latestStable/,
  );
  assert.throws(
    () => validateCatalog([snapshot, "https://github.com/OWNER/package.git"]),
    /Duplicate repository origin/,
  );
});

test("ref parsing rejects oversized output and sorts deterministically", () => {
  const parsed = parseRemoteRefs(taggedRefs());
  assert.equal(parsed.tags[0].name, "v2.0.0");
  assert.throws(
    () => parseRemoteRefs("x".repeat(10 * 1024 * 1024 + 1)),
    /size limit/,
  );
});

test("catalog serialization is stable, indented, newline-terminated, and mixed", () => {
  const snapshot = createSnapshot({
    source: "owner/package",
    refOutput: taggedRefs(),
    manifest: manifest(),
  });
  const first = serializeCatalog(["other/package", snapshot]);
  const second = serializeCatalog(JSON.parse(first));
  assert.equal(second, first);
  assert.match(first, /^\[\n  "other\/package",\n  \{/);
  assert.equal(first.endsWith("\n"), true);
});
