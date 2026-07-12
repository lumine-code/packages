# Lumine community packages

This repository is the catalog behind Lumine's **Settings → Install** panel. It stores only a list
of repositories — no package code, archives, or metadata. Once a day automation resolves each
repository's highest stable semantic-version tag (the same ref the editor installs), downloads the
package.json at that tag, and regenerates the consumable index — so names, versions, descriptions,
keywords, and theme flags always describe exactly what will be installed, and nobody maintains them
here.
