# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Masasiya00/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Masasiya00/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON editor calls. It finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, then indentation), and applies every change atomically — all of them, or none at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` does everything but write. `--strict` matches lines exactly.

Node 22, standard library only — no dependencies, no install step.

License: MIT.
