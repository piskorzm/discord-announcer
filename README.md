# discord-announcer
Discord bot that plays a registered sound for a user when they join a voice channel

## How to run

Copy the example env file and set your bot token:

```bash
cp .env.example .env
# edit .env — set DISCORD_TOKEN (see migration table below if you used config.json before)
npm install
node app.js
```

You also need **FFmpeg** on the host (`sudo apt install ffmpeg` on Raspberry Pi OS).

On each startup the bot **re-registers global slash commands** with Discord. You can also register commands without running the full bot:

```bash
node scripts/deploy-commands.js
```

### Migrating from `config.json`

| Old `config.json` key | New `.env` variable |
|----------------------|---------------------|
| `token` | `DISCORD_TOKEN` |

Example: `{ "token": "YOUR_DISCORD_TOKEN" }` becomes:

```env
DISCORD_TOKEN=YOUR_DISCORD_TOKEN
```

Do not commit `.env` (it is gitignored). See `.env.example` for all supported variables.

## yt-dlp (managed by the bot)

The bot **downloads and updates yt-dlp itself** into the project `bin/` directory. It does **not** use a system or pip-installed `yt-dlp` unless you set **`YTDLP_BINARY_PATH`** in `.env`.

- About every **24 hours** (startup and before `/add-sound`), it checks [the latest GitHub release](https://github.com/yt-dlp/yt-dlp/releases/latest) and downloads **only if** the managed copy is missing or older than that release.
- If GitHub is unreachable, it keeps the existing `bin/` copy.
- On **32-bit ARM** (`process.arch` `arm`), it tries the native `yt-dlp_linux_armv7l` binary first; if that fails to run, it switches to the platform-independent **`yt-dlp` zipapp** run with a compatible **Python** (minimum version from the release’s `pyproject.toml`, often **3.11+** while Raspberry Pi OS Bullseye still ships Python 3.9).
- Optional CLI flags (e.g. `--js-runtimes`) are passed only when supported (`yt-dlp --help` is parsed once per process).

At startup you should see lines like:

`Managed yt-dlp: …/bin/yt-dlp-zipapp-wrapper (2026.10.26) — already latest`  
`yt-dlp zipapp interpreter: /home/pi/.local/bin/python3.12 (Python 3.12.x)`

**No cron is required** for yt-dlp updates.

### Python for the zipapp on the Pi (Bullseye / Python 3.9)

Latest yt-dlp needs a newer Python than `apt install python3`. Install **3.12** side-by-side with [uv](https://github.com/astral-sh/uv):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv python install 3.12
```

Ensure `~/.local/bin` is on your `PATH`, then restart the bot. The bot uses **`uv python find`**, uv’s install directory, and `PATH` / `~/.local/bin` to pick a suitable interpreter. Set **`YTDLP_PYTHON`** in `.env` to pin one explicitly.

### Remove an old pip-installed yt-dlp (recommended on the Pi)

```bash
pip3 uninstall yt-dlp
# if needed on newer Debian/Raspberry Pi OS:
pip3 uninstall yt-dlp --break-system-packages
rm -f ~/.local/bin/yt-dlp
```

## `/add-sound`

Registers a short welcome clip from a YouTube URL (max 20 seconds unless you pass start/end times).

| Option | Required | Description |
|--------|----------|-------------|
| `youtube-url` | yes | YouTube link |
| `start-time` | no | Start time (`mm:ss` or seconds) |
| `end-time` | no | End time (`mm:ss` or seconds) |
| `for-user` | no | Discord member to register the sound **for** (delegated admin only; see below) |

By default the sound is saved for whoever runs the command. **Only the account whose username is `zydoo`** may set `for-user` to another member. Anyone else who sets `for-user` gets an ephemeral error and the clip is still saved for themselves.

Set **`ADD_SOUND_DELEGATE_USER_IDS`** in `.env` (comma-separated Discord user IDs) to allow additional delegates.

Harmless Raspberry Pi `ld.so.preload` / `libarmmem` messages are filtered out of Discord error replies.

## Raspberry Pi deploy / upgrade

```bash
cd /path/to/discord-announcer
git pull
npm install
cp -n .env.example .env   # skip if you already have .env
node app.js
```
