# agent-status

Fast Bun-based OpenTUI dashboard for AI account/usage status.

Current providers:

- Codex/OpenAI via `~/.codex/auth.json` (fallback `~/.local/share/opencode/auth.json`)
- GitHub Copilot via `.copilot/config.json` (fallback to other known auth files)
- Gemini via `~/.gemini/*` (+ optional `GEMINI_PROJECT_ID`)
- Amp via local `amp usage` CLI command
- Droid (Factory) via env/auth token
- Kimi via env/auth token
- z.ai via env/auth token
- Antigravity via local language server process probe

## Features

- OpenTUI React interface with minimal split layout
- Queries all configured providers in parallel
- Keyboard controls: `r` refresh, `q` quit, `left/right` provider navigation, `up/down/pageup/pagedown` detail scroll
- Auto-refresh every 60s (override with `AGENT_STATUS_REFRESH_MS`)
- `--once` mode for scripts/cron

## Run

```bash
bun run src/index.ts
```

Or:

```bash
bun run dev
```

## One-shot mode

```bash
bun run src/index.ts --once
```

## Install globally (local machine)

```bash
bun link
agent-status
```

## Installation scripts

Linux/macOS (`sh`):

```bash
sh ./scripts/install.sh
```

Linux/macOS clone + install:

```bash
sh ./scripts/install.sh https://github.com/SpreadSheets600/Agent-Quota.git agent-status
```

Windows (`cmd`):

```bat
scripts\\install.cmd
```

Windows clone + install:

```bat
scripts\\install.cmd https://github.com/SpreadSheets600/Agent-Quota.git agent-status
```

You can also run via package scripts:

```bash
bun run install:sh
```

```bat
bun run install:cmd
```

## Build standalone binary

```bash
bun run build
./dist/agent-status
```

## CI and publishing

- CI runs on every pull request and push to `main` using `.github/workflows/ci.yml`.
- npm publishing runs from `.github/workflows/publish.yml` when:
  - you push a tag like `v0.1.0`, or
  - you trigger it manually via GitHub Actions (`workflow_dispatch`).

Required repository secret:

- `NPM_TOKEN`: npm automation token with publish access.

Release flow:

```bash
# 1) bump version in package.json
# 2) commit changes
git tag v0.1.0
git push origin main --tags
```

## Auth/env

Codex:

- Primary auth source: `~/.codex/auth.json`
- Fallback auth source: `~/.local/share/opencode/auth.json` (`openai`)
- Optional env override:
  - `OPENAI_ACCESS_TOKEN`
  - `OPENAI_ACCOUNT_ID`

Copilot:

- Primary OAuth source:
  - `~/.copilot/config.json` (`copilot_tokens`)
- Fallback OAuth discovery:
  - `~/.local/share/opencode/auth.json` (`github-copilot`)
  - `~/.config/opencode/auth.json`
  - `~/.opencode/auth.json`
- Optional env override:
  - `COPILOT_OAUTH_TOKEN`
- Optional billing API config:
  - `~/.config/opencode/copilot-quota-token.json`

Gemini:

- Reads local Gemini files from `~/.gemini`
- Optional project env:
  - `GEMINI_PROJECT_ID`
  - `GOOGLE_CLOUD_PROJECT`
  - `GCLOUD_PROJECT`

Amp:

- Requires `amp` CLI available in `PATH`
- Auth via `amp login`

Droid (Factory):

- `DROID_AUTH_TOKEN` or `DROID_API_TOKEN` or `FACTORY_AUTH_TOKEN`
- Fallback auth entry lookup from opencode auth keys: `droid`, `factory`, `factory-ai`

Kimi:

- `KIMI_AUTH_TOKEN` or `KIMI_API_TOKEN` or `MOONSHOT_API_TOKEN`
- Fallback auth entry lookup from opencode auth keys: `kimi`, `moonshot`, `moonshotai`

z.ai:

- `ZAI_API_TOKEN` or `ZAI_AUTH_TOKEN` or `ZHIPU_API_TOKEN`
- Fallback auth entry lookup from opencode auth keys: `zai`, `z-ai`, `zhipu`, `glm`

Antigravity:

- Requires local Antigravity language server running
- Uses local process/port detection and local API probe

Refresh interval:

- `AGENT_STATUS_REFRESH_MS` (minimum 5000)
