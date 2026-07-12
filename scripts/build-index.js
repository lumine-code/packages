"use strict";

// Builds index.json from sources.json by downloading each package's own
// package.json. Metadata is never stored in this repository — it is fetched
// fresh on every build, so it cannot go stale. Unpinned sources are resolved
// to their highest stable semantic-version tag (matching what the editor
// installs), falling back to the default branch when no such tag exists.
//
//   node scripts/build-index.js              build index.json (network)
//   node scripts/build-index.js --validate   offline checks of sources.json only

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcesPath = path.join(root, "sources.json");
const indexPath = path.join(root, "index.json");
const validateOnly = process.argv.includes("--validate");

// Sources are bare owner/repo only. Tags, commits, and branches are not
// supported — the catalog always tracks each repository's latest release.
const SourcePattern = /^([\w.-]+)\/([\w.-]+)$/;
const NamePattern = /^[a-z0-9][a-z0-9._-]*$/;
const FETCH_CONCURRENCY = 8;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function loadSources() {
  let sources;
  try {
    sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  } catch (error) {
    fail(`sources.json: ${error.message}`);
    return [];
  }
  if (!Array.isArray(sources)) {
    fail("sources.json must be an array of Git sources.");
    return [];
  }

  const seen = new Set();
  for (const source of sources) {
    const match = typeof source === "string" && source.match(SourcePattern);
    if (!match) {
      fail(
        `sources.json: "${source}" must be owner/repo (tags, commits, and branches are not supported).`,
      );
      continue;
    }
    const key = `${match[1]}/${match[2]}`.toLowerCase();
    if (seen.has(key)) fail(`sources.json: duplicate repository "${key}".`);
    seen.add(key);
  }

  const sorted = [...sources].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sorted) !== JSON.stringify(sources)) {
    fail("sources.json must be sorted alphabetically.");
  }

  return sources;
}

const StableTagPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;

function gitLsRemoteTags(owner, repo) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--tags", `https://github.com/${owner}/${repo}.git`],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function compareVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function highestStableTag(lsRemoteOutput) {
  let best = null;
  for (const line of lsRemoteOutput.split("\n")) {
    const match = line.match(/refs\/tags\/([^\s^]+)(\^\{\})?$/);
    if (!match) continue;
    const numbers = match[1].match(StableTagPattern);
    if (!numbers) continue;
    const version = numbers.slice(1, 4).map(Number);
    if (!best || compareVersions(version, best.version) > 0) {
      best = { tag: match[1], version };
    }
  }
  return best ? best.tag : null;
}

async function resolveRef(source) {
  const [, owner, repo] = source.match(SourcePattern);
  try {
    const tag = highestStableTag(await gitLsRemoteTags(owner, repo));
    if (tag) return tag;
  } catch (error) {
    warn(
      `${source}: could not list tags (${error.message}); using the default branch.`,
    );
  }
  return "HEAD";
}

async function fetchPackageMetadata(source) {
  const [, owner, repo] = source.match(SourcePattern);
  const ref = await resolveRef(source);
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/package.json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "lumine-community-packages" },
  });
  if (!response.ok) {
    throw new Error(
      `package.json request failed with status ${response.status}`,
    );
  }
  return response.json();
}

function entryForSource(source, metadata) {
  const [, , repo] = source.match(SourcePattern);
  const name = String(metadata.name || repo).toLowerCase();
  if (!NamePattern.test(name)) {
    throw new Error(`package name "${name}" is not a valid catalog name`);
  }
  return {
    name,
    repository: source,
    ...(typeof metadata.version === "string"
      ? { version: metadata.version }
      : {}),
    description:
      typeof metadata.description === "string" ? metadata.description : "",
    keywords: Array.isArray(metadata.keywords)
      ? metadata.keywords
          .filter((keyword) => typeof keyword === "string")
          .slice(0, 10)
      : [],
    theme:
      metadata.theme === "ui" || metadata.theme === "syntax"
        ? metadata.theme
        : false,
  };
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await callback(items[currentIndex]);
      }
    }),
  );
  return results;
}

function loadPreviousEntries() {
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return new Map(
      (index.packages || []).map((entry) => [entry.repository, entry]),
    );
  } catch {
    return new Map();
  }
}

async function main() {
  const sources = loadSources();
  if (process.exitCode === 1) process.exit();

  if (validateOnly) {
    process.stdout.write(`Validated ${sources.length} sources.\n`);
    return;
  }

  const previous = loadPreviousEntries();
  const entries = await mapLimit(sources, FETCH_CONCURRENCY, async (source) => {
    try {
      return entryForSource(source, await fetchPackageMetadata(source));
    } catch (error) {
      const cached = previous.get(source);
      if (cached) {
        warn(`${source}: ${error.message}; keeping previous metadata.`);
        return cached;
      }
      warn(`${source}: ${error.message}; skipping.`);
      return null;
    }
  });

  // Packages are identified by repository, not name: the same name may be
  // published from different repositories. Only identical repositories are
  // deduplicated (sources.json already enforces this, so it is a safety net).
  const origins = new Set();
  const packages = [];
  for (const entry of entries) {
    if (!entry) continue;
    const originKey = entry.repository.replace(/[@#~].*$/, "").toLowerCase();
    if (origins.has(originKey)) {
      warn(`${entry.repository}: duplicate repository; skipping.`);
      continue;
    }
    origins.add(originKey);
    packages.push(entry);
  }

  // Same name from different repositories is allowed (the editor installs by
  // name, so users pick one), but it is worth flagging: a name overlap is often
  // an accident or a squat. Warn, listing the repositories that share a name.
  const byName = new Map();
  for (const entry of packages) {
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry.repository);
  }
  for (const [name, repos] of byName) {
    if (repos.length > 1) {
      warn(
        `name "${name}" is published from multiple repositories: ${repos.join(", ")}.`,
      );
    }
  }

  packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.repository.localeCompare(right.repository),
  );
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
  process.stdout.write(
    `Generated index.json with ${packages.length} of ${sources.length} package(s).\n`,
  );
}

main();
