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

You also need **FFmpeg** on the host (`sudo apt install ffmpeg` on Raspberry Pi OS) and **yt-dlp** (see below).

On each startup the bot **re-registers global slash commands** with Discord (so new options appear after you deploy). Restart the bot once after pulling command changes.

## yt-dlp (required for `/add-sound`)

The bot does **not** download or update yt-dlp itself. Install and update it on the host with pip:

```bash
pip3 install -U yt-dlp
```

Ensure `~/.local/bin` is on your `PATH` (typical for pip `--user` installs), or set **`YTDLP_BINARY_PATH`** to the full path of the `yt-dlp` executable.

At startup the bot logs the resolved command and `yt-dlp --version`. If nothing is found, it logs:

`Install yt-dlp with: pip3 install -U yt-dlp`

**Keep yt-dlp current** — YouTube breaks old versions often. Upgrade manually when downloads fail, or use a weekly cron on the Pi:

```bash
# crontab -e
0 4 * * 0 pip3 install -U yt-dlp
```

Resolution order: `YTDLP_BINARY_PATH` → `yt-dlp` on `PATH` (including `~/.local/bin`) → `python3 -m yt_dlp`.

Optional flags (such as `--js-runtimes` for YouTube) are only passed if your installed yt-dlp supports them (`yt-dlp --help` is checked once at runtime).

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

Optional env **`YTDLP_BINARY_PATH`** — explicit path to the `yt-dlp` executable.

Harmless Raspberry Pi `ld.so.preload` / `libarmmem` messages are filtered out of Discord error replies.

## Raspberry Pi deploy / upgrade

```bash
cd /path/to/discord-announcer
git pull
npm install
pip3 install -U yt-dlp
node app.js
```
