# Release closure

## Tag rule

After publication, verify that a tag points at the released commit. This gives the next changelog a reliable source range.

Typical next ranges:

- production: `v1.0.0..HEAD`
- beta: `beta-YYYYMMDDHHmm..HEAD`

## Verification

1. Identify the release commit from the workflow run, release record, or verified current `HEAD`.
2. Fetch tags with `git fetch --tags`.
3. Compare `git rev-parse <tag>` and `git rev-parse <release-commit>`.
4. If the tag exists, require identical SHAs.
5. If the release process was expected to create a tag but did not, report the gap. Create and push a tag only when the user's release request authorizes that external change.
6. If the tag points at another commit, stop. Never force-move a release tag without explicit approval.

## Report

Include the release/workflow URL, tag name, tag SHA, suggested next range, and whether the tag was verified, created, or missing. Do not include private URLs in a public changelog artifact.
