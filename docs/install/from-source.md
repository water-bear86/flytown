# Installing FLYTOWN

FLYTOWN is installed from source. There are no prebuilt installers and no
release pipeline.

## Requirements

- Node.js 20 or newer.
- A key for an OpenAI-compatible provider before running anything that calls
  a model (see [Provider routing](../reference/providers.md)).
- Python only if you want to rebuild the connectome artifacts yourself
  (see [`connectome-etl/README.md`](../../connectome-etl/README.md)); the
  runtime does not need it.

## Build

```bash
npm install
npm run build
```

The build compiles to `dist/`. The `flytown` binary is `dist/cli.js`: run it
as `node dist/cli.js …`, or run `npm link` once to put `flytown` on your PATH.

## Create a terrarium and open the control surface

```bash
cd /path/to/your/project
flytown init                          # creates .flytown/terrarium.json
flytown secret set DEEPSEEK_API_KEY   # optional: stores a key in .flytown/provider-secrets.json
flytown serve                         # http://localhost:7777/
```

Commands look for the nearest `.flytown/terrarium.json` above the current
directory, so run them from inside the project. What lives under `.flytown/`
is described in [Storage layout](../reference/storage-layout.md).

## Desktop shell (local builds only)

`npm run desktop` builds and opens an Electron window around the same control
surface. `npm run dist:mac`, `dist:win`, `dist:linux` and `dist:desktop`
package it locally into the gitignored `release/` folder. None of these
packages are published.
