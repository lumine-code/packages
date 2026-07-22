# Lumine community packages

This repository is the source-only catalog used by Lumine's Settings → Install panel.

`sources.json` is an untrusted JSON array of Git repository sources. Lumine resolves refs and reads
each package manifest directly from the selected commit; names, versions, descriptions, and other
package metadata are deliberately not copied into this catalog.

Entries may use GitHub `owner/repo` shorthand or public HTTPS Git URLs and may include a tag, branch,
or commit selector supported by Lumine. Each repository origin may occur only once in this catalog.

Run `npm run validate` before submitting changes.
