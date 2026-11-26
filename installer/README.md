# Client installer

The rotator serves its own installer at `GET /install.mjs`. One run registers the rotator in every coding agent it finds on the machine, turns off other Context7 servers, and installs Upstash's Context7 skill (`skills/context7-mcp`).

```sh
curl -fsSo install.mjs https://context7.tyrannosaurus-magellanic.ts.net/install.mjs
node install.mjs          # check: lists what it would change, exit 1 if anything
node install.mjs apply    # makes the changes, exit 2 if any failed
```

`check` changes nothing. `apply` first copies each file it changes into `~/.context7-rotator/backups/<time>/`, and moves competing skills there.

It works on each agent's user-level config only, so it does not see project files such as a repository's `.mcp.json`.

The code is in [core.ts](core.ts), with the agents and their paths. [install.ts](install.ts) is the CLI. `npm run build:installer` bundles both into `dist-installer/install.mjs`, and the image ships that file.
