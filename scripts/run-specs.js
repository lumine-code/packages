"use strict";

// Run one shard of the plan produced by `plan-specs.js`.
//
// Each package is cloned at its resolved ref, its dependencies installed, and
// its Jasmine suite run inside the prebuilt editor checkout — the same
// invocation every package's own CI uses, so a failure here means the same
// thing it would there. The checkout is discarded afterwards: a hundred package
// trees with their `node_modules` do not fit on a runner.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArguments(argv) {
  const options = {
    plan: "plan.json",
    shard: 0,
    editor: "lumine",
    out: null,
    timeout: 900,
    workspace: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--plan") options.plan = next();
    else if (argument === "--shard") options.shard = Number(next());
    else if (argument === "--editor") options.editor = next();
    else if (argument === "--out") options.out = next();
    else if (argument === "--timeout") options.timeout = Number(next());
    else if (argument === "--workspace") options.workspace = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.shard) || options.shard < 0) {
    throw new Error("--shard must be a non-negative integer.");
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 1) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  // Every platform's shard 0 writes a file; name it after the platform too, so
  // the results survive being collected into one directory.
  const platform = (process.env.RUNNER_OS || process.platform).toLowerCase();
  options.out = options.out || `results/shard-${platform}-${options.shard}.json`;
  return options;
}

const PLATFORM = process.env.RUNNER_OS || process.platform;

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env || process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) return { code: 1, message: result.error.message };
  if (result.status !== 0) {
    return { code: result.status === null ? 1 : result.status, message: `${command} failed` };
  }
  return { code: 0 };
}

// npm is a `.cmd` shim on Windows, which Node refuses to spawn directly, and
// the spec run wants a `timeout` guard in front of it. Both are simplest
// through a shell, and every runner this workflow uses has bash.
function shell(command, cwd, env) {
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    env: env || process.env,
    stdio: "inherit",
  });
  if (result.error) return { code: 1, message: result.error.message };
  return { code: result.status === null ? 1 : result.status };
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function has(command) {
  return spawnSync("bash", ["-c", `command -v ${command} >/dev/null 2>&1`]).status === 0;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function group(title, body) {
  process.stdout.write(`::group::${title}\n`);
  try {
    return body();
  } finally {
    process.stdout.write("::endgroup::\n");
  }
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

function checkout(entry, directory) {
  remove(directory);
  if (entry.refType === "commit") {
    fs.mkdirSync(directory, { recursive: true });
    const steps = [
      ["init", "--quiet"],
      ["remote", "add", "origin", entry.cloneUrl],
      ["fetch", "--depth", "1", "--quiet", "origin", entry.ref],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ];
    for (const args of steps) {
      const result = run("git", args, directory);
      if (result.code !== 0) return result;
    }
    return { code: 0 };
  }
  return run("git", [
    "clone",
    "--depth",
    "1",
    "--quiet",
    "--branch",
    entry.ref,
    entry.cloneUrl,
    directory,
  ]);
}

// `--ignore-scripts` matches how every package's own CI installs itself: these
// are editor packages, so nothing they depend on needs a build step, and the
// native modules the specs touch belong to the editor and are already built.
function install(directory) {
  const lockfile = fs.existsSync(path.join(directory, "package-lock.json"));
  const args = lockfile
    ? "ci --ignore-scripts --no-audit --no-fund"
    : "install --ignore-scripts --no-audit --no-fund --no-package-lock";
  const result = shell(`npm ${args}`, directory);
  if (result.code === 0) return result;
  return { ...result, message: result.message || `npm ${args.split(" ")[0]} failed` };
}

function runSpecs(specDirectory, editorDirectory, options, environment) {
  const prefix = [];
  // macOS runners ship no GNU `timeout`; Homebrew's coreutils calls it
  // `gtimeout`. Without either, the job's own timeout is the backstop.
  if (has("timeout")) prefix.push("timeout", "--kill-after=30s", `${options.timeout}s`);
  else if (has("gtimeout")) prefix.push("gtimeout", "--kill-after=30s", `${options.timeout}s`);
  if (process.platform === "linux") prefix.push("xvfb-run", "--auto-servernum");
  const command = `${prefix.join(" ")} npm start -- --test ${quote(specDirectory)}`.trim();
  const result = shell(command, editorDirectory, environment);
  const { code } = result;
  if (result.message) return result;
  // `timeout` reports 124 when it had to fire, which is a hang rather than a
  // failing expectation and worth naming as one in the summary.
  if (code === 124 || code === 137) {
    return { code, message: `timed out after ${options.timeout}s` };
  }
  return code === 0 ? { code: 0 } : { code, message: `specs failed (exit ${code})` };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
  const editorDirectory = path.resolve(options.editor);
  const workspace = path.resolve(
    options.workspace || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "lumine-specs"),
  );
  const entries = plan.packages.filter((entry) => entry.shard === options.shard);

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });

  const results = [];
  for (const entry of entries) {
    const directory = path.join(workspace, "checkout", entry.name);
    // A private LUMINE_HOME per package: nothing one suite writes to the config
    // directory can reach the next one in the shard.
    const home = path.join(workspace, "home", entry.name);
    const startedAt = Date.now();
    const record = {
      name: entry.name,
      source: entry.source,
      ref: entry.ref,
      refType: entry.refType,
      sha: entry.sha,
      platform: PLATFORM,
      status: "passed",
      message: null,
    };

    group(`${entry.name} (${entry.refType} ${entry.ref})`, () => {
      remove(home);
      fs.mkdirSync(home, { recursive: true });

      const cloned = checkout(entry, directory);
      if (cloned.code !== 0) {
        record.status = "error";
        record.message = `checkout failed: ${cloned.message}`;
        return;
      }
      record.sha = capture("git", ["rev-parse", "HEAD"], directory) || entry.sha;

      const specDirectory = path.join(directory, "spec");
      if (!fs.existsSync(specDirectory)) {
        record.status = "skipped";
        record.message = "no spec directory";
        return;
      }

      const installed = install(directory);
      if (installed.code !== 0) {
        record.status = "error";
        record.message = `install failed: ${installed.message}`;
        return;
      }

      const environment = {
        ...process.env,
        LUMINE_HOME: home,
        LUMINE_JASMINE_REPORTER: "list",
      };
      const specs = runSpecs(specDirectory, editorDirectory, options, environment);
      if (specs.code !== 0) {
        record.status = "failed";
        record.message = specs.message;
      }
    });

    record.durationMs = Date.now() - startedAt;
    results.push(record);
    if (record.status === "failed" || record.status === "error") {
      process.stdout.write(`::error title=${entry.name}::${record.message}\n`);
    }
    // Reclaim the disk before the next package: a shard's worth of package
    // trees with their dependencies would otherwise fill the runner.
    remove(directory);
    remove(home);
  }

  fs.writeFileSync(
    path.resolve(options.out),
    `${JSON.stringify({ shard: options.shard, platform: PLATFORM, results }, null, 2)}\n`,
  );

  const failed = results.filter(
    (result) => result.status === "failed" || result.status === "error",
  );
  process.stdout.write(
    `${PLATFORM} shard ${options.shard}: ${results.length} packages, ${failed.length} failing.\n`,
  );
  // The shard always writes its results and always exits zero; the summary job
  // is what turns the fleet's outcome into the run's outcome, so one broken
  // package cannot hide the ones that follow it in a later shard.
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
