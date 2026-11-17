# Contributing

Thanks for helping.

## Rules
- **Zero runtime dependencies:** air-gapped users must be able to run Bulwark with nothing but Node 22 or later. Keep
  it that way, and don't add packages to `dependencies`.
- **Same answers as the engine:** a change to a pipeline step must give the same result in a single pass and in
  chunked runs. `node test-data/ai/check.js` tests this.
- **Plain, accurate output:** keep command output short and honest, and never claim a certification or a measured
  result we haven't tested.
- **Sign-off:** contributions are accepted under Apache 2.0. Add a `Signed-off-by:` line to each commit, as described
  in the [Developer Certificate of Origin](https://developercertificate.org/).

## Before opening a pull request
```
python3 test-data/ai/make.py      # builds the synthetic test corpus (about 25 MB)
node test-data/ai/check.js        # every check must pass
node bin/bulwark help
```
