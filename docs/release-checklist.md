# Phewsh CLI release integrity checklist

This is the required evidence trail for npm releases. **Current releases are
manual and have no release provenance, signed tags, or registry attestation.**
Until the promotion gate below is complete, do not describe the npm artifact as
cryptographically linked to the public source mirror.

## Every release

1. Record the exact private source commit, public mirror commit, package
   version, releaser, and release time. Require a clean intended worktree.
2. From `cli/`, run `npm test` and record the result.
3. Run `npm audit --omit=dev` and record findings, accepted exceptions, and
   owner. A nonzero result is a release decision, not something to hide.
4. Run `npm pack --dry-run --json`. Inspect every shipped path and confirm the
   manifest includes `README.md`, `SECURITY.md`, `docs/threat-model.md`, and
   `docs/release-checklist.md`, with no secrets, local receipts, or unintended
   files.
5. Run the repository's secret scan and dependency review. Record tool versions
   and results; do not treat absence of CI as a pass.
6. Bump the version without publishing, review the diff, commit it, and push the
   intended source commit.
7. Synchronize the public CLI mirror from that exact commit. Compare the mirror
   contents against the package source and record both commit hashes. This is a
   manual equality check today, not cryptographic provenance.
8. Publish only after the evidence above is retained. Verify with `npm view
   phewsh version`, inspect the registry tarball/manifest, and execute a clean
   smoke test such as `npx phewsh@<version> --version` plus one local-only
   command.
9. Add the released version and verification evidence to the project record.
   If any check differs after publish, stop promotion and open an incident.

## Promotion gate: verifiable provenance

Complete all of these before claiming the package is verifiably built from
public source:

- Publish from a reviewed GitHub Actions workflow using npm trusted publishing
  (OIDC), a protected environment, minimal permissions, and
  `npm publish --provenance`.
- Create a signed tag that resolves to the exact reviewed public commit.
- Run dependency and secret scanning in the trusted build; retain results and
  block unresolved release-critical findings.
- Build the tarball in the trusted workflow rather than copying an unverified
  local artifact.
- Verify the npm registry attestation references the expected public repository,
  workflow, commit, version, and signed tag.
- Independently download the published tarball, compare its manifest/content to
  the trusted build output, and run the smoke suite.

Only after those checks pass may public copy say the npm artifact is
cryptographically linked to a public commit. “Audited” still requires an
independent security assessment.

## Rollback and incident handling

If published contents, credentials, provenance, or verification differ from the
recorded release:

1. Stop promotion and mark the version affected; do not silently overwrite the
   record.
2. Revoke exposed credentials and disable compromised automation.
3. Deprecate the affected npm version with a concrete warning. Publish a fixed
   version rather than relying on unpublish.
4. Preserve logs, tarballs, hashes, and commit identifiers; document root cause
   and corrective controls in `.intent/decisions.md`.
