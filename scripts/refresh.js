"use strict";

const dns = require("dns");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const CSON = require("@lumine-code/season");
const JSONC = require("jsonc-parser");
const {
  MAX_CATALOG_BYTES,
  MAX_REMOTE_OUTPUT_BYTES,
  assertSafePackageSource,
  createSnapshot,
  isPrivateAddress,
  parseRemoteRefs,
  resolveSelectedRef,
  serializeCatalog,
  tagNamesForSelector,
  validateCatalog,
} = require("./catalog");

const execFileAsync = promisify(execFile);
const indexPath = path.join(__dirname, "..", "index.json");
const CONCURRENCY = 8;
const GIT_REF_TIMEOUT = 30000;
const GIT_FETCH_TIMEOUT = 60000;
const REQUEST_TIMEOUT = 15000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const RETRY_ATTEMPTS = 3;
const MANIFEST_FILENAMES = ["package.json", "package.jsonc", "package.cson"];

class TaskQueue {
  constructor(limit, perKeyLimit = limit) {
    this.limit = limit;
    this.perKeyLimit = perKeyLimit;
    this.active = 0;
    this.activeByKey = new Map();
    this.pending = [];
  }

  add(task, key = "default") {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, key, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.limit) {
      const index = this.pending.findIndex(
        ({ key }) => (this.activeByKey.get(key) || 0) < this.perKeyLimit,
      );
      if (index === -1) return;
      const item = this.pending.splice(index, 1)[0];
      this.active++;
      this.activeByKey.set(item.key, (this.activeByKey.get(item.key) || 0) + 1);
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          const activeForKey = (this.activeByKey.get(item.key) || 1) - 1;
          if (activeForKey) this.activeByKey.set(item.key, activeForKey);
          else this.activeByKey.delete(item.key);
          this.drain();
        });
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry(task, { attempts = RETRY_ATTEMPTS, wait = delay } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === attempts) throw error;
      await wait(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function runGit(args, { cwd, timeoutMs = GIT_REF_TIMEOUT } = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_REMOTE_OUTPUT_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

const publicHostnameChecks = new Map();

async function assertPublicHostname(hostname, lookup = dns.promises.lookup) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host))
    throw new Error(`Refusing private host "${host}".`);
  if (net.isIP(host)) return;
  let pending = publicHostnameChecks.get(host.toLowerCase());
  if (!pending) {
    pending = Promise.resolve(lookup(host, { all: true })).then((addresses) => {
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new Error(`Host "${host}" did not resolve.`);
      }
      for (const address of addresses) {
        if (isPrivateAddress(address.address)) {
          throw new Error(`Host "${host}" resolves to a private address.`);
        }
      }
    });
    publicHostnameChecks.set(host.toLowerCase(), pending);
  }
  try {
    await pending;
  } catch (error) {
    publicHostnameChecks.delete(host.toLowerCase());
    throw error;
  }
}

async function responseText(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error(`Response exceeds the ${maxBytes}-byte limit.`);
    error.retryable = false;
    throw error;
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) {
      const error = new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      error.retryable = false;
      throw error;
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      const error = new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      error.retryable = false;
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestText(
  initialUrl,
  {
    allowNotFound = false,
    assertHostname = assertPublicHostname,
    fetchImpl = (...args) => fetch(...args),
    maxBytes = MAX_MANIFEST_BYTES,
    timeoutMs = REQUEST_TIMEOUT,
  } = {},
) {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:") {
      const error = new Error("Manifest URLs must use HTTPS.");
      error.retryable = false;
      throw error;
    }
    await assertHostname(url.hostname);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.href, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "user-agent": "lumine-packages-refresh" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          const error = new Error(
            `HTTP ${response.status} without a redirect location.`,
          );
          error.retryable = false;
          throw error;
        }
        url = new URL(location, url);
        continue;
      }
      if (response.status === 404 && allowNotFound) return null;
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(
          `HTTP ${response.status} while fetching ${url.href}.`,
        );
        error.retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw error;
      }
      return await responseText(response, maxBytes);
    } finally {
      clearTimeout(timeout);
    }
  }
  const error = new Error(`Too many redirects while fetching ${initialUrl}.`);
  error.retryable = false;
  throw error;
}

function parseManifestBody(filename, body) {
  if (path.extname(filename).toLowerCase() === ".cson") return CSON.parse(body);
  const errors = [];
  const parsed = JSONC.parse(body, errors, { allowTrailingComma: true });
  if (errors.length) {
    const lines = body.slice(0, errors[0].offset).split("\n");
    throw new SyntaxError(
      `Syntax error on line ${lines.length}, column ${lines[lines.length - 1].length + 1}: ${JSONC.printParseErrorCode(errors[0].error)}`,
    );
  }
  return parsed;
}

function githubRepositoryPath(parsed) {
  if (!parsed.originKey.startsWith("github.com/")) return null;
  if (parsed.repository.includes("/")) {
    const shorthand = parsed.repository.match(
      /^([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
    );
    if (shorthand) return shorthand[1];
    try {
      const url = new URL(parsed.repository);
      return url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    } catch {}
  }
  return parsed.originKey.slice("github.com/".length);
}

async function fetchGithubManifest(parsed, sha, options = {}) {
  const repositoryPath = githubRepositoryPath(parsed);
  let lastError;
  for (const filename of MANIFEST_FILENAMES) {
    const url = `https://raw.githubusercontent.com/${repositoryPath}/${sha}/${filename}`;
    try {
      const body = await retry(() =>
        requestText(url, {
          allowNotFound: true,
          assertHostname: options.assertHostname,
          fetchImpl: options.fetchImpl,
          maxBytes: MAX_MANIFEST_BYTES,
        }),
      );
      if (body == null) continue;
      return parseManifestBody(filename, body);
    } catch (error) {
      lastError = error;
      if (error instanceof SyntaxError) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(
    "Repository does not contain package.json, package.jsonc, or package.cson.",
  );
}

async function fetchGitManifest(parsed, sha, { run = runGit } = {}) {
  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "lumine-catalog-"),
  );
  try {
    await run(["init"], {
      cwd: temporaryDirectory,
      timeoutMs: GIT_REF_TIMEOUT,
    });
    await run(["remote", "add", "origin", parsed.cloneUrl], {
      cwd: temporaryDirectory,
      timeoutMs: GIT_REF_TIMEOUT,
    });
    await retry(() =>
      run(["fetch", "--depth", "1", "origin", sha], {
        cwd: temporaryDirectory,
        timeoutMs: GIT_FETCH_TIMEOUT,
      }),
    );
    let lastError;
    for (const filename of MANIFEST_FILENAMES) {
      try {
        const body = await run(["show", `FETCH_HEAD:${filename}`], {
          cwd: temporaryDirectory,
          timeoutMs: GIT_REF_TIMEOUT,
        });
        if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) {
          throw new Error(
            `Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`,
          );
        }
        return parseManifestBody(filename, body);
      } catch (error) {
        lastError = error;
      }
    }
    throw (
      lastError ||
      new Error("Repository does not contain a supported package manifest.")
    );
  } finally {
    const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
    const resolvedTemporaryRoot = path.resolve(os.tmpdir());
    if (
      resolvedTemporaryDirectory.startsWith(
        `${resolvedTemporaryRoot}${path.sep}`,
      )
    ) {
      await fs.promises.rm(resolvedTemporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}

async function listRefs(
  parsed,
  { assertHostname = assertPublicHostname, run = runGit } = {},
) {
  const host = parsed.originKey.startsWith("github.com/")
    ? "github.com"
    : new URL(parsed.repository).hostname;
  await assertHostname(host);
  const patterns = ["HEAD", "refs/tags/*"];
  if (parsed.selector.type === "branch" || parsed.selector.type === "ref") {
    patterns.push(`refs/heads/${parsed.selector.value}`);
  }
  return retry(() =>
    run(["ls-remote", "--symref", parsed.cloneUrl, ...patterns], {
      timeoutMs: GIT_REF_TIMEOUT,
    }),
  );
}

async function fetchManifest(parsed, sha, options = {}) {
  if (parsed.originKey.startsWith("github.com/")) {
    return fetchGithubManifest(parsed, sha, options);
  }
  return fetchGitManifest(parsed, sha, options);
}

async function scrapeSource(
  source,
  {
    featured = false,
    fetchManifestImpl = fetchManifest,
    listRefsImpl = listRefs,
  } = {},
) {
  const parsed = assertSafePackageSource(source);
  const refOutput = await listRefsImpl(parsed);
  const requestedTags =
    parsed.selector.type === "tag" || parsed.selector.type === "ref"
      ? tagNamesForSelector(parsed.selector.value)
      : [];
  const refs = parseRemoteRefs(refOutput, requestedTags);
  const { selectedRef, resolvedSha } = resolveSelectedRef(parsed, refs);
  const manifest = await fetchManifestImpl(parsed, resolvedSha, selectedRef);
  return createSnapshot({
    source: parsed.source,
    refOutput,
    manifest,
    featured,
  });
}

function hostKeyForEntry(entry) {
  const source = typeof entry === "string" ? entry : entry && entry.source;
  try {
    return assertSafePackageSource(source).originKey.split("/")[0];
  } catch {
    return "invalid";
  }
}

async function refreshEntries(
  entries,
  {
    concurrency = CONCURRENCY,
    onWarning = () => {},
    scrape = scrapeSource,
  } = {},
) {
  validateCatalog(entries);
  const queue = new TaskQueue(concurrency, concurrency);
  let failed = 0;
  let changed = 0;
  const refreshed = await Promise.all(
    entries.map((entry, index) =>
      queue.add(async () => {
        const source = typeof entry === "string" ? entry : entry.source;
        const featured = typeof entry === "object" && entry.featured === true;
        try {
          const snapshot = await scrape(source, { featured });
          if (JSON.stringify(snapshot) !== JSON.stringify(entry)) changed++;
          return snapshot;
        } catch (error) {
          failed++;
          onWarning({ error, index, source });
          return entry;
        }
      }, hostKeyForEntry(entry)),
    ),
  );
  validateCatalog(refreshed);
  return { entries: refreshed, changed, failed };
}

function githubWarning({ error, index, source }) {
  const message = `Entry ${index + 1} (${source}) was preserved: ${error.message}`;
  if (process.env.GITHUB_ACTIONS) {
    const escaped = message
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    process.stderr.write(`::warning::${escaped}\n`);
  } else {
    process.stderr.write(`Warning: ${message}\n`);
  }
}

async function main() {
  const body = await fs.promises.readFile(indexPath, "utf8");
  if (Buffer.byteLength(body) > MAX_CATALOG_BYTES)
    throw new Error("index.json is too large.");
  const current = JSON.parse(body);
  const result = await refreshEntries(current, { onWarning: githubWarning });
  const nextBody = serializeCatalog(result.entries);
  if (nextBody !== body) {
    const temporaryPath = `${indexPath}.tmp`;
    await fs.promises.writeFile(temporaryPath, nextBody, "utf8");
    await fs.promises.rename(temporaryPath, indexPath);
  }
  process.stdout.write(
    `Refreshed ${result.entries.length} entries: ${result.changed} changed, ${result.failed} preserved after errors.\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONCURRENCY,
  MANIFEST_FILENAMES,
  MAX_MANIFEST_BYTES,
  TaskQueue,
  assertPublicHostname,
  fetchGitManifest,
  fetchGithubManifest,
  fetchManifest,
  githubRepositoryPath,
  listRefs,
  parseManifestBody,
  refreshEntries,
  requestText,
  retry,
  runGit,
  scrapeSource,
};
