# Lumine community packages

This repository is the catalog behind Lumine's **Settings → Install** panel. It stores only a list
of repositories — no package code, archives, or metadata. Several times a day automation resolves
each repository's highest stable semantic-version tag (the same ref the editor installs), downloads
the package.json at that tag, and regenerates the consumable index — so names, versions,
descriptions, keywords, and theme flags always describe exactly what will be installed, and nobody
maintains them here.

## Register your package

Open a [Register a package](../../issues/new?template=register-package.yml) issue and fill in your
`owner/repo`. Automation verifies the repository, adds it to the source list, and opens a pull
request — your package goes live once a maintainer merges it. No local setup needed.

A repository is identified by its **`owner/repo`** only. Tags, commits, and branches are **not**
supported in the source: the catalog always tracks each repository's latest stable release (falling
back to the default branch when it has no release tags).

To remove a package, open an [Unregister a package](../../issues/new?template=unregister-package.yml)
issue with the same `owner/repo`.

## How it works

- `sources.json`: the catalog — an alphabetical list of `owner/repo` entries.
- `index.json`: generated for Lumine from each package's own package.json (`name`, `version`,
  `description`, `keywords`, `theme`); rebuilt on merge and once a day. Never edit it manually.
- `scripts/build-index.js`: validates `sources.json` and builds the index. Each source resolves to
  its highest stable tag via `git ls-remote`, falling back to the default branch. When a repository
  is temporarily unreachable, the previous metadata is kept.
- `scripts/register-package.js`: verifies a repository and adds it to `sources.json` (run by the
  registration workflow).

Packages are identified by their repository, not their name: the same name may be published from
different repositories, and both are listed (Lumine shows the `owner/repo` beneath each one). Only
one of them can be installed at a time, since they would share an install directory.

CI validates the source list on every pull request: syntax, duplicate repositories, and ordering.
Each repository can be registered once; registration also rejects package names that collide with
a package bundled with Lumine. Catalog inclusion confirms the repository hosts an installable
package only; it is not a security audit or endorsement.
