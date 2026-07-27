# Contributing to Minibee Viewer

Thanks for taking an interest. Useful help is always welcome - bug reports, docs fixes, protocol work, UI polish, all of it.

This repository will not host anything harmful to the Second Life community.

## Where to look first

| If you want to... | Start here |
|-----------------|------------|
| Use Minibee | [HELP.md](HELP.md) (also **Bee -> Help** in the app) |
| Build or run from source | [README - For developers](README.md#for-developers) |
| Local installable build (no signing key) | `npm run build:local` or `npm run build:local:debug` |
| Report a security issue | [SECURITY.md](SECURITY.md) - please do not open a public issue |

## Bugs and ideas

- **Something broken?** Open a [bug report](https://github.com/PanteraPolnocy/Minibee-Viewer/issues/new?template=bug_report.md). **Bee -> About -> Copy all** saves a lot of back-and-forth.
- **A feature you'd like?** Open a [feature request](https://github.com/PanteraPolnocy/Minibee-Viewer/issues/new?template=feature_request.md).
- **Not sure yet, or just asking?** [Discussions](https://github.com/PanteraPolnocy/Minibee-Viewer/discussions), or the contact details in **Bee -> About**.

## Pull requests

1. Fork, branch, make your change.
2. If you touched tested code, run `npm test` and `npm run test:rust`.
3. Keep the diff focused - one logical change per PR when you can.
4. Fill in the PR template; say whether you tried it on the live grid if that applies.

I may ask for tweaks or suggest splitting a large PR. No merge guarantee, but good-faith contributions are appreciated.

## Code of conduct

Be decent to each other. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Minibee is LGPL 2.1. By contributing, you agree your contribution is licensed under the same terms. See [LICENSE](LICENSE).
