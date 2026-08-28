# lumine-packages

Package catalog for Lumine.

The catalog drives Lumine's Settings → Install panel while keeping source-only catalogs fully supported.

`index.json` is a JSON array whose entries may be Git repository source strings or resolved snapshots. A source string is the permanent general-purpose format: Lumine resolves its refs and reads its manifest directly. A snapshot carries the same source plus data already collected by a catalog, so Lumine can render it without making requests to that repository.

Entries may use GitHub `owner/repo` shorthand or public HTTPS Git URLs and may include a tag, branch, or commit selector supported by Lumine. Each repository origin may occur only once in this catalog.

A snapshot has this shape:

```json
{
  "source": "lumine-code/example",
  "featured": true,
  "resolvedSha": "0123456789abcdef0123456789abcdef01234567",
  "selectedRef": {
    "type": "latest",
    "value": "v1.2.0"
  },
  "refs": {
    "defaultBranch": "master",
    "headSha": "89abcdef0123456789abcdef0123456789abcdef",
    "latestStable": {
      "name": "v1.2.0",
      "version": "1.2.0",
      "sha": "0123456789abcdef0123456789abcdef01234567"
    },
    "tags": [
      {
        "name": "v1.2.0",
        "version": "1.2.0",
        "sha": "0123456789abcdef0123456789abcdef01234567"
      }
    ]
  },
  "metadata": {
    "name": "example",
    "version": "1.2.0",
    "description": "Example package.",
    "keywords": ["example"],
    "engines": {
      "lumine": "^1.0.0"
    },
    "repository": "https://github.com/lumine-code/example",
    "license": "MIT"
  }
}
```

`featured: true` is optional catalog policy, not package metadata. Lumine places featured entries first only when the Install search field is empty; the flag does not affect search ranking.

`npm run refresh` resolves every entry with at most eight simultaneous operations per host and deterministically rewrites successful entries as snapshots. It preserves entry order and keeps a source string or previous snapshot unchanged when that repository fails, allowing the rest of the catalog to advance. The scheduled `Refresh catalog` workflow runs daily at 03:17 UTC and commits only a changed `index.json`.

`npm run validate` checks source safety, origin uniqueness, snapshot fields, ref and SHA coherence, metadata, deterministic tag order, and the catalog size limits. `npm test` exercises both the mixed schema and scraper behavior.

## Package specs

Running each package's spec suite lives in `lumine-code/ci-status`, which sweeps the whole organization rather than this catalog. It is kept out of here on purpose: whether a package's specs pass is a fact about that package's repository, not about this one, so it must not mark this repository's commits red — and it could not be cleared from them either, since this catalog's `master` moves only when the catalog itself changes.

The checks that belong here validate `index.json` and the code that refreshes it; they do not run package repositories' own specs.
