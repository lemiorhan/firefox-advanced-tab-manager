# Contributing

Thanks for your interest in Advanced Tab Manager. Bug reports, ideas and pull
requests are all welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs

Open an issue and include your Firefox version, the extension version, the
rules involved (an exported JSON backup is ideal), and the steps that
reproduce the problem.

Security problems go through [SECURITY.md](SECURITY.md) instead.

## Suggesting features

Open an issue and describe the problem you want solved before the solution
you have in mind.

## Development setup

Requirements: Firefox 140 or newer.

```sh
git clone https://github.com/lemiorhan/firefox-advanced-tab-manager.git
cd firefox-advanced-tab-manager
```

Open `about:debugging` in Firefox, click "This Firefox" → "Load Temporary
Add-on" and select `firefox/manifest.json`. After changing a file, click
"Reload" next to the extension on the same page.

The extension has no build step and no dependencies. If you have Node.js, you
can lint it with Mozilla's `web-ext` tool:

```sh
npx web-ext lint --source-dir firefox
```

### End-to-end tests

`tests/e2e` holds a harness that loads the extension into a throwaway Firefox
profile and drives the real `tabs` and `tabGroups` APIs plus the options and
popup pages. It needs Node.js, Python 3 and a desktop Firefox:

```sh
bash tests/e2e/run.sh
```

It opens a Firefox window while it runs and exits with status 1 if any check
fails. Set `FIREFOX` if your Firefox binary is not at the macOS default path,
and `PORT` if 8765 is taken. Pass another extension directory as the first
argument to test a modified copy. The checks live in `tests/e2e/test.js`; add
one there when you change tab handling.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Make sure `npx web-ext lint --source-dir firefox` reports no errors.
4. Run `bash tests/e2e/run.sh` when the change touches tab handling, and test
   anything else by hand in Firefox. Describe how you tested it in the pull
   request.

### Commit messages

Write the subject in the imperative mood ("Add group sorting", not "Added
group sorting"), keep it under about 72 characters, and explain *why* in the
body when it is not obvious.

### Code style

Match the style of the surrounding code.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
