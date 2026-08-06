# Lumine community packages

Community package catalog for Lumine.

The catalog is source-only and drives Lumine's Settings → Install panel.

`index.json` is an JSON array of Git repository sources. Lumine resolves refs and reads
each package manifest directly from the selected commit; names, versions, descriptions, and other
package metadata are deliberately not copied into this catalog.

Entries may use GitHub `owner/repo` shorthand or public HTTPS Git URLs and may include a tag, branch,
or commit selector supported by Lumine. Each repository origin may occur only once in this catalog.

Run `npm run validate` before submitting changes.

## Package specs

The `Package specs` workflow runs the Jasmine suite of every package this catalog lists, inside a
real editor build, on Linux, macOS and Windows. It runs on every push to `master`, once a day, and
on demand from the Actions tab — where a run can be narrowed to a few packages, fewer platforms, or
a different editor ref.

Each entry is resolved the way Lumine resolves it when a user installs it: the newest stable semver
tag the repository publishes, and `master` when it has never been tagged. An entry that carries an
explicit tag, branch, or commit selector is tested exactly as written.

The editor is built once per platform and handed to that platform's spec jobs. The catalog is then
spread over shards, and each shard clones, installs, and runs its packages one at a time in its own
Electron session with a private `LUMINE_HOME`. Every shard reports whatever it got through and the
summary job is the only one that fails the run, so one broken suite never hides the rest — nor does
a package that no shard reported on at all.

The same three steps run locally against a checkout of the editor:

```
node scripts/plan-specs.js --only "linter marker-*" --shards 1
node scripts/run-specs.js --plan plan.json --shard 0 --editor ../lumine
node scripts/summarize-specs.js --results results --plan plan.json
```
