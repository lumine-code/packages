# lumine-packages

Package catalog for Lumine.

The catalog is source-only and drives Lumine's Settings → Install panel.

`index.json` is a JSON array of Git repository sources. Lumine resolves refs and reads each package manifest directly from the selected commit; names, versions, descriptions, and other package metadata are deliberately not copied into this catalog.

Entries may use GitHub `owner/repo` shorthand or public HTTPS Git URLs and may include a tag, branch, or commit selector supported by Lumine. Each repository origin may occur only once in this catalog.

## Package specs

Running each package's spec suite lives in `lumine-code/ci-status`, which sweeps the whole organization rather than this catalog. It is kept out of here on purpose: whether a package's specs pass is a fact about that package's repository, not about this one, so it must not mark this repository's commits red — and it could not be cleared from them either, since this catalog's `master` moves only when the catalog itself changes.

The one check that belongs here is `Validate catalog`, which depends on nothing but `index.json`.
