# Releases

The release workflow runs when a `v*` tag is pushed. The tag version must match
`package.json` (for example, version `0.0.2` and tag `v0.0.2`). Merge the release
workflow and `.github/release.yml` before tagging the release commit.

GitHub generates release notes from merged pull requests, using their titles,
authors, and PR links. Individual commit types do not select release sections.
Set a category label on each PR before releasing:

| PR label                  | Release section |
| ------------------------- | --------------- |
| `feat` or `enhancement`   | Features        |
| `fix` or `bug`            | Bug Fixes       |
| `perf`                    | Performance     |
| `test`                    | Tests           |
| `ci`                      | CI              |
| `docs` or `documentation` | Documentation   |
| `refactor`                | Refactoring     |

PRs without a matching label appear under Other Changes. GitHub omits empty
categories and adds a link to the full changelog.

The workflow creates a draft with `gh release create --draft --generate-notes`,
uploads the VSIX, and only then publishes the release. Upload failures fail
the workflow and leave a new release as a draft.
On a rerun, the existing release notes are preserved and the same-named VSIX
is replaced with `gh release upload --clobber`. An existing draft is published
after a successful upload; an already published release stays published.
