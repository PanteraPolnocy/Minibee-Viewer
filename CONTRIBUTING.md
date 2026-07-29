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

## TypeScript and the event types

The frontend is TypeScript, but not in the usual shape: every file is a plain
*script* holding one `const BeeThing = (function () { ... })()`, loaded by
ordered `<script>` tags. There are no imports and no bundler - esbuild
transforms each file on its own, so `src/js/x.ts` becomes `dist/js/x.js` in
place. `tsc` never emits; it only checks.

| Task | Command |
|------|---------|
| Check types | `npm run typecheck` |
| Regenerate the core's event types | `npm run types:sync` |

**Event payloads are generated from Rust.** The structs in
[`src-tauri/src/bridge/events.rs`](src-tauri/src/bridge/events.rs) are what the
core actually serialises, and `npm run types:sync` turns them into
`types/bee-ipc.d.ts` for the interface to check against. A hand-written
interface could only record what someone *believed* the core sends - and that
belief is what silently rots. To add an event:

1. Declare the struct in `events.rs` (`Serialize`, `TS`, `rename_all = "camelCase"`).
2. Emit it with `events::payload(...)` instead of a `json!` literal, and add a
   test asserting the JSON shape if you are replacing an existing literal.
3. Map the event name to the type in `types/events-map.d.ts`.
4. Run `npm run types:sync` and commit the regenerated `types/bee-ipc.d.ts`.

Watch for integer widths: `u64` becomes `bigint` unless you add
`#[ts(type = "number")]`, and serde writes those fields as plain JSON numbers -
so without it the generated type would misdescribe the wire.

**Typing progress.** Files still carrying `// @ts-nocheck` have not been typed
yet. Removing that banner and fixing what `npm run typecheck` reports for that
one file is a genuinely useful, self-contained contribution.

## Pull requests

1. Fork, branch, make your change.
2. If you touched tested code, run `npm test` and `npm run test:rust`.
3. Run `npm run typecheck` if you touched the frontend.
4. Keep the diff focused - one logical change per PR when you can.
5. Fill in the PR template; say whether you tried it on the live grid if that applies.

I may ask for tweaks or suggest splitting a large PR. No merge guarantee, but good-faith contributions are appreciated.

## Code of conduct

Be decent to each other. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Minibee is LGPL 2.1. By contributing, you agree your contribution is licensed under the same terms. See [LICENSE](LICENSE).
