# Contributing to CoCreate Server Load Test

Issues and pull requests are welcome in the [CoCreate Server Load Test repository](https://github.com/CoCreateJS/loadtest).

## Development

- Use Node.js 22.4 or newer.
- The generator intentionally uses Node.js built-ins and has no runtime dependencies.
- Keep the load generator independent from the server being measured. Do not add target-server telemetry or autoscaling control to the client.
- Document new configuration variables and workload behavior in the [README](README.md).
- Do not include credentials or production data in examples or result files.

Before submitting, review the changed scripts and run the applicable command against a local or staging target. This repository does not currently define a test suite.

## Commits and releases

Use semantic commit messages, such as `fix(http): record response timeout` or `feat(profile): support ramp phases`. Releases and changelog updates are generated from commits pushed to `main` by Semantic Release.
