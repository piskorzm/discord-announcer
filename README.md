# discord-announcer
Discord bot that plays a registered sound for a user when they join a voice channel

## How to run

Create a `config.json` file with a token entry:

```json
{ "token": "YOUR_DISCORD_TOKEN" }
```

Install dependencies and start the bot:

```bash
npm install
node app.js
```

You also need **FFmpeg** on the host (`sudo apt install ffmpeg` on Raspberry Pi OS).

On each startup the bot **re-registers global slash commands** with Discord (so new options appear after you deploy). Restart the bot once after pulling command changes.

## yt-dlp (managed by the bot)

The bot **downloads and updates yt-dlp itself** into the project `bin/` directory. It does **not** use a system or pip-installed `yt-dlp` unless you set **`YTDLP_BINARY_PATH`**.

- About every **24 hours** (startup and before `/add-sound`), it checks [the latest GitHub release](https://github.com/yt-dlp/yt-dlp/releases/latest) and downloads **only if** the managed copy is missing or older than that release.
- If GitHub is unreachable, it keeps the existing `bin/` copy.
- On **32-bit ARM** (`process.arch` `arm`), it tries the native `yt-dlp_linux_armv7l` binary first; if that fails to run, it switches to the platform-independent **`yt-dlp` zipapp** via `python3` (minimum Python is read from the release’s `pyproject.toml`).
- Optional CLI flags (e.g. `--js-runtimes`) are passed only when supported (`yt-dlp --help` is parsed once per process).

At startup you should see a line like:

`Managed yt-dlp: …/bin/yt-dlp-zipapp-wrapper (2026.10.26) — already latest`

**No cron is required** for yt-dlp updates.

### Remove an old pip-installed yt-dlp (recommended on the Pi)

So the bot is not confused with an outdated pip copy on your `PATH`:

```bash
pip3 uninstall yt-dlp
# if needed on newer Debian/Raspberry Pi OS:
pip3 uninstall yt-dlp --break-system-packages
# or: sudo pip3 uninstall yt-dlp

rm -f ~/.local/bin/yt-dlp
```

Then restart the bot; it will populate `bin/` on its own.

Optional env **`YTDLP_BINARY_PATH`** — force a specific yt-dlp executable instead of the managed `bin/` copy.

## `/add-sound`

Registers a short welcome clip from a YouTube URL (max 20 seconds unless you pass start/end times).

| Option | Required | Description |
|--------|----------|-------------|
| `youtube-url` | yes | YouTube link |
| `start-time` | no | Start time (`mm:ss` or seconds) |
| `end-time` | no | End time (`mm:ss` or seconds) |
| `for-user` | no | Discord member to register the sound **for** (delegated admin only; see below) |

By default the sound is saved for whoever runs the command. **Only the account whose username is `zydoo`** may set `for-user` to another member (for example to register someone else’s entrance sound). Anyone else who sets `for-user` gets an ephemeral error and the clip is still saved for themselves.

Optional env **`ADD_SOUND_DELEGATE_USER_IDS`** — comma-separated Discord user IDs that may also use `for-user` (in addition to `zydoo`).

Harmless Raspberry Pi `ld.so.preload` / `libarmmem` messages are filtered out of Discord error replies.

## Raspberry Pi deploy / upgrade

```bash
cd /path/to/discord-announcer
git pull
npm install
node app.js
```
