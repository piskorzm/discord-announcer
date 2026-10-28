const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { YtDlp, helpers } = require('ytdlp-nodejs');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const META_PATH = path.join(BIN_DIR, '.yt-dlp-meta.json');
const REFRESH_INTERVAL_MS =
    (Number(process.env.YTDLP_REFRESH_DAYS) || 7) * 24 * 60 * 60 * 1000;

const YTDLP_ASSET_NAMES = {
    win32: { x64: 'yt-dlp.exe', ia32: 'yt-dlp_x86.exe' },
    linux: {
        x64: 'yt-dlp',
        armv7l: 'yt-dlp_linux_armv7l',
        aarch64: 'yt-dlp_linux_aarch64',
        arm64: 'yt-dlp',
    },
    darwin: { x64: 'yt-dlp_macos', arm64: 'yt-dlp_macos' },
};

const AUDIO_FORMAT =
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[height<=480]/best';

const PLAYER_CLIENT_STRATEGIES = [
    ['ios', 'web'],
    ['mweb', 'web'],
    ['android', 'web'],
    ['tv', 'web'],
    ['web'],
];

let ytdlpInstance;
let binaryPath;

function assetFileName() {
    const platform = process.platform;
    const arch = process.arch;
    const name = YTDLP_ASSET_NAMES[platform]?.[arch];
    if (!name) {
        throw new Error(`yt-dlp has no official ARM/Linux build mapping for ${platform} ${arch}`);
    }
    return name;
}

function readMeta() {
    try {
        return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function writeMeta(extra = {}) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        META_PATH,
        JSON.stringify({ ...readMeta(), ...extra, updatedAt: Date.now() }, null, 2)
    );
}

function resolveConfiguredBinaryPath() {
    if (process.env.YTDLP_BINARY_PATH) {
        return process.env.YTDLP_BINARY_PATH;
    }
    return path.join(BIN_DIR, assetFileName());
}

function getBinaryVersion(binary) {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
        return null;
    }
    return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

function shouldRefreshBinary(meta) {
    if (!meta?.updatedAt) {
        return true;
    }
    return Date.now() - meta.updatedAt > REFRESH_INTERVAL_MS;
}

function removeExistingBinaries() {
    if (!fs.existsSync(BIN_DIR)) {
        return;
    }
    for (const entry of fs.readdirSync(BIN_DIR)) {
        if (entry.startsWith('yt-dlp') || entry === '.yt-dlp-meta.json') {
            try {
                fs.unlinkSync(path.join(BIN_DIR, entry));
            } catch (error) {
                console.warn(`Could not remove old yt-dlp file ${entry}:`, error.message);
            }
        }
    }
}

async function downloadLatestBinary(force = false) {
    if (force) {
        removeExistingBinaries();
    }

    const target = resolveConfiguredBinaryPath();
    if (!force && fs.existsSync(target)) {
        return target;
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const downloaded = await helpers.downloadYtDlp(BIN_DIR);
    const version = getBinaryVersion(downloaded);
    writeMeta({ version, path: downloaded });
    console.log(`yt-dlp ready at ${downloaded}${version ? ` (${version})` : ''}`);
    return downloaded;
}

async function ensureYtDlpBinary({ force = false } = {}) {
    binaryPath = resolveConfiguredBinaryPath();

    if (process.env.YTDLP_BINARY_PATH) {
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`YTDLP_BINARY_PATH does not exist: ${binaryPath}`);
        }
        writeMeta({ version: getBinaryVersion(binaryPath), path: binaryPath });
        return binaryPath;
    }

    if (!force && fs.existsSync(binaryPath) && !shouldRefreshBinary(readMeta())) {
        return binaryPath;
    }

    if (!force && fs.existsSync(binaryPath) && shouldRefreshBinary(readMeta())) {
        console.log('Refreshing yt-dlp binary (scheduled update)...');
        return downloadLatestBinary(true);
    }

    if (!fs.existsSync(binaryPath)) {
        console.log('Downloading yt-dlp binary...');
        return downloadLatestBinary(false);
    }

    if (force) {
        return downloadLatestBinary(true);
    }

    writeMeta({ version: getBinaryVersion(binaryPath), path: binaryPath });
    return binaryPath;
}

function jsRuntimeArgs() {
    const nodePath = process.execPath;
    const args = ['--js-runtimes', `node:${nodePath}`];

    const denoPath = spawnSync('which', ['deno'], { encoding: 'utf8' });
    if (denoPath.status === 0 && denoPath.stdout.trim()) {
        args.push('--js-runtimes', `deno:${denoPath.stdout.trim()}`);
    }

    return args;
}

function baseDownloadOptions(outputPath) {
    return {
        output: outputPath,
        format: AUDIO_FORMAT,
        noPlaylist: true,
        retries: 5,
        fragmentRetries: 10,
        extractorRetries: 5,
        additionalOptions: [...jsRuntimeArgs(), '--no-warnings'],
    };
}

function strategyOptions(outputPath, clients) {
    return {
        ...baseDownloadOptions(outputPath),
        extractorArgs: {
            youtube: [`player_client=${clients.join(',')}`],
        },
    };
}

function getYtDlp() {
    if (!binaryPath) {
        throw new Error('yt-dlp binary is not initialized; call ensureYtDlpBinary() first');
    }
    if (!ytdlpInstance) {
        ytdlpInstance = new YtDlp({ binaryPath });
    }
    return ytdlpInstance;
}

function resetYtDlpInstance() {
    ytdlpInstance = undefined;
}

function isRetriableDownloadError(message) {
    const lower = message.toLowerCase();
    return (
        lower.includes('403') ||
        lower.includes('forbidden') ||
        lower.includes('javascript runtime') ||
        lower.includes('js runtime') ||
        lower.includes('unable to download video data') ||
        lower.includes('sign in to confirm') ||
        lower.includes('requested format is not available') ||
        lower.includes('no supported javascript') ||
        lower.includes('older than 90 days')
    );
}

function sanitizeYtDlpError(message) {
    return message
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return false;
            }
            if (trimmed.includes('ld.so: object') && trimmed.includes('libarmmem')) {
                return false;
            }
            if (trimmed.includes('cannot be preloaded')) {
                return false;
            }
            if (trimmed.startsWith('WARNING:')) {
                return false;
            }
            return true;
        })
        .join('\n')
        .trim();
}

async function downloadYoutubeAudio(url, outputPath, onProgress) {
    await ensureYtDlpBinary();
    let lastError;

    for (let round = 0; round < 2; round++) {
        for (const clients of PLAYER_CLIENT_STRATEGIES) {
            try {
                const ytdlp = getYtDlp();
                await ytdlp.downloadAsync(url, {
                    ...strategyOptions(outputPath, clients),
                    onProgress: (progress) => {
                        if (progress?.percentage != null && onProgress) {
                            onProgress(progress.percentage);
                        }
                    },
                });
                return;
            } catch (error) {
                lastError = error;
                const message = error?.message || String(error);
                if (!isRetriableDownloadError(message)) {
                    throw error;
                }
                console.warn(
                    `yt-dlp failed with clients [${clients.join(', ')}], trying next strategy...`
                );
            }
        }

        if (round === 0) {
            console.warn('yt-dlp strategies exhausted; refreshing binary and retrying...');
            await ensureYtDlpBinary({ force: true });
            resetYtDlpInstance();
        }
    }

    const raw = lastError?.message || String(lastError);
    throw new Error(sanitizeYtDlpError(raw) || 'yt-dlp download failed');
}

async function initYtDlpOnStartup() {
    try {
        await ensureYtDlpBinary();
        getYtDlp();
    } catch (error) {
        console.error('Failed to prepare yt-dlp on startup (will retry on /add-sound):', error);
    }
}

module.exports = {
    initYtDlpOnStartup,
    downloadYoutubeAudio,
    sanitizeYtDlpError,
    ensureYtDlpBinary,
    BIN_DIR,
};
