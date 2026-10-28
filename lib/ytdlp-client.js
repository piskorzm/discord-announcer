const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { YtDlp, helpers } = require('ytdlp-nodejs');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const META_PATH = path.join(BIN_DIR, '.yt-dlp-meta.json');
const YTDLP_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const ZIPAPP_ASSET = 'yt-dlp';
const ZIPAPP_PATH = path.join(BIN_DIR, ZIPAPP_ASSET);
const ZIPAPP_WRAPPER_NAME = 'yt-dlp-zipapp-wrapper';
const PYTHON_MODULE_WRAPPER_NAME = 'yt-dlp-via-python3';
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

function is32BitArmLinux() {
    return process.platform === 'linux' && normalizeArch(process.arch) === 'armv7l';
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

function probeBinary(candidate, args = ['--version']) {
    const result = spawnSync(candidate, args, { encoding: 'utf8' });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    const ok = result.status === 0;
    return {
        ok,
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
        version: ok ? (stdout || stderr).split('\n')[0] : null,
    };
}

function logBinaryProbeFailure(label, candidate, probe) {
    console.error(
        `yt-dlp probe failed (${label}) path=${candidate}` +
            ` exit=${probe.status}` +
            (probe.signal ? ` signal=${probe.signal}` : '') +
            (probe.stderr ? ` stderr=${JSON.stringify(probe.stderr)}` : '') +
            (probe.stdout ? ` stdout=${JSON.stringify(probe.stdout)}` : '')
    );
}

function isWorkingBinary(candidate, { label = 'binary', logFailure = false } = {}) {
    if (!candidate || !fs.existsSync(candidate)) {
        return false;
    }
    const probe = probeBinary(candidate);
    if (!probe.ok && logFailure) {
        logBinaryProbeFailure(label, candidate, probe);
    }
    return probe.ok;
}

function getBinaryVersion(binary) {
    const probe = probeBinary(binary);
    return probe.ok ? probe.version : null;
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

function removeManagedArtifacts({ preservePreferZipapp = false } = {}) {
    const preferZipapp = preservePreferZipapp ? readMeta()?.preferZipapp : undefined;

    if (!fs.existsSync(BIN_DIR)) {
        return;
    }
    for (const entry of fs.readdirSync(BIN_DIR)) {
        if (
            entry.startsWith('yt-dlp') ||
            entry === PYTHON_MODULE_WRAPPER_NAME ||
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

    if (preservePreferZipapp && preferZipapp) {
        writeMeta({ preferZipapp: true });
    }
}

function chmodExecutable(filePath) {
    try {
        fs.chmodSync(filePath, 0o755);
    } catch (error) {
        console.warn(`Could not chmod ${filePath}:`, error.message);
    }
}

function ensurePython39() {
    const versionProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (versionProbe.status !== 0) {
        throw new Error(
            `python3 is required for yt-dlp zipapp fallback (${versionProbe.stderr || 'not found'})`
        );
    }

    const minCheck = spawnSync(
        'python3',
        ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'],
        { encoding: 'utf8' }
    );
    if (minCheck.status !== 0) {
        throw new Error(
            `python3 >= 3.9 is required for yt-dlp zipapp (found ${(
                versionProbe.stdout ||
                versionProbe.stderr ||
                ''
            ).trim()})`
        );
    }
}

function ensureZipappWrapper(zipappPath = ZIPAPP_PATH) {
    const wrapperPath = path.join(BIN_DIR, ZIPAPP_WRAPPER_NAME);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        wrapperPath,
        `#!/bin/sh\nexec python3 "${zipappPath}" "$@"\n`,
        { mode: 0o755 }
    );
    return wrapperPath;
}

async function downloadReleaseAsset(assetName, destination) {
    const url = `${YTDLP_RELEASE_URL}/${assetName}`;
    console.log(`Downloading yt-dlp from ${url} ...`);
    await helpers.downloadFile(url, destination);
    chmodExecutable(destination);
}

function deleteFileIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn(`Could not delete ${filePath}:`, error.message);
    }
}

async function downloadLinuxArmv7lNative(destination) {
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

    for (const name of ['yt-dlp_linux_armv7l', 'yt-dlp']) {
        const candidate = path.join(BIN_DIR, name);
        if (fs.existsSync(candidate)) {
            if (candidate !== destination) {
                fs.renameSync(candidate, destination);
            }
            chmodExecutable(destination);
            deleteFileIfExists(zipPath);
            return destination;
        }
    }

    throw new Error('yt-dlp_linux_armv7l.zip did not contain an executable');
}

async function downloadNativeBinary(force = false) {
    const asset = releaseAssetName();
    if (!asset) {
        return null;
    }

    const destination = path.join(BIN_DIR, asset);
    if (!force && fs.existsSync(destination) && isWorkingBinary(destination)) {
        return destination;
    }

    if (force) {
        removeManagedArtifacts({ preservePreferZipapp: is32BitArmLinux() });
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });

    if (asset === 'yt-dlp_linux_armv7l') {
        await downloadLinuxArmv7lNative(destination);
    } else {
        await downloadReleaseAsset(asset, destination);
    }

    if (!isWorkingBinary(destination, { label: 'native binary', logFailure: true })) {
        deleteFileIfExists(destination);
        return null;
    }

    const version = getBinaryVersion(destination);
    writeMeta({
        version,
        path: destination,
        managed: true,
        mode: 'native',
        asset,
        preferZipapp: false,
    });
    console.log(`yt-dlp native binary ready at ${destination}${version ? ` (${version})` : ''}`);
    return destination;
}

async function downloadZipappBinary(force = false) {
    ensurePython39();

    const wrapperPath = path.join(BIN_DIR, ZIPAPP_WRAPPER_NAME);
    const meta = readMeta();

    if (
        !force &&
        meta?.mode === 'zipapp' &&
        fs.existsSync(ZIPAPP_PATH) &&
        isWorkingBinary(wrapperPath, { label: 'zipapp wrapper' })
    ) {
        if (!shouldRefreshBinary(meta)) {
            return wrapperPath;
        }
        console.log('Refreshing yt-dlp zipapp (scheduled update)...');
    }

    if (force) {
        removeManagedArtifacts({ preservePreferZipapp: true });
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    await downloadReleaseAsset(ZIPAPP_ASSET, ZIPAPP_PATH);

    const wrapper = ensureZipappWrapper();
    if (!isWorkingBinary(wrapper, { label: 'zipapp wrapper', logFailure: true })) {
        deleteFileIfExists(ZIPAPP_PATH);
        deleteFileIfExists(wrapper);
        throw new Error('Downloaded yt-dlp zipapp does not run via python3');
    }

    const version = getBinaryVersion(wrapper);
    writeMeta({
        version,
        path: wrapper,
        managed: true,
        mode: 'zipapp',
        zipappPath: ZIPAPP_PATH,
        preferZipapp: true,
    });
    console.log(
        `yt-dlp zipapp ready at ${ZIPAPP_PATH} (via ${wrapper})${version ? ` (${version})` : ''}`
    );
    return wrapper;
}

function findSystemYtDlpOnPath() {
    const pathResult = spawnSync('sh', ['-c', 'command -v yt-dlp'], { encoding: 'utf8' });
    if (pathResult.status === 0 && pathResult.stdout.trim()) {
        const candidate = pathResult.stdout.trim();
        if (isWorkingBinary(candidate, { label: 'system PATH yt-dlp', logFailure: true })) {
            return candidate;
        }
    }

    for (const candidate of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
        if (isWorkingBinary(candidate, { label: 'system yt-dlp', logFailure: true })) {
            return candidate;
        }
    }

    return null;
}

function findPythonModuleWrapper() {
    try {
        ensurePython39();
    } catch (error) {
        console.warn(error.message);
        return null;
    }

    const moduleProbe = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { encoding: 'utf8' });
    if (moduleProbe.status !== 0) {
        logBinaryProbeFailure('python3 -m yt_dlp', 'python3 -m yt_dlp', {
            ok: false,
            status: moduleProbe.status,
            signal: moduleProbe.signal,
            stdout: (moduleProbe.stdout || '').trim(),
            stderr: (moduleProbe.stderr || '').trim(),
        });
        return null;
    }

    const wrapperPath = path.join(BIN_DIR, PYTHON_MODULE_WRAPPER_NAME);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        wrapperPath,
        '#!/bin/sh\nexec python3 -m yt_dlp "$@"\n',
        { mode: 0o755 }
    );

    if (isWorkingBinary(wrapperPath, { label: 'python3 -m yt_dlp wrapper', logFailure: true })) {
        return wrapperPath;
    }

    return null;
}

function resolveSystemYtDlp(reason) {
    const systemPath = findSystemYtDlpOnPath();
    if (systemPath) {
        const version = getBinaryVersion(systemPath);
        console.warn(
            `Using system yt-dlp at ${systemPath}${version ? ` (${version})` : ''}` +
                (reason ? ` — ${reason}` : '')
        );
        writeMeta({
            version,
            path: systemPath,
            managed: false,
            mode: 'system-path',
            source: 'findSystemYtDlpOnPath',
        });
        return systemPath;
    }

    const pythonModule = findPythonModuleWrapper();
    if (pythonModule) {
        const version = getBinaryVersion(pythonModule);
        console.warn(
            `Using python3 -m yt_dlp via ${pythonModule}${version ? ` (${version})` : ''}` +
                (reason ? ` — ${reason}` : '')
        );
        writeMeta({
            version,
            path: pythonModule,
            managed: false,
            mode: 'python-module',
            source: 'findPythonModuleWrapper',
        });
        return pythonModule;
    }

    throw new Error(
        `Could not install or locate yt-dlp${reason ? ` (${reason})` : ''}. ` +
            'Install python3 >= 3.9 and run `sudo pip3 install -U yt-dlp`, or set YTDLP_BINARY_PATH.'
    );
}

async function resolveManagedYtDlp({ force = false } = {}) {
    const meta = readMeta();

    if (meta?.preferZipapp === true) {
        try {
            return await downloadZipappBinary(force);
        } catch (zipappError) {
            console.warn('Managed yt-dlp zipapp failed:', zipappError.message);
            return resolveSystemYtDlp(zipappError.message);
        }
    }

    const native = await downloadNativeBinary(force);
    if (native) {
        return native;
    }

    if (is32BitArmLinux()) {
        console.warn(
            'Native yt-dlp_linux_armv7l does not run on this Pi (old CPU/glibc); switching to zipapp.'
        );
        writeMeta({ preferZipapp: true });
    }

    try {
        return await downloadZipappBinary(force);
    } catch (zipappError) {
        console.warn('Managed yt-dlp zipapp failed:', zipappError.message);
        return resolveSystemYtDlp(zipappError.message);
    }
}

async function ensureYtDlpBinary({ force = false } = {}) {
    if (process.env.YTDLP_BINARY_PATH) {
        binaryPath = process.env.YTDLP_BINARY_PATH;
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`YTDLP_BINARY_PATH does not exist: ${binaryPath}`);
        }
        if (!isWorkingBinary(binaryPath, { label: 'YTDLP_BINARY_PATH', logFailure: true })) {
            throw new Error(`YTDLP_BINARY_PATH is not executable or failed --version: ${binaryPath}`);
        }
        writeMeta({
            version: getBinaryVersion(binaryPath),
            path: binaryPath,
            managed: false,
            mode: 'env',
        });
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
        console.log('Refreshing yt-dlp (scheduled update)...');
        binaryPath = await resolveManagedYtDlp({ force: true });
        resetYtDlpInstance();
        return binaryPath;
    }

    binaryPath = await resolveManagedYtDlp({ force });
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
