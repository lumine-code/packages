"use strict";

const fs = require("fs");
const path = require("path");

const sourcesPath = path.join(__dirname, "..", "sources.json");
const shorthandPattern = /^[\w.-]+\/[\w.-]+(?:@[^\s]+|#[^\s]+|~[^\s]+)?$/;

function isSafeShorthand(source) {
  if (!shorthandPattern.test(source)) return false;
  const [owner, repository] = source.replace(/[@#~].*$/, "").split("/");
  return owner !== "." && owner !== ".." && repository !== "." && repository !== "..";
}

function repositoryPart(source) {
  if (isSafeShorthand(source)) return source.replace(/[@#~].*$/, "");
  const hash = source.lastIndexOf("#");
  return hash === -1 ? source : source.slice(0, hash);
}

function originKey(source) {
  const repository = repositoryPart(source);
  if (/^[\w.-]+\/[\w.-]+$/.test(repository)) return `github.com/${repository.toLowerCase()}`;
  const url = new URL(repository);
  const pathname = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${pathname}`;
}

function main() {
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  if (!Array.isArray(sources)) throw new Error("sources.json must be an array of Git sources.");
  if (sources.length > 2000) throw new Error("sources.json exceeds the 2000-repository limit.");

  const origins = new Set();
  for (const [index, source] of sources.entries()) {
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`Entry ${index + 1} must be a non-empty string.`);
    }
    if (!isSafeShorthand(source)) {
      const repository = repositoryPart(source);
      if (!/^https:\/\//i.test(repository)) {
        throw new Error(`Entry ${index + 1} must use public HTTPS or owner/repo shorthand.`);
      }
      const url = new URL(repository);
      if (url.username || url.password) throw new Error(`Entry ${index + 1} contains credentials.`);
      if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname)) {
        throw new Error(`Entry ${index + 1} targets a local or private address.`);
      }
    }
    const origin = originKey(source);
    if (origins.has(origin)) throw new Error(`Duplicate repository origin: ${origin}.`);
    origins.add(origin);
  }
  process.stdout.write(`Validated ${sources.length} sources.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
