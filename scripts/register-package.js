"use strict";

// Adds a repository to sources.json after verifying it hosts a Lumine package.
//
//   node scripts/register-package.js owner/repo[@tag|#commit|~branch]
//   node scripts/register-package.js --from-issue   (reads the ISSUE_BODY env var)

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcesPath = path.join(root, "sources.json");
const EditorPackageJson = "https://raw.githubusercontent.com/lumine-code/lumine/HEAD/package.json";

function fail(message) {
  fs.writeFileSync(path.join(root, "error-message.txt"), `${message}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseSource(input) {
  const value = String(input || "").trim();
  // Bare owner/repo only — tags, commits, and branches are not supported.
  const match =
    value.match(/^([\w.-]+)\/([\w.-]+)$/) ||
    value.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!match) {
    fail(
      "Enter the repository as owner/repo. Tags, commits, and branches are not supported — the catalog tracks the latest release.",
    );
  }
  return { owner: match[1], repo: match[2] };
}

async function main() {
  let input = process.argv[2];
  if (process.argv.includes("--from-issue")) {
    const body = process.env.ISSUE_BODY || "";
    const match = body.match(/###\s*Repository\s*\n+\s*`?([^\s`]+)`?/i);
    if (!match) fail("Could not find the repository in the issue body.");
    input = match[1];
  }
  const { owner, repo } = parseSource(input);
  const source = `${owner}/${repo}`;

  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  const key = source.toLowerCase();
  if (sources.some((existing) => existing.toLowerCase() === key)) {
    fail(`"${source}" is already registered.`);
  }

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "lumine-community-packages" },
  });
  if (!response.ok) {
    fail(
      `Could not read package.json from ${owner}/${repo} (status ${response.status}). The repository must be public and contain a package.json at its root.`,
    );
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    fail(`package.json in ${owner}/${repo} is not valid JSON.`);
  }

  const name = String(metadata.name || repo).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    fail(`Package name "${name}" is not a valid catalog name.`);
  }

  const editorResponse = await fetch(EditorPackageJson, {
    headers: { "User-Agent": "lumine-community-packages" },
  });
  if (editorResponse.ok) {
    const editor = await editorResponse.json();
    if (editor.packageDependencies && editor.packageDependencies[name] != null) {
      fail(`"${name}" is the name of a package bundled with Lumine and cannot be registered.`);
    }
  }

  const updated = [...sources, source].sort((left, right) => left.localeCompare(right));
  fs.writeFileSync(sourcesPath, `${JSON.stringify(updated, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${name}\nsource=${source}\n`);
  }
  process.stdout.write(`Added ${source} to sources.json.\n`);
}

main();
