const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { YtDlp, helpers } = require('ytdlp-nodejs');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const META_PATH = path.join(BIN_DIR, '.yt-dlp-meta.json');
const YTDLP_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const PYTHON_WRAPPER_NAME = 'yt-dlp-via-python3';
const REFRESH_INTERVAL_MS =
    (Number(process.env.YTDLP_REFRESH_DAYS) || 7) * 24 * 60 * 60 * 1000;

/** Asset names verified against yt-dlp release 2026.10.26 on GitHub. */
const NON_LINUX_ASSETS = {
    win32: { x64: 'yt-dlp.exe', ia32: 'yt-dlp_x86.exe', arm64: 'yt-dlp_arm64.exe' },
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

function normalizeArch(arch) {
    if (arch === 'arm') {
        return 'armv7l';
    }
    if (arch === 'x64' || arch === 'amd64') {
        return 'x64';
    }
    return arch;
}

function linuxReleaseAssetName(normalizedArch) {
    switch (normalizedArch) {
        case 'x64':
            return 'yt-dlp_linux';
        case 'armv7l':
            return 'yt-dlp_linux_armv7l';
        case 'arm64':
        case 'aarch64':
            return 'yt-dlp_linux_aarch64';
        default:
            return null;
    }
}

function releaseAssetName(platform = process.platform, arch = process.arch) {
    const normalizedArch = normalizeArch(arch);
    if (platform === 'linux') {
        return linuxReleaseAssetName(normalizedArch);
    }
    return NON_LINUX_ASSETS[platform]?.[normalizedArch] ?? NON_LINUX_ASSETS[platform]?.[arch] ?? null;
}

function managedBinaryPath() {
    const asset = releaseAssetName();
    if (!asset) {
        return null;
    }
    return path.join(BIN_DIR, asset);
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
    return managedBinaryPath();
}

function getBinaryVersion(binary) {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
        return null;
    }
    return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

function isWorkingBinary(candidate) {
    if (!candidate || !fs.existsSync(candidate)) {
        return false;
    }
    return getBinaryVersion(candidate) != null;
}

function shouldRefreshBinary(meta) {
    if (meta?.managed === false) {
        return false;
    }
    if (!meta?.updatedAt) {
        return true;
    }
    return Date.now() - meta.updatedAt > REFRESH_INTERVAL_MS;
}

function removeManagedBinaries() {
    if (!fs.existsSync(BIN_DIR)) {
        return;
    }
    for (const entry of fs.readdirSync(BIN_DIR)) {
        if (
            entry.startsWith('yt-dlp') ||
            entry === PYTHON_WRAPPER_NAME ||
            entry.endsWith('.zip')
        ) {
            try {
                fs.unlinkSync(path.join(BIN_DIR, entry));
            } catch (error) {
                console.warn(`Could not remove old yt-dlp file ${entry}:`, error.message);
            }
        }
    }
    try {
        fs.unlinkSync(META_PATH);
    } catch {
        // no meta yet
    }
}

function chmodExecutable(filePath) {
    try {
        fs.chmodSync(filePath, 0o755);
    } catch (error) {
        console.warn(`Could not chmod ${filePath}:`, error.message);
    }
}

async function downloadReleaseAsset(assetName, destination) {
    const url = `${YTDLP_RELEASE_URL}/${assetName}`;
    console.log(`Downloading yt-dlp from ${url} ...`);
    await helpers.downloadFile(url, destination);
    chmodExecutable(destination);
}

async function downloadLinuxArmv7lBinary(destination) {
    try {
        await downloadReleaseAsset('yt-dlp_linux_armv7l', destination);
        return destination;
    } catch (bareError) {
        console.warn(
            'Bare armv7l binary download failed, trying yt-dlp_linux_armv7l.zip:',
            bareError.message
        );
    }

    const zipPath = `${destination}.zip`;
    await helpers.downloadFile(`${YTDLP_RELEASE_URL}/yt-dlp_linux_armv7l.zip`, zipPath);

    const unzip = spawnSync('unzip', ['-o', '-j', zipPath, '-d', BIN_DIR], {
        encoding: 'utf8',
    });
    if (unzip.status !== 0) {
        throw new Error(unzip.stderr || unzip.stdout || 'unzip failed for yt-dlp_linux_armv7l.zip');
    }

    const extractedNames = ['yt-dlp_linux_armv7l', 'yt-dlp'];
    for (const name of extractedNames) {
        const candidate = path.join(BIN_DIR, name);
        if (fs.existsSync(candidate)) {
            if (candidate !== destination) {
                fs.renameSync(candidate, destination);
            }
            chmodExecutable(destination);
            try {
                fs.unlinkSync(zipPath);
            } catch {
                // ignore
            }
            return destination;
        }
    }

    throw new Error('yt-dlp_linux_armv7l.zip did not contain an executable');
}

async function downloadManagedBinary(force = false) {
    const asset = releaseAssetName();
    if (!asset) {
        return resolveSystemYtDlp('No official yt-dlp release asset for this CPU/OS');
    }

    const destination = path.join(BIN_DIR, asset);
    if (!force && fs.existsSync(destination) && isWorkingBinary(destination)) {
        return destination;
    }

    if (force) {
        removeManagedBinaries();
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });

    try {
        if (asset === 'yt-dlp_linux_armv7l') {
            await downloadLinuxArmv7lBinary(destination);
        } else {
            await downloadReleaseAsset(asset, destination);
        }

        if (!isWorkingBinary(destination)) {
            throw new Error(`Downloaded yt-dlp at ${destination} does not run`);
        }

        const version = getBinaryVersion(destination);
        writeMeta({ version, path: destination, managed: true, asset });
        console.log(`yt-dlp ready at ${destination}${version ? ` (${version})` : ''}`);
        return destination;
    } catch (error) {
        console.warn('Managed yt-dlp download failed:', error.message);
        return resolveSystemYtDlp(error.message);
    }
}

function findYtDlpOnPath() {
    const pathResult = spawnSync('sh', ['-c', 'command -v yt-dlp'], { encoding: 'utf8' });
    if (pathResult.status === 0 && pathResult.stdout.trim()) {
        return pathResult.stdout.trim();
    }

    for (const candidate of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
        if (isWorkingBinary(candidate)) {
            return candidate;
        }
    }

    return null;
}

function ensurePythonModuleWrapper() {
    const wrapperPath = path.join(BIN_DIR, PYTHON_WRAPPER_NAME);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        wrapperPath,
        '#!/bin/sh\nexec python3 -m yt_dlp "$@"\n',
        { mode: 0o755 }
    );
    return wrapperPath;
}

function findPythonYtDlp() {
    const moduleCheck = spawnSync('python3', ['-m', 'yt_dlp', '--version'], {
        encoding: 'utf8',
    });
    if (moduleCheck.status !== 0) {
        return null;
    }

    const wrapper = ensurePythonModuleWrapper();
    return isWorkingBinary(wrapper) ? wrapper : null;
}

function findPythonZipapp() {
    const zipappCandidates = [
        path.join(BIN_DIR, 'yt-dlp'),
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
    ];

    for (const candidate of zipappCandidates) {
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const head = fs.readFileSync(candidate, { encoding: 'utf8', flag: 'r' }).slice(0, 80);
        if (head.includes('python')) {
            const wrapperPath = path.join(BIN_DIR, 'yt-dlp-zipapp-wrapper');
            fs.writeFileSync(
                wrapperPath,
                `#!/bin/sh\nexec python3 "${candidate}" "$@"\n`,
                { mode: 0o755 }
            );
            if (isWorkingBinary(wrapperPath)) {
                return wrapperPath;
            }
        }
    }

    return null;
}

function resolveSystemYtDlp(reason) {
    const candidates = [
        findYtDlpOnPath,
        findPythonYtDlp,
        findPythonZipapp,
    ];

    for (const find of candidates) {
        const found = find();
        if (found && isWorkingBinary(found)) {
            const version = getBinaryVersion(found);
            console.warn(
                `Using system yt-dlp at ${found}${version ? ` (${version})` : ''}` +
                    (reason ? ` — ${reason}` : '')
            );
            writeMeta({ version, path: found, managed: false, source: find.name });
            return found;
        }
    }

    throw new Error(
        `Could not install or locate yt-dlp${reason ? ` (${reason})` : ''}. ` +
            'Install via pip (`sudo pip3 install -U yt-dlp`), apt, or set YTDLP_BINARY_PATH.'
    );
}

async function ensureYtDlpBinary({ force = false } = {}) {
    if (process.env.YTDLP_BINARY_PATH) {
        binaryPath = process.env.YTDLP_BINARY_PATH;
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`YTDLP_BINARY_PATH does not exist: ${binaryPath}`);
        }
        writeMeta({ version: getBinaryVersion(binaryPath), path: binaryPath, managed: false });
        return binaryPath;
    }

    const meta = readMeta();
    binaryPath = meta?.path;

    if (!force && binaryPath && isWorkingBinary(binaryPath) && !shouldRefreshBinary(meta)) {
        return binaryPath;
    }

    if (!force && binaryPath && isWorkingBinary(binaryPath) && meta?.managed === false) {
        return binaryPath;
    }

    if (!force && binaryPath && isWorkingBinary(binaryPath) && shouldRefreshBinary(meta)) {
        console.log('Refreshing yt-dlp binary (scheduled update)...');
        binaryPath = await downloadManagedBinary(true);
        return binaryPath;
    }

    binaryPath = await downloadManagedBinary(force);
    return binaryPath;
}

function jsRuntimeArgs() {
    const nodePath = process.execPath;
    const args = ['--js-runtimes', `node:${nodePath}`];

    const denoPath = spawnSync('sh', ['-c', 'command -v deno'], { encoding: 'utf8' });
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
            const meta = readMeta();
            if (meta?.managed !== false) {
                console.warn('yt-dlp strategies exhausted; refreshing binary and retrying...');
                await ensureYtDlpBinary({ force: true });
                resetYtDlpInstance();
            }
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
    releaseAssetName,
    normalizeArch,
    BIN_DIR,
};
