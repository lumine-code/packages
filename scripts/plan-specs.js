"use strict";

// Resolve every catalog entry to the ref its spec suite should run against and
// write a plan the spec workflow consumes.
//
// The rule matches what Lumine's installer does with a catalog entry that
// carries no selector (`resolvePackageSource` in the editor's
// `src/package-source.js`): use the newest stable semver tag the repository
// publishes, and fall back to `master` when it has never been tagged. An entry
// that does carry an explicit `@tag`, `~branch`, `#commit` or `#type:value`
// selector is honoured as written, so the plan always tests what the catalog
// actually offers a user.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SELECTOR_TYPES = new Set(["branch", "tag", "commit"]);
// git ls-remote is one network round trip per repository. The catalog holds
// over a hundred, so resolve a few at a time rather than serially.
const CONCURRENCY = 8;
const LS_REMOTE_TIMEOUT_MS = 60000;

function parseArguments(argv) {
  const options = {
    index: path.join(__dirname, "..", "index.json"),
    out: "plan.json",
    resultsOut: "results/unresolved.json",
    shards: 12,
    only: [],
    summary: process.env.GITHUB_STEP_SUMMARY || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--index") options.index = next();
    else if (argument === "--out") options.out = next();
    else if (argument === "--results-out") options.resultsOut = next();
    else if (argument === "--shards") options.shards = Number(next());
    else if (argument === "--only") options.only.push(...splitPatterns(next()));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.shards) || options.shards < 1) {
    throw new Error("--shards must be a positive integer.");
  }
  return options;
}

function splitPatterns(value) {
  return String(value)
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

// The catalog's own grammar, kept deliberately in step with the editor's
// parser so a source that installs resolves here too.
function parseSource(source) {
  const value = String(source).trim();
  const shorthand = /#(?:branch|tag|commit):/i.test(value)
    ? null
    : value.match(/^([\w.-]+\/[\w.-]+)(?:@(.+)|#(.+)|~(.+))?$/i);
  if (shorthand) {
    const [, repository, tag, commit, branch] = shorthand;
    let selector = { type: "latest", value: null };
    if (tag) selector = { type: "tag", value: tag };
    if (commit) selector = { type: "commit", value: commit };
    if (branch) selector = { type: "branch", value: branch };
    return { repository, selector };
  }

  const hash = value.lastIndexOf("#");
  const repository = (hash === -1 ? value : value.slice(0, hash)).trim();
  const fragment = hash === -1 ? "" : value.slice(hash + 1).trim();
  let selector = { type: "latest", value: null };
  if (fragment) {
    const separator = fragment.indexOf(":");
    const type = separator === -1 ? "" : fragment.slice(0, separator).toLowerCase();
    selector = SELECTOR_TYPES.has(type)
      ? { type, value: fragment.slice(separator + 1).trim() }
      : { type: "ref", value: fragment };
  }
  return { repository, selector };
}

function cloneUrlFor(repository) {
  const shorthand = repository.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;
  if (/^https:\/\//i.test(repository)) return repository;
  throw new Error(`Unsupported repository: "${repository}".`);
}

function repositoryName(repository) {
  const segments = repository.replace(/\.git$/i, "").replace(/\/+$/, "").split("/");
  return segments[segments.length - 1];
}

// A local stand-in for `semver.valid`, so the catalog keeps its zero-dependency
// install. Only the shape the release rule produces is accepted: `vX.Y.Z`, with
// an optional prerelease that disqualifies the tag from being "latest".
function parseVersion(tag) {
  const match = String(tag).match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function parseRemoteRefs(output) {
  const refs = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (match) refs.set(match[2].trim(), match[1].toLowerCase());
  }
  return refs;
}

// An annotated tag names a tag object; its peeled `^{}` entry names the commit.
// Prefer the commit, so a recorded SHA is always something `git checkout` lands
// on.
function parseRemoteTags(output) {
  const tags = new Map();
  for (const [ref, sha] of parseRemoteRefs(output)) {
    const match = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/);
    if (!match) continue;
    const [, name, peeled] = match;
    if (!tags.has(name) || peeled) tags.set(name, sha);
  }
  return tags;
}

function defaultBranchOf(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/);
    if (match) return match[1];
  }
  return null;
}

function lsRemote(cloneUrl, flags, patterns) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", ...flags, cloneUrl, ...patterns],
      { timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim().split(/\r?\n/)[0]));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function resolveEntry(source) {
  const { repository, selector } = parseSource(source);
  const cloneUrl = cloneUrlFor(repository);
  const entry = { source, repository, name: repositoryName(repository), cloneUrl };

  if (selector.type === "commit") {
    return { ...entry, ref: selector.value, refType: "commit", sha: selector.value.toLowerCase() };
  }

  if (selector.type === "latest") {
    const tags = parseRemoteTags(await lsRemote(cloneUrl, ["--tags"], []));
    let latest = null;
    for (const [name, sha] of tags) {
      const version = parseVersion(name);
      if (!version || version.prerelease) continue;
      if (!latest || compareVersions(version, latest.version) > 0) latest = { name, sha, version };
    }
    if (latest) return { ...entry, ref: latest.name, refType: "tag", sha: latest.sha };

    // Never tagged: the catalog installs the default branch, and every
    // repository in this organization develops on `master`.
    const output = await lsRemote(cloneUrl, ["--symref"], ["HEAD", "refs/heads/master"]);
    const refs = parseRemoteRefs(output);
    const master = refs.get("refs/heads/master");
    if (master) return { ...entry, ref: "master", refType: "branch", sha: master };
    const branch = defaultBranchOf(output);
    if (!branch) throw new Error("The repository publishes neither a semver tag nor a HEAD.");
    return { ...entry, ref: branch, refType: "branch", sha: refs.get("HEAD") || null };
  }

  // An explicit selector. Resolve it to a SHA so the plan records exactly what
  // ran, and so a ref that no longer exists fails here rather than mid-shard.
  const name = selector.value;
  const refs = parseRemoteRefs(
    await lsRemote(
      cloneUrl,
      [],
      [`refs/tags/${name}`, `refs/tags/${name}^{}`, `refs/heads/${name}`],
    ),
  );
  const tagSha = refs.get(`refs/tags/${name}^{}`) || refs.get(`refs/tags/${name}`);
  const branchSha = refs.get(`refs/heads/${name}`);
  if (selector.type === "tag" || (selector.type === "ref" && tagSha)) {
    if (!tagSha) throw new Error(`Tag "${name}" was not found.`);
    return { ...entry, ref: name, refType: "tag", sha: tagSha };
  }
  if (selector.type === "branch" || (selector.type === "ref" && branchSha)) {
    if (!branchSha) throw new Error(`Branch "${name}" was not found.`);
    return { ...entry, ref: name, refType: "branch", sha: branchSha };
  }
  if (/^[0-9a-f]{7,40}$/i.test(name)) {
    return { ...entry, ref: name, refType: "commit", sha: name.toLowerCase() };
  }
  throw new Error(`Ref "${name}" was not found.`);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(patterns, source) {
  const name = repositoryName(parseSource(source).repository);
  return patterns.some((pattern) => {
    const matcher = globToRegExp(pattern);
    return matcher.test(name) || matcher.test(source);
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function writeSummary(summaryPath, lines) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sources = JSON.parse(fs.readFileSync(options.index, "utf8")).map((source) =>
    String(source).trim(),
  );

  const selected =
    options.only.length > 0
      ? sources.filter((source) => matchesAny(options.only, source))
      : sources;

  const resolutions = await mapWithConcurrency(selected, CONCURRENCY, async (source) => {
    try {
      const resolved = await resolveEntry(source);
      process.stdout.write(`${resolved.name} → ${resolved.refType} ${resolved.ref}\n`);
      return resolved;
    } catch (error) {
      process.stderr.write(`${source}: ${error.message}\n`);
      return { source, name: repositoryName(parseSource(source).repository), error: error.message };
    }
  });

  const packages = resolutions.filter((entry) => !entry.error);
  const unresolved = resolutions.filter((entry) => entry.error);
  packages.sort((left, right) => left.name.localeCompare(right.name));

  // Round-robin rather than contiguous slices: adjacent catalog entries are
  // alphabetical, so a family of heavy suites would otherwise land in one shard.
  const shards = Math.min(options.shards, Math.max(packages.length, 1));
  packages.forEach((entry, index) => {
    entry.shard = index % shards;
  });

  const plan = { shards, packages, unresolved };
  fs.writeFileSync(options.out, `${JSON.stringify(plan, null, 2)}\n`);

  // An entry whose ref cannot be resolved is a catalog bug, but it must not
  // stop the other hundred packages from being tested. Report it in the same
  // shape a shard reports a failure, and let the summary job fail the run.
  if (unresolved.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(options.resultsOut)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.resultsOut),
      `${JSON.stringify(
        {
          shard: "plan",
          results: unresolved.map((entry) => ({
            name: entry.name,
            source: entry.source,
            ref: null,
            sha: null,
            status: "error",
            message: `unresolved: ${entry.error}`,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  writeOutput("count", packages.length);
  writeOutput("shards", JSON.stringify(Array.from({ length: shards }, (unused, index) => index)));
  writeSummary(options.summary, [
    "## Resolved refs",
    "",
    "| Package | Ref | Kind | Commit |",
    "| --- | --- | --- | --- |",
    ...packages.map(
      (entry) =>
        `| ${entry.name} | \`${entry.ref}\` | ${entry.refType} | ` +
        `\`${(entry.sha || "").slice(0, 12)}\` |`,
    ),
    ...(unresolved.length > 0
      ? [
          "",
          "### Unresolved",
          "",
          ...unresolved.map((entry) => `- \`${entry.source}\` — ${entry.error}`),
        ]
      : []),
    "",
  ]);

  process.stdout.write(`Planned ${packages.length} packages across ${shards} shards.\n`);
  for (const entry of unresolved) {
    process.stdout.write(`::error title=${entry.name}::${entry.error}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
