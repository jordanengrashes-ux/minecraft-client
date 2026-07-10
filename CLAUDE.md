# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Voxel Client — an Electron-based Minecraft launcher (Java + Bedrock Edition), branded as a full-featured alternative to the official launcher: authentication, per-version mod/modpack management (Modrinth + CurseForge), resource packs/shaders, cosmetics (a bundled Fabric mod), skins, global chat/friends/presence (Firebase), and an in-app AI assistant.

## Repo layout

This is not a single-package repo — it's the Electron app plus several loosely-related sub-projects that live alongside it:

- **`src/main/`** — Electron main process (Node/TS): `main.ts` (all IPC handlers, game/Java/download logic — this file is huge), `preload.ts` (contextBridge API surface exposed to the renderer), `ai-key.ts` (API key constants — real values are injected by CI only, see below).
- **`src/renderer/`** — Electron renderer (browser-context TS/HTML), one entry point per window: `game.html`/`game.ts` (the main launcher UI — also huge), `login.html`/`login.ts`, `overlay.html`/`overlay.ts` (in-game cosmetics overlay), `ai-chat.html`/`ai-chat.ts`. `firebase.ts` holds the shared Firebase app/auth/rtdb instances.
- **`fabric-mod/`** — a separate Gradle/Fabric Loom Java project: the cosmetics mod (capes) that gets built independently and its output jar bundled into `resources/mods/voxel-cosmetics.jar` for the Electron app to auto-install. Needs its own JDK 21 + Gradle toolchain — not wired into the npm scripts at all.
- **`worker/`** — a Cloudflare Worker (`wrangler.toml`, name `voxel-client-ai`) with its own AI system prompt. Separate deployment from the app; not built or invoked by anything in `src/`.
- **`voxelhosting/agent/`** — a standalone Node script users run on their own PC to connect to the external VoxelHosting web dashboard (voxelhosting.vercel.app) for server hosting. Unrelated to the Electron app's own build; the app only links out to the dashboard (`nav-server` in game.ts).
- **`docs/`** — the marketing website (`index.html`, `features.html`, `faq.html`, `support.html`, `privacy.html`), deployed via the `Deploy Website` GitHub Actions workflow to GitHub Pages.
- **`database.rules.json`** — Firebase Realtime Database security rules for the shared backend (chat/friends/presence/etc.).
- A stray **top-level `game.html`** (not under `src/renderer/`) is dead/unused — `vite.config.ts` only builds from `src/renderer/*.html`. Don't confuse it with the real one.

## Commands

```
npm run dev            # vite (renderer, :5173) + electron concurrently, for local development
npm run build           # vite build + tsc -p tsconfig.electron.json (renderer + main, no packaging)
npm run dist:win         # build + electron-builder --win  (local unpublished installer)
npm run dist:mac         # build + electron-builder --mac
npm run dist:linux       # build + electron-builder --linux
npm run release          # build + electron-builder --win --linux --publish always (CI only — needs GH token)
```

There is no lint or test script configured in this repo — `npm run build` (which runs `tsc` in both configs) is the only correctness check available. There are two separate `tsc` configs and both must be checked independently since neither `include`s the other's directory:
```
npx tsc -p tsconfig.electron.json --noEmit   # src/main/**
npx tsc -p tsconfig.json --noEmit            # src/renderer/**
```
`npm run build`'s `tsc` step only type-checks `src/main` — always run the `tsconfig.json` (renderer) check separately too, since a broken renderer file won't fail `npm run build`.

`postinstall` runs `patch-package`, which applies `patches/minecraft-launcher-core+3.18.2.patch` — this disables MCLC's per-asset checksum verification (only checks file existence) purely for download speed on the tens of thousands of asset files Minecraft has. If MCLC is ever upgraded, this patch needs regenerating.

## Architecture

### Process boundary
Renderer code never touches Node/Electron APIs directly — everything goes through `preload.ts`'s `contextBridge.exposeInMainWorld` surfaces (`mc`, `curseforge`, `files`, `electron`, `updater`, `ai`, `cosmetics`, `overlay`, `voxelSrv`-style namespaces) calling `ipcMain.handle` handlers in `main.ts`. When adding a new main-process capability, it needs a handler in `main.ts` *and* a bridge entry in `preload.ts` — the renderer can't reach anything not explicitly exposed.

### Per-version mod isolation
Mods are NOT stored in one shared `.minecraft/mods` folder. Each Minecraft version gets its own folder under `.minecraft/mods-by-version/<sanitized-version>/` (`modsDirFor()` in main.ts), and the Fabric launch path points the JVM at the right one via the `-Dfabric.modsFolder=<dir>` system property (set in `buildLoaderLaunchOptions`). This exists specifically to stop mods built for one version from being loaded alongside an incompatible version — do not reintroduce a single shared mods folder.

### Fabric version merging
For Fabric-loader versions, the app builds its own merged version JSON (vanilla manifest + Fabric loader profile) rather than relying on MCLC's built-in Fabric support. Library deduplication across the merge (`dedupeLibraries`) must key on `groupId:artifactId:classifier` — keying on just `groupId:artifactId` will silently collapse legitimate platform-native variants of the same library (e.g. `com.mojang:jtracy`'s base jar vs its `natives-windows`/`natives-linux`/`natives-macos` jars) into one, dropping the base jar and breaking rendering. This has broken in exactly this way before.

### Java runtime resolution
`ensureJava()` in main.ts tries, in order: previously-cached resolved path → bundled Java 21 (Windows installer only, via `extraResources`) → its own downloaded copy → the official Minecraft Launcher's own shared runtime cache (`<appData>/.minecraft/runtime/<component>/<os-arch>/...` — reused, not duplicated) → system-installed Java → download from Adoptium as a last resort. This is cross-platform: mac JRE archives use a `Contents/Home/bin/java` bundle layout instead of Windows' flat `bin/`, Adoptium serves `.tar.gz` for mac/Linux vs `.zip` for Windows (`extractArchive()` dispatches on extension, using the `tar` package or the hand-rolled `extractZipAll`), and the zip extractor restores Unix executable permissions from the archive's external file attributes (without this, extracted mac/Linux binaries aren't runnable).

### CI/release pipeline
Two workflows: `auto-version.yml` (bumps patch version in `package.json`, commits `Bump to X`, tags `vX`) and `build.yml` (triggered by the tag push, builds `build-windows` + `build-mac` in parallel, then `publish` merges both into one GitHub Release). Things that look like bugs but are load-bearing:
- `auto-version.yml` checks out with `secrets.RELEASE_PAT` (a real PAT), not the default `GITHUB_TOKEN` — pushes from the default token don't trigger other workflows, so `build.yml` would silently never run.
- `auto-version.yml` has `paths-ignore: ['.github/**']` — a commit that *only* touches workflow files does not get version-bumped or released automatically. To ship a CI-only change, either bump `package.json`'s version and tag it manually, or make sure the commit also touches real source.
- API keys (`GEMINI_KEY`/`CF_API_KEY`/etc.) are written into `src/main/ai-key.ts` by a CI step from GitHub secrets, using a **quoted** heredoc/single-quoted string. `CF_API_KEY` is bcrypt-shaped (`$2a$10$...`) — an unquoted PowerShell string or unquoted bash heredoc will treat `$2a`/`$10` as variable expansions and silently corrupt the key. This has broken twice (once per shell) already.
- The macOS build is unsigned/un-notarized (no Apple Developer account configured) — `build/afterPack.js` ad-hoc signs it (free, no cert needed) but downloaded `.dmg`s still trip Gatekeeper's "damaged" dialog since Apple blocks any quarantined-and-unnotarized app regardless of ad-hoc signing. The workaround for end users is `xattr -cr` on the extracted `.app`.
- The `Deploy Website` workflow (docs/ → GitHub Pages) currently fails at `actions/configure-pages@v4` — needs the repo's Settings → Pages → Source set to "GitHub Actions" (a one-time dashboard setting, not fixable via a commit).

### Firebase backend
`voxel_chat`, `voxel_friends`, `voxel_presence`, `voxel_tokens`, `voxel_users`, `mc_servers`, `voxel_capes`, `voxel_timeouts`, etc. in `database.rules.json` currently have `.read`/`.write: true` with no auth check at all — anyone who knows the database URL can write to almost every path directly, no modified client needed. Only `vhServers` requires `auth != null`. Guest/offline sign-in (`login.ts`) also hardcodes `uid: 'guest'` for every guest instead of using Firebase Anonymous Auth, so concurrent guests collide on the same records. Both are known, not-yet-fixed issues — fixing the rules without first giving guests real (anonymous) auth sessions would lock guests out of chat/friends/presence entirely.

### Windows-only feature
Bedrock Edition support (`bedrockComMojangDir`, `mc-launch-bedrock`, Bedrock pack install) is inherently Windows-only — Bedrock has no Mac/Linux client at all, so these paths reading `process.env.LOCALAPPDATA` and failing gracefully ("not installed") on other platforms is correct, not a bug to fix.
