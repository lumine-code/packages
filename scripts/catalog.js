"use strict";

const net = require("net");
const semver = require("semver");

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_REPOSITORIES = 2000;
const MAX_REMOTE_REFS = 10000;
const MAX_REMOTE_OUTPUT_BYTES = 10 * 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SELECTOR_TYPES = new Set(["branch", "tag", "commit"]);
const RESOLVED_SELECTOR_TYPES = new Set([
  "latest",
  "default",
  "branch",
  "tag",
  "commit",
]);
const SNAPSHOT_KEYS = new Set([
  "source",
  "featured",
  "resolvedSha",
  "selectedRef",
  "refs",
  "metadata",
]);
const SELECTED_REF_KEYS = new Set(["type", "value"]);
const REFS_KEYS = new Set(["defaultBranch", "headSha", "latestStable", "tags"]);
const TAG_KEYS = new Set(["name", "version", "sha"]);
const METADATA_KEYS = [
  "name",
  "version",
  "description",
  "keywords",
  "engines",
  "repository",
  "theme",
  "themes",
  "license",
  "licenses",
  "bugs",
  "homepage",
];
const METADATA_KEY_SET = new Set(METADATA_KEYS);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, keys, context) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw new Error(`${context} contains unsupported field "${key}".`);
  }
}

function validRepositorySegment(value) {
  return !!value && value !== "." && value !== "..";
}

function githubShorthandMatch(value) {
  const match = String(value || "").match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return match &&
    validRepositorySegment(match[1]) &&
    validRepositorySegment(match[2])
    ? match
    : null;
}

function parsePackageSource(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("A package repository is required.");

  const shorthandCandidate = /#(?:branch|tag|commit):/i.test(value)
    ? null
    : value.match(/^([\w.-]+\/[\w.-]+)(?:@(.+)|#(.+)|~(.+))?$/i);
  const shorthand =
    shorthandCandidate &&
    shorthandCandidate[1].split("/").every(validRepositorySegment)
      ? shorthandCandidate
      : null;
  if (shorthand) {
    const [, repository, tag, commit, branch] = shorthand;
    let selector = { type: "latest", value: null };
    if (tag) selector = { type: "tag", value: tag };
    if (commit) selector = { type: "commit", value: commit };
    if (branch) selector = { type: "branch", value: branch };
    return { repository, selector, source: value };
  }

  const hashIndex = value.lastIndexOf("#");
  const repository = (
    hashIndex === -1 ? value : value.slice(0, hashIndex)
  ).trim();
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex + 1).trim();
  if (!repository) throw new Error(`Invalid package repository: "${input}".`);

  let selector = { type: "latest", value: null };
  if (fragment) {
    const separator = fragment.indexOf(":");
    const possibleType =
      separator === -1 ? "" : fragment.slice(0, separator).toLowerCase();
    if (SELECTOR_TYPES.has(possibleType)) {
      const selectorValue = fragment.slice(separator + 1).trim();
      if (!selectorValue)
        throw new Error(`The ${possibleType} selector must include a value.`);
      selector = { type: possibleType, value: selectorValue };
    } else {
      selector = { type: "ref", value: fragment };
    }
  }
  return { repository, selector, source: value };
}

function cloneUrlForRepository(repository) {
  const shorthand = githubShorthandMatch(repository);
  if (shorthand)
    return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;
  if (/^https:\/\//i.test(repository)) return repository;
  throw new Error(
    "Catalog package sources must use public HTTPS or GitHub owner/repo shorthand.",
  );
}

function isPrivateAddress(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const family = net.isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224
    );
  }
  if (family === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    );
  }
  return false;
}

function normalizeRepositoryOrigin(repository) {
  let value = repository;
  if (isPlainObject(repository) && typeof repository.url === "string")
    value = repository.url;
  value = String(value || "").trim();
  if (!value) return "";

  let bare;
  try {
    bare = parsePackageSource(value).repository;
  } catch {
    bare = value;
  }
  bare = bare.replace(/^git\+/i, "").replace(/\/+$/, "");

  const shorthand = githubShorthandMatch(bare);
  if (shorthand) {
    return `github.com/${shorthand[1].toLowerCase()}/${shorthand[2].toLowerCase()}`;
  }
  const hosted = bare.match(/^github:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (hosted) return `github.com/${hosted[1].toLowerCase()}`;
  const scp = bare.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (scp && !/^[a-z][a-z\d+.-]*:\/\//i.test(bare)) {
    const host = scp[1].toLowerCase();
    let pathname = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (host === "github.com") pathname = pathname.toLowerCase();
    return host && pathname ? `${host}/${pathname}` : "";
  }

  let url;
  try {
    url = new URL(bare);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  let pathname = decodeURIComponent(url.pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (host === "github.com") pathname = pathname.toLowerCase();
  const canonicalHost = host.includes(":") ? `[${host}]` : host;
  return host && pathname
    ? `${canonicalHost}${url.port ? `:${url.port}` : ""}/${pathname}`
    : "";
}

function assertSafePackageSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Package source must be a non-empty string.");
  }
  const parsed = parsePackageSource(source);
  if (
    parsed.selector.type === "commit" &&
    !SOURCE_SHA_PATTERN.test(parsed.selector.value)
  ) {
    throw new Error("Commit selectors must use a complete 40-character SHA.");
  }
  if (
    parsed.selector.type === "ref" &&
    !SOURCE_SHA_PATTERN.test(parsed.selector.value)
  ) {
    throw new Error(
      "Generic URL fragments must use a complete 40-character SHA.",
    );
  }

  const shorthand = githubShorthandMatch(parsed.repository);
  if (!shorthand) {
    if (!/^https:\/\//i.test(parsed.repository)) {
      throw new Error(
        "Catalog package sources must use public HTTPS or GitHub owner/repo shorthand.",
      );
    }
    const url = new URL(parsed.repository);
    if (url.username || url.password) {
      throw new Error("Catalog package sources must not contain credentials.");
    }
    if (isPrivateAddress(url.hostname)) {
      throw new Error(
        "Catalog package sources must not target localhost or a private network.",
      );
    }
  }
  const originKey = normalizeRepositoryOrigin(parsed.repository);
  if (!originKey) throw new Error(`Invalid Git repository: "${source}".`);
  return {
    ...parsed,
    originKey,
    cloneUrl: cloneUrlForRepository(parsed.repository),
  };
}

function tagNamesForSelector(value) {
  return value.toLowerCase().startsWith("v") ? [value] : [value, `v${value}`];
}

function parseRemoteRefs(output, explicitTagNames = []) {
  const body = String(output || "");
  if (Buffer.byteLength(body) > MAX_REMOTE_OUTPUT_BYTES) {
    throw new Error("Repository ref response exceeds the safety size limit.");
  }
  const tags = new Map();
  const branches = new Map();
  let defaultBranch = null;
  let headSha = null;
  for (const line of body.split(/\r?\n/)) {
    const symref = line.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/);
    if (symref) {
      defaultBranch = symref[1];
      continue;
    }
    const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (!match) continue;
    const sha = match[1].toLowerCase();
    const ref = match[2];
    if (ref === "HEAD") {
      headSha = sha;
      continue;
    }
    const tag = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/);
    if (tag) {
      const current = tags.get(tag[1]);
      if (!current || tag[2]) tags.set(tag[1], sha);
      continue;
    }
    const branch = ref.match(/^refs\/heads\/(.+)$/);
    if (branch) branches.set(branch[1], sha);
  }
  const explicit = new Set(explicitTagNames);
  const semanticTags = [];
  for (const [name, sha] of tags) {
    const version = semver.valid(name);
    if (version || explicit.has(name))
      semanticTags.push({ name, version: version || null, sha });
  }
  const stable = semanticTags.filter(
    (tag) => tag.version && semver.prerelease(tag.version) == null,
  );
  const prerelease = semanticTags.filter(
    (tag) => tag.version && semver.prerelease(tag.version) != null,
  );
  const textual = semanticTags.filter((tag) => tag.version == null);
  const compareSemver = (left, right) =>
    semver.rcompare(left.version, right.version) ||
    left.name.localeCompare(right.name);
  stable.sort(compareSemver);
  prerelease.sort(compareSemver);
  textual.sort((left, right) => left.name.localeCompare(right.name));
  const sortedTags = [...stable, ...prerelease, ...textual];
  if (tags.size + branches.size > MAX_REMOTE_REFS) {
    throw new Error(
      `Repository exposes more than ${MAX_REMOTE_REFS} relevant refs.`,
    );
  }
  return {
    defaultBranch,
    headSha,
    latestStable: stable[0] || null,
    tags: sortedTags,
    branches,
  };
}

function resolveSelectedRef(parsed, refs) {
  const { selector } = parsed;
  if (selector.type === "latest") {
    if (refs.latestStable) {
      return {
        selectedRef: { type: "latest", value: refs.latestStable.name },
        resolvedSha: refs.latestStable.sha,
      };
    }
    if (!refs.headSha)
      throw new Error("Repository does not expose HEAD or a stable tag.");
    return {
      selectedRef: { type: "default", value: refs.defaultBranch || "HEAD" },
      resolvedSha: refs.headSha,
    };
  }
  if (selector.type === "commit") {
    return {
      selectedRef: { type: "commit", value: selector.value.toLowerCase() },
      resolvedSha: selector.value.toLowerCase(),
    };
  }
  if (selector.type === "tag") {
    const tag = refs.tags.find((candidate) =>
      tagNamesForSelector(selector.value).includes(candidate.name),
    );
    if (!tag) throw new Error(`Tag "${selector.value}" was not found.`);
    return {
      selectedRef: { type: "tag", value: tag.name },
      resolvedSha: tag.sha,
    };
  }
  if (selector.type === "branch") {
    const sha = refs.branches.get(selector.value);
    if (!sha) throw new Error(`Branch "${selector.value}" was not found.`);
    return {
      selectedRef: { type: "branch", value: selector.value },
      resolvedSha: sha,
    };
  }
  if (selector.type === "ref") {
    const tag = refs.tags.find((candidate) =>
      tagNamesForSelector(selector.value).includes(candidate.name),
    );
    if (tag)
      return {
        selectedRef: { type: "tag", value: tag.name },
        resolvedSha: tag.sha,
      };
    const branchSha = refs.branches.get(selector.value);
    if (branchSha) {
      return {
        selectedRef: { type: "branch", value: selector.value },
        resolvedSha: branchSha,
      };
    }
    if (SOURCE_SHA_PATTERN.test(selector.value)) {
      return {
        selectedRef: { type: "commit", value: selector.value.toLowerCase() },
        resolvedSha: selector.value.toLowerCase(),
      };
    }
  }
  throw new Error(`Ref "${selector.value}" was not found.`);
}

function repositoryValue(repository) {
  if (typeof repository === "string") return repository;
  if (isPlainObject(repository) && typeof repository.url === "string")
    return repository.url;
  return "";
}

function semanticTagForSelection(selectedRef, tags) {
  if (selectedRef.type !== "latest" && selectedRef.type !== "tag") return null;
  return (
    tags.find((tag) => tag.name === selectedRef.value && tag.version) || null
  );
}

function validateMetadata(metadata, originKey, selectedRef = null, tags = []) {
  if (!isPlainObject(metadata))
    throw new Error("Snapshot metadata must be an object.");
  assertAllowedKeys(metadata, METADATA_KEY_SET, "Snapshot metadata");
  if (
    typeof metadata.name !== "string" ||
    !PACKAGE_NAME_PATTERN.test(metadata.name)
  ) {
    throw new Error(
      "Snapshot metadata must contain a valid lowercase package name.",
    );
  }
  if (typeof metadata.version !== "string" || !semver.valid(metadata.version)) {
    throw new Error("Snapshot metadata must contain a valid semantic version.");
  }
  const repository = repositoryValue(metadata.repository);
  const metadataOrigin = normalizeRepositoryOrigin(repository);
  if (!metadataOrigin || metadataOrigin !== originKey) {
    throw new Error(
      `Package repository origin "${metadataOrigin || repository || "missing"}" does not match "${originKey}".`,
    );
  }
  if (
    !isPlainObject(metadata.engines) ||
    typeof metadata.engines.lumine !== "string" ||
    !semver.validRange(metadata.engines.lumine)
  ) {
    throw new Error(
      'Snapshot metadata must contain a valid "engines.lumine" range.',
    );
  }
  if (
    metadata.description != null &&
    typeof metadata.description !== "string"
  ) {
    throw new Error("Snapshot description must be a string.");
  }
  if (
    metadata.keywords != null &&
    (!Array.isArray(metadata.keywords) ||
      metadata.keywords.some((keyword) => typeof keyword !== "string"))
  ) {
    throw new Error("Snapshot keywords must be an array of strings.");
  }
  if (selectedRef) {
    const selectedTag = semanticTagForSelection(selectedRef, tags);
    if (selectedTag && !semver.eq(selectedTag.version, metadata.version)) {
      throw new Error(
        `Selected tag "${selectedTag.name}" does not match package version "${metadata.version}".`,
      );
    }
  }
  return metadata;
}

function copyJsonValue(value, field) {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error(`Manifest field "${field}" is not serializable.`);
  return JSON.parse(serialized);
}

function reduceMetadata(manifest, originKey, selectedRef, tags) {
  if (!isPlainObject(manifest))
    throw new Error("Package manifest must contain an object.");
  const metadata = {};
  for (const key of METADATA_KEYS) {
    if (Object.hasOwn(manifest, key))
      metadata[key] = copyJsonValue(manifest[key], key);
  }
  validateMetadata(metadata, originKey, selectedRef, tags);
  return metadata;
}

function validateTag(tag, index, context) {
  if (!isPlainObject(tag))
    throw new Error(`${context} tag ${index + 1} must be an object.`);
  assertAllowedKeys(tag, TAG_KEYS, `${context} tag ${index + 1}`);
  if (typeof tag.name !== "string" || !tag.name) {
    throw new Error(`${context} tag ${index + 1} must have a name.`);
  }
  if (!SHA_PATTERN.test(tag.sha || "")) {
    throw new Error(
      `${context} tag "${tag.name}" must have a lowercase full SHA.`,
    );
  }
  const normalized = semver.valid(tag.name);
  if (tag.version !== normalized) {
    throw new Error(
      `${context} tag "${tag.name}" has an inconsistent semantic version.`,
    );
  }
  return tag;
}

function expectedTagOrder(tags) {
  const stable = tags.filter(
    (tag) => tag.version && semver.prerelease(tag.version) == null,
  );
  const prerelease = tags.filter(
    (tag) => tag.version && semver.prerelease(tag.version) != null,
  );
  const textual = tags.filter((tag) => tag.version == null);
  const compareSemver = (left, right) =>
    semver.rcompare(left.version, right.version) ||
    left.name.localeCompare(right.name);
  return [
    ...stable.sort(compareSemver),
    ...prerelease.sort(compareSemver),
    ...textual.sort((left, right) => left.name.localeCompare(right.name)),
  ];
}

function validateSnapshot(snapshot, entryIndex = null) {
  const context =
    entryIndex == null ? "Catalog snapshot" : `Catalog entry ${entryIndex + 1}`;
  if (!isPlainObject(snapshot))
    throw new Error(`${context} must be a string or snapshot object.`);
  assertAllowedKeys(snapshot, SNAPSHOT_KEYS, context);
  const parsed = assertSafePackageSource(snapshot.source);
  if (Object.hasOwn(snapshot, "featured") && snapshot.featured !== true) {
    throw new Error(`${context} featured flag must be true or omitted.`);
  }
  if (!SHA_PATTERN.test(snapshot.resolvedSha || "")) {
    throw new Error(`${context} resolvedSha must be a lowercase full SHA.`);
  }
  if (!isPlainObject(snapshot.selectedRef)) {
    throw new Error(`${context} selectedRef must be an object.`);
  }
  assertAllowedKeys(
    snapshot.selectedRef,
    SELECTED_REF_KEYS,
    `${context} selectedRef`,
  );
  if (
    !RESOLVED_SELECTOR_TYPES.has(snapshot.selectedRef.type) ||
    typeof snapshot.selectedRef.value !== "string" ||
    !snapshot.selectedRef.value
  ) {
    throw new Error(`${context} selectedRef is invalid.`);
  }
  if (
    snapshot.selectedRef.type === "commit" &&
    !SHA_PATTERN.test(snapshot.selectedRef.value)
  ) {
    throw new Error(`${context} selected commit must be a lowercase full SHA.`);
  }
  if (!isPlainObject(snapshot.refs))
    throw new Error(`${context} refs must be an object.`);
  assertAllowedKeys(snapshot.refs, REFS_KEYS, `${context} refs`);
  if (
    snapshot.refs.defaultBranch !== null &&
    (typeof snapshot.refs.defaultBranch !== "string" ||
      !snapshot.refs.defaultBranch)
  ) {
    throw new Error(
      `${context} defaultBranch must be a non-empty string or null.`,
    );
  }
  if (
    snapshot.refs.headSha !== null &&
    !SHA_PATTERN.test(snapshot.refs.headSha || "")
  ) {
    throw new Error(`${context} headSha must be a lowercase full SHA or null.`);
  }
  if (!Array.isArray(snapshot.refs.tags))
    throw new Error(`${context} tags must be an array.`);
  if (snapshot.refs.tags.length > MAX_REMOTE_REFS) {
    throw new Error(`${context} exceeds the ${MAX_REMOTE_REFS}-tag limit.`);
  }
  snapshot.refs.tags.forEach((tag, index) => validateTag(tag, index, context));
  const names = new Set();
  for (const tag of snapshot.refs.tags) {
    if (names.has(tag.name))
      throw new Error(`${context} contains duplicate tag "${tag.name}".`);
    names.add(tag.name);
  }
  const orderedNames = expectedTagOrder([...snapshot.refs.tags]).map(
    (tag) => tag.name,
  );
  if (
    orderedNames.some((name, index) => name !== snapshot.refs.tags[index].name)
  ) {
    throw new Error(
      `${context} tags are not in deterministic semantic-version order.`,
    );
  }
  const stable = snapshot.refs.tags.find(
    (tag) => tag.version && semver.prerelease(tag.version) == null,
  );
  if (snapshot.refs.latestStable === null) {
    if (stable) throw new Error(`${context} latestStable is missing.`);
  } else {
    validateTag(snapshot.refs.latestStable, 0, `${context} latestStable`);
    if (
      !stable ||
      snapshot.refs.latestStable.name !== stable.name ||
      snapshot.refs.latestStable.version !== stable.version ||
      snapshot.refs.latestStable.sha !== stable.sha
    ) {
      throw new Error(
        `${context} latestStable does not match the newest stable tag.`,
      );
    }
  }
  const textualTags = snapshot.refs.tags.filter((tag) => tag.version === null);
  if (
    textualTags.some(
      (tag) =>
        snapshot.selectedRef.type !== "tag" ||
        snapshot.selectedRef.value !== tag.name,
    )
  ) {
    throw new Error(
      `${context} may retain only its explicitly selected non-semver tag.`,
    );
  }

  const selected = snapshot.selectedRef;
  const requested = parsed.selector;
  const selectedTag = snapshot.refs.tags.find(
    (tag) => tag.name === selected.value,
  );
  if (requested.type === "latest") {
    if (snapshot.refs.latestStable) {
      if (
        selected.type !== "latest" ||
        selected.value !== snapshot.refs.latestStable.name ||
        snapshot.resolvedSha !== snapshot.refs.latestStable.sha
      ) {
        throw new Error(
          `${context} latest selection is inconsistent with latestStable.`,
        );
      }
    } else if (
      selected.type !== "default" ||
      selected.value !== (snapshot.refs.defaultBranch || "HEAD") ||
      !snapshot.refs.headSha ||
      snapshot.resolvedSha !== snapshot.refs.headSha
    ) {
      throw new Error(
        `${context} default selection is inconsistent with HEAD.`,
      );
    }
  } else if (requested.type === "tag") {
    if (
      selected.type !== "tag" ||
      !tagNamesForSelector(requested.value).includes(selected.value) ||
      !selectedTag ||
      snapshot.resolvedSha !== selectedTag.sha
    ) {
      throw new Error(
        `${context} tag selection is inconsistent with its source.`,
      );
    }
  } else if (requested.type === "branch") {
    if (selected.type !== "branch" || selected.value !== requested.value) {
      throw new Error(
        `${context} branch selection is inconsistent with its source.`,
      );
    }
    if (
      requested.value === snapshot.refs.defaultBranch &&
      snapshot.refs.headSha &&
      snapshot.resolvedSha !== snapshot.refs.headSha
    ) {
      throw new Error(
        `${context} default branch SHA is inconsistent with HEAD.`,
      );
    }
  } else {
    const requestedSha = requested.value.toLowerCase();
    if (
      selected.type !== "commit" ||
      selected.value !== requestedSha ||
      snapshot.resolvedSha !== requestedSha
    ) {
      throw new Error(
        `${context} commit selection is inconsistent with its source.`,
      );
    }
  }
  validateMetadata(
    snapshot.metadata,
    parsed.originKey,
    selected,
    snapshot.refs.tags,
  );
  return { ...parsed, snapshot };
}

function validateCatalog(entries) {
  if (!Array.isArray(entries))
    throw new Error("index.json must be an array of package entries.");
  if (entries.length > MAX_REPOSITORIES) {
    throw new Error(
      `index.json exceeds the ${MAX_REPOSITORIES}-repository limit.`,
    );
  }
  const origins = new Set();
  for (const [index, entry] of entries.entries()) {
    let parsed;
    try {
      parsed =
        typeof entry === "string"
          ? assertSafePackageSource(entry)
          : validateSnapshot(entry, index);
    } catch (error) {
      if (String(error.message).startsWith(`Catalog entry ${index + 1}`))
        throw error;
      throw new Error(`Catalog entry ${index + 1}: ${error.message}`);
    }
    if (origins.has(parsed.originKey)) {
      throw new Error(`Duplicate repository origin: ${parsed.originKey}.`);
    }
    origins.add(parsed.originKey);
  }
  return entries;
}

function createSnapshot({ source, refOutput, manifest, featured = false }) {
  const parsed = assertSafePackageSource(source);
  const requestedTags =
    parsed.selector.type === "tag" || parsed.selector.type === "ref"
      ? tagNamesForSelector(parsed.selector.value)
      : [];
  const refs = parseRemoteRefs(refOutput, requestedTags);
  const { selectedRef, resolvedSha } = resolveSelectedRef(parsed, refs);
  const metadata = reduceMetadata(
    manifest,
    parsed.originKey,
    selectedRef,
    refs.tags,
  );
  const snapshot = {
    source: parsed.source,
    ...(featured ? { featured: true } : {}),
    resolvedSha,
    selectedRef,
    refs: {
      defaultBranch: refs.defaultBranch,
      headSha: refs.headSha,
      latestStable: refs.latestStable,
      tags: refs.tags,
    },
    metadata,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

function serializeCatalog(entries) {
  validateCatalog(entries);
  const body = `${JSON.stringify(entries, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_CATALOG_BYTES) {
    throw new Error(`index.json exceeds the ${MAX_CATALOG_BYTES}-byte limit.`);
  }
  return body;
}

module.exports = {
  MAX_CATALOG_BYTES,
  MAX_REPOSITORIES,
  MAX_REMOTE_OUTPUT_BYTES,
  MAX_REMOTE_REFS,
  METADATA_KEYS,
  SHA_PATTERN,
  assertSafePackageSource,
  cloneUrlForRepository,
  createSnapshot,
  isPrivateAddress,
  normalizeRepositoryOrigin,
  parsePackageSource,
  parseRemoteRefs,
  reduceMetadata,
  resolveSelectedRef,
  serializeCatalog,
  tagNamesForSelector,
  validateCatalog,
  validateSnapshot,
};
