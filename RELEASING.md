# Releasing `@piphi-network/cli`

The package publishes from `.github/workflows/publish-npm.yml` through npm trusted publishing. The workflow uses GitHub's short-lived OIDC identity; do not add an `NPM_TOKEN` repository secret.

## One-time npm configuration

In the npm package settings for `@piphi-network/cli`, add a GitHub Actions trusted publisher with:

- organization or user: `PiPhi-io`
- repository: `piphi_network_create`
- workflow filename: `publish-npm.yml`
- environment: leave blank

The workflow filename and repository spelling must match exactly.

## Release

1. Update `version` in `package.json` and `package-lock.json`.
2. Merge the version change into `main` after `npm run check` and `npm test` pass.
3. Create and push the matching immutable tag, such as `v0.3.1` for package version `0.3.1`.
4. Watch the **Publish npm package** workflow to completion.
5. Verify the public package version and `latest` dist-tag.

The workflow rejects a tag that does not exactly match `v<package.json version>`, installs locked dependencies, runs all tests, inspects package contents, and publishes with npm provenance.
