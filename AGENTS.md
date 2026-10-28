# AGENTS.md

Release checklist for this Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

- [ ] **Contract version**: `cortico.api` equals the world version on the `Contracts:` line that
  `check:extension` prints (world v6 at 0.1.0). A package with any other value does not load.
- [ ] **Self-description**: after changing tools, events or the environment prompt, run
  `pnpm describe:extension <dir>`. `cortico.describe` names the written file and `files` ships it.
- [ ] **Tool names**: `ocq_` is this World's short prefix; a name that collides with another World or
  the Persona keeps the whole World from mounting, so keep new tools under it.
- [ ] **Events**: every type this World pushes is declared in `describe.events`; a type pushed but not
  declared is logged and shown on the World page.
- [ ] **Text for the model is English**: tool descriptions, event bodies and the environment prompt are
  read by the bot, so they stay English. Only `webUi(language)` and the config groups are localized.
- [ ] **Tags**: `cortico.tags` carries `diagnostics`, which is what this package is.
- [ ] **CHANGELOG.md** has a `## <version>` section for the version being published.
- [ ] **`os`**: none, the package is platform-independent.
- [ ] **`pnpm typecheck && pnpm test`** and **`pnpm check:extension <dir>`** pass.
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions), in
  the plain-text format that `check:extension` prints and the README describes.
