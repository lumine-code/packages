"use strict";

// Removes a repository from sources.json.
//
//   node scripts/unregister-package.js owner/repo
//   node scripts/unregister-package.js --from-issue   (reads the ISSUE_BODY env var)

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcesPath = path.join(root, "sources.json");

function fail(message) {
  fs.writeFileSync(path.join(root, "error-message.txt"), `${message}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseSource(input) {
  const value = String(input || "").trim();
  const match =
    value.match(/^([\w.-]+)\/([\w.-]+)$/) ||
    value.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!match) {
    fail("Enter the repository as owner/repo.");
  }
  return { owner: match[1], repo: match[2] };
}

function main() {
  let input = process.argv[2];
  if (process.argv.includes("--from-issue")) {
    const body = process.env.ISSUE_BODY || "";
    const match = body.match(/###\s*Repository\s*\n+\s*`?([^\s`]+)`?/i);
    if (!match) fail("Could not find the repository in the issue body.");
    input = match[1];
  }
  const { owner, repo } = parseSource(input);
  const source = `${owner}/${repo}`;
  const key = source.toLowerCase();

  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  if (!sources.some((existing) => existing.toLowerCase() === key)) {
    fail(`"${source}" is not registered in the catalog.`);
  }
  const updated = sources.filter((existing) => existing.toLowerCase() !== key);
  fs.writeFileSync(sourcesPath, `${JSON.stringify(updated, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${source}\n`);
  }
  process.stdout.write(`Removed ${source} from sources.json.\n`);
}

main();
