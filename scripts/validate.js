"use strict";

const fs = require("fs");
const path = require("path");
const { MAX_CATALOG_BYTES, validateCatalog } = require("./catalog");

const indexPath = path.join(__dirname, "..", "index.json");

function main() {
  const body = fs.readFileSync(indexPath, "utf8");
  if (Buffer.byteLength(body) > MAX_CATALOG_BYTES)
    throw new Error("index.json is too large.");
  const entries = JSON.parse(body);
  validateCatalog(entries);
  process.stdout.write(`Validated ${entries.length} catalog entries.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
