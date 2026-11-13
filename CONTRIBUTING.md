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

**Everything under `src/js` is checked** - there are no `@ts-nocheck` escapes
left, so `npm run typecheck` passing means the whole frontend passed. Please
keep it that way rather than reaching for the banner; the common fixes are
casting an element where it is looked up
(`document.getElementById('x') as HTMLInputElement | null`), giving
`querySelectorAll` a type argument, annotating an object literal that gets
fields added to it, and marking trailing parameters optional (`options?`).

## UI text and languages

Every line a person can read is looked up by key, and the words live only in
`src/lang/`: `en.json` (English, the fallback for every language, also
compiled into the core) and one `<code>.json` per other language.

| Where | How a line is named |
|-------|---------------------|
| Frontend (`src/js`) | `t('radar.range')`, `t('im.members', { count: n })`, `BeeI18n.html(...)` for a line with markup (values escaped) - see the header of `src/js/i18n.ts` |
| Markup (`src/index.html`) | `data-i18n="key"` on an element whose text is the line, `data-i18n-html` for markup, `data-i18n-title` / `-placeholder` / `-aria-label` / `-alt` / `-value` for attributes; the HTML itself holds no words there |
| Core (`src-tauri`) | `ui_err("err.noNotice", json!({}))` for a command's error, `UiText::new("key", args).fields(&mut payload, "reason")` beside a payload field, `ui_text(...)` standalone - see `src-tauri/src/uitext.rs` |

Keys are `module.camelCaseName`. Placeholders are `{name}`, filled from the
arguments; a line that bends with a number is an object of plural forms
(`one`/`other` in English, `one`/`few`/`many`/`other` in Polish), picked by
`count`. Never call `t()` while a script is being evaluated (module-level
constants): the files are loaded by `BeeApp.init`, so tables of labels hold
functions and translate when they render.

| Task | Command |
|------|---------|
| Check the language files against the sources | `npm run lang:check` (also part of `npm test`) |
| List what a translation still lacks | `node scripts/sync-lang.mjs --missing pl` |

To add a line: use a new key in the code or markup, add the English to
`en.json` and the Polish to `pl.json` (keys sorted). The check fails on a key
the sources use but a file lacks, on a key no source uses, on placeholders
that disagree with the call's arguments, and on a translation missing a key
or a plural form. To add a language: copy `en.json` to `src/lang/<code>.json`
and translate it, then add the code with its native name to `LANGUAGES` (and
the locale tables) in `src/js/i18n.ts` and to the `language` choices in
`src/js/settings.ts`. Android's notification texts are the usual string
resources under `src-tauri/gen/android/app/src/main/res/values-<code>/`.

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
