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

## `/add-sound`

Registers a short welcome clip from a YouTube URL (max 20 seconds unless you pass start/end times).

| Option | Required | Description |
|--------|----------|-------------|
| `youtube-url` | yes | YouTube link |
| `start-time` | no | Start time (`mm:ss` or seconds) |
| `end-time` | no | End time (`mm:ss` or seconds) |
| `for-user` | no | Discord member to register the sound **for** (delegated admin only; see below) |

By default the sound is saved for whoever runs the command. **Only the account whose username is `zydoo`** may set `for-user` to another member (for example to register someone else’s entrance sound). Anyone else who sets `for-user` gets an ephemeral error and the clip is still saved for themselves.

Optional env `ADD_SOUND_DELEGATE_USER_IDS` — comma-separated Discord user IDs that may also use `for-user` (in addition to `zydoo`).

## `/add-sound` and YouTube downloads

The bot downloads audio with **yt-dlp**. It no longer uses the Snap-packaged `/snap/bin/yt-dlp` binary (that copy goes stale and lacks a JavaScript runtime for YouTube).

On startup (and again about once a week) the bot downloads or refreshes an **ARM-compatible** yt-dlp binary into the project `bin/` directory from the [official GitHub release](https://github.com/yt-dlp/yt-dlp/releases/latest) (`yt-dlp_linux_armv7l` on 32-bit Pi where Node reports `process.arch` as `arm`, `yt-dlp_linux_aarch64` on 64-bit ARM, `yt-dlp_linux` on x64). If a download is not available, it falls back to `yt-dlp` on your `PATH` or `python3 -m yt_dlp`.

The bot passes **Node** (the same runtime as `node app.js`) to yt-dlp as `--js-runtimes node:<path>`. If `deno` is installed on the Pi, it is registered as a fallback runtime.

### Raspberry Pi deploy / upgrade

After pulling this change on the Pi:

```bash
cd /path/to/discord-announcer
npm install
# optional: remove stale system/snap yt-dlp so nothing else confuses debugging
# sudo snap remove yt-dlp
node app.js
```

The first start may take a minute while yt-dlp is downloaded into `bin/`. No manual yt-dlp updates are required unless you want to pin a custom binary (see below).

### Optional environment variables

| Variable | Purpose |
|----------|---------|
| `YTDLP_BINARY_PATH` | Use a specific yt-dlp binary instead of the auto-managed `bin/` copy |
| `YTDLP_REFRESH_DAYS` | Days between automatic yt-dlp updates (default: `7`) |
| `ADD_SOUND_DELEGATE_USER_IDS` | Extra Discord user IDs allowed to use `/add-sound` `for-user` |

Harmless Raspberry Pi `ld.so.preload` / `libarmmem` messages are filtered out of Discord error replies.
