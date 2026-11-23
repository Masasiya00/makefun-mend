# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Masasiya00/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Masasiya00/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` applies an edit that an AI model wrote to a tree of text files.
It reads four formats — unified diffs, SEARCH/REPLACE blocks, V4A
patches, and text-editor tool calls as JSON — finds the lines each edit
names at the first of three matching tiers, and writes every change or
none.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library only. The full contract is SPEC.md in
the make.fun kit for `hidden-spec-cli-01-run-20261122`.

License: MIT.
