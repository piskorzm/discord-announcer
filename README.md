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

## `/add-sound` and YouTube downloads

The bot downloads audio with **yt-dlp**. It no longer uses the Snap-packaged `/snap/bin/yt-dlp` binary (that copy goes stale and lacks a JavaScript runtime for YouTube).

On startup (and again about once a week) the bot downloads or refreshes an **ARM-compatible** yt-dlp binary into the project `bin/` directory via `ytdlp-nodejs`. When a download fails, it refreshes yt-dlp once and retries with alternate YouTube player clients.

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

Harmless Raspberry Pi `ld.so.preload` / `libarmmem` messages are filtered out of Discord error replies.
