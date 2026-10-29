# [Squoosh]!

[Squoosh] is an image compression web app that reduces image sizes through numerous formats.

# About this repository

This is a fork of [GoogleChromeLabs/squoosh](https://github.com/GoogleChromeLabs/squoosh).
The original project is no longer actively maintained, so the goal here is to
modernize the toolchain (pnpm, Node 24, TypeScript 7, Rollup 4, current
PostCSS/Preact and friends) and deploy it to
[Cloudflare Pages](https://pages.cloudflare.com) with `wrangler`.

See [Deploying](#deploying) for the build/deploy commands, and the fork's
`cloudflare-deploy` branch for the deployment-specific configuration.

# Privacy

Squoosh does not send your image to a server. All image compression processes locally.

However, Squoosh utilizes Google Analytics to collect the following:

- [Basic visitor data](https://support.google.com/analytics/answer/6004245?ref_topic=2919631).
- The before and after image size value.
- If Squoosh PWA, the type of Squoosh installation.
- If Squoosh PWA, the installation time and date.

# Developing

To develop for Squoosh:

1. Clone the repository
1. This project uses [pnpm](https://pnpm.io) (pinned via the `packageManager`
   field). Either enable [corepack](https://nodejs.org/api/corepack.html) or
   install pnpm, then install node packages:
   ```sh
   pnpm install
   ```
1. Then build the app by running:
   ```sh
   pnpm build
   ```
1. After building, start the development server by running:
   ```sh
   pnpm dev
   ```

# Deploying

The site is deployed to Cloudflare Pages with `wrangler` (see `wrangler.toml`).
The `name` field there must match the name of the Pages project.

```sh
pnpm build
pnpm run deploy
```

`pnpm run deploy` checks the output against Cloudflare's limits and then runs
`wrangler pages deploy build`. Use `pnpm run deploy` rather than plain
`pnpm deploy`, which is a pnpm built-in command.

The deploy checks (`scripts/check-asset-size.mjs`) fail if a file is larger
than Cloudflare's 25 MiB per-file limit or if there are more than 20,000 files:

- The wasm codecs are ~17 MiB in total across 23 files, the largest being
  ~2.7 MiB. They are uploaded as ordinary static assets, so there is no
  20 MiB bundle limit and no need to stitch or split them.
- Codecs are only fetched by the worker that needs them, one module per
  worker, so a browser never holds all of them in memory at once.

Cloudflare build settings: build command `pnpm build`, deploy command
`pnpm run deploy`.

# Contributing

Squoosh is an open-source project that appreciates all community involvement. To contribute to the project, follow the [contribute guide](/CONTRIBUTING.md).

[squoosh]: https://squoosh.app
