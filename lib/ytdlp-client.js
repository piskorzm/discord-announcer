const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const META_PATH = path.join(BIN_DIR, '.yt-dlp-meta.json');
const YTDLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const GITHUB_LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const ZIPAPP_ASSET = 'yt-dlp';
const ZIPAPP_PATH = path.join(BIN_DIR, ZIPAPP_ASSET);
const ZIPAPP_WRAPPER = path.join(BIN_DIR, 'yt-dlp-zipapp-wrapper');
const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const AUDIO_FORMAT =
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[height<=480]/best';

/** YouTube player_client list passed via --extractor-args (Pi-validated). */
const YOUTUBE_PLAYER_CLIENTS = ['android', 'web'];

/** @type {{ command: string, prefixArgs: string[], displayPath: string, version: string } | null} */
let resolvedYtDlp = null;
/** @type {object | null} */
let featureSupport = null;
/** @type {{ key: string, path: string, text: string } | null} */
let cachedZipappPythonValidation = null;

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

function nativeAssetName() {
    const normalized = normalizeArch(process.arch);
    if (process.platform === 'linux') {
        switch (normalized) {
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
    if (process.platform === 'win32') {
        return normalized === 'x64' ? 'yt-dlp.exe' : null;
    }
    if (process.platform === 'darwin') {
        return 'yt-dlp_macos';
    }
    return null;
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

function httpGet(url, { json = false, maxRedirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'discord-announcer-bot' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (maxRedirects <= 0) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                httpGet(new URL(res.headers.location, url).toString(), { json, maxRedirects: maxRedirects - 1 })
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                if (json) {
                    try {
                        resolve(JSON.parse(body.toString('utf8')));
                    } catch (error) {
                        reject(error);
                    }
                } else {
                    resolve(body);
                }
            });
        }).on('error', reject);
    });
}

async function fetchLatestReleaseTag() {
    const data = await httpGet(GITHUB_LATEST_API, { json: true });
    if (!data?.tag_name) {
        throw new Error('GitHub API response missing tag_name');
    }
    return data.tag_name.replace(/^v/, '');
}

async function fetchMinimumPythonVersion(releaseTag) {
    try {
        const url = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${releaseTag}/pyproject.toml`;
        const body = (await httpGet(url)).toString('utf8');
        const specMatch = body.match(/requires-python\s*=\s*"([^"]+)"/);
        if (specMatch) {
            const verMatch = specMatch[1].match(/(3\.\d+(?:\.\d+)?)/);
            if (verMatch) {
                return verMatch[1];
            }
        }
        return '3.9';
    } catch {
        return '3.9';
    }
}

function parsePythonVersionString(text) {
    const match = (text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3] || 0),
    };
}

function comparePythonParsed(a, b) {
    if (a.major !== b.major) {
        return a.major - b.major;
    }
    if (a.minor !== b.minor) {
        return a.minor - b.minor;
    }
    return a.patch - b.patch;
}

function pythonVersionAtLeast(installed, requiredMinStr) {
    const req = parsePythonVersionString(
        requiredMinStr.startsWith('3.') ? requiredMinStr : `3.${requiredMinStr}`
    );
    if (!installed || !req) {
        return false;
    }
    return comparePythonParsed(installed, req) >= 0;
}

async function requireZipappPython(releaseTag) {
    const minPython = await fetchMinimumPythonVersion(releaseTag);
    const pythonPath = process.env.YTDLP_PYTHON?.trim();

    if (!pythonPath) {
        throw new Error(
            'YTDLP_PYTHON is not set in .env (required when the bot uses the yt-dlp zipapp)'
        );
    }

    const cacheKey = `${pythonPath}|${minPython}`;
    if (cachedZipappPythonValidation?.key === cacheKey) {
        return cachedZipappPythonValidation;
    }

    if (!fs.existsSync(pythonPath)) {
        throw new Error(`YTDLP_PYTHON=${pythonPath} does not exist`);
    }

    const probe = spawnSync(pythonPath, ['--version'], { encoding: 'utf8' });
    const versionText = (probe.stdout || probe.stderr || '').trim();
    if (probe.status !== 0) {
        throw new Error(
            `YTDLP_PYTHON=${pythonPath} failed --version` +
                (versionText ? ` (${versionText})` : '')
        );
    }

    const parsed = parsePythonVersionString(versionText);
    if (!parsed) {
        throw new Error(`YTDLP_PYTHON=${pythonPath} returned unparseable version: ${versionText}`);
    }

    if (!pythonVersionAtLeast(parsed, minPython)) {
        throw new Error(
            `YTDLP_PYTHON=${pythonPath} is ${versionText}; yt-dlp needs Python >= ${minPython}`
        );
    }

    cachedZipappPythonValidation = {
        key: cacheKey,
        path: pythonPath,
        text: versionText,
    };
    return cachedZipappPythonValidation;
}

function usesZipappMode(meta) {
    return !!(meta?.preferZipapp || meta?.mode === 'zipapp');
}

async function prepareZipappRuntime(releaseTag) {
    const meta = readMeta();
    if (!usesZipappMode(meta) || !fs.existsSync(ZIPAPP_PATH)) {
        return;
    }

    const tag =
        releaseTag || meta?.latestKnownRelease || meta?.version?.replace(/^v/, '') || 'master';
    const python = await requireZipappPython(tag);
    ensureZipappWrapper(python.path);

    const probe = probeBinaryDetailed(ZIPAPP_WRAPPER);
    if (!probe.ok) {
        logProbeFailure('zipapp wrapper', ZIPAPP_WRAPPER, probe);
        throw new Error(
            `yt-dlp zipapp wrapper failed --version with YTDLP_PYTHON=${python.path}`
        );
    }

    resolvedYtDlp = {
        command: ZIPAPP_WRAPPER,
        prefixArgs: [],
        displayPath: ZIPAPP_WRAPPER,
        version: probe.version || meta?.version,
    };
    featureSupport = null;
}

async function finalizeManagedResult(result) {
    if (process.env.YTDLP_BINARY_PATH || !result.resolution) {
        return result;
    }
    const meta = readMeta();
    if (!usesZipappMode(meta)) {
        return result;
    }
    await prepareZipappRuntime(result.latestTag);
    return { ...result, resolution: resolvedYtDlp };
}

function compareReleaseVersions(installed, latest) {
    if (!installed) {
        return -1;
    }
    if (installed === latest) {
        return 0;
    }
    const normalize = (v) => v.split('.').map((n) => Number(n.padStart(4, '0')));
    const a = normalize(installed);
    const b = normalize(latest);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) {
            return diff < 0 ? -1 : 1;
        }
    }
    return 0;
}

function probeBinaryDetailed(command, prefixArgs = []) {
    const result = spawnSync(command, [...prefixArgs, '--version'], { encoding: 'utf8' });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    const ok = result.status === 0;
    const versionLine = ok ? (stdout || stderr).split('\n')[0] : null;
    return {
        ok,
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
        version: versionLine ? versionLine.replace(/^v/, '').trim() : null,
    };
}

function logProbeFailure(label, target, probe) {
    console.error(
        `yt-dlp probe failed (${label}) target=${target}` +
            ` exit=${probe.status}` +
            (probe.signal ? ` signal=${probe.signal}` : '') +
            (probe.stderr ? ` stderr=${JSON.stringify(probe.stderr)}` : '') +
            (probe.stdout ? ` stdout=${JSON.stringify(probe.stdout)}` : '')
    );
}

function chmodExecutable(filePath) {
    try {
        fs.chmodSync(filePath, 0o755);
    } catch (error) {
        console.warn(`Could not chmod ${filePath}:`, error.message);
    }
}

function downloadToFile(url, destination) {
    return new Promise(async (resolve, reject) => {
        try {
            const data = await httpGet(url);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, data);
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

function atomicReplace(tempPath, finalPath) {
    fs.renameSync(tempPath, finalPath);
}

function deleteIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn(`Could not delete ${filePath}:`, error.message);
    }
}

function ensureZipappWrapper(pythonPath, zipappPath = ZIPAPP_PATH) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        ZIPAPP_WRAPPER,
        `#!/bin/sh\nexec "${pythonPath}" "${zipappPath}" "$@"\n`,
        { mode: 0o755 }
    );
    return ZIPAPP_WRAPPER;
}

function resolutionFromMeta(meta) {
    if (!meta?.execPath) {
        return null;
    }
    const prefixArgs = meta.execPrefixArgs || [];
    const probe = probeBinaryDetailed(meta.execPath, prefixArgs);
    if (!probe.ok) {
        return null;
    }
    return {
        command: meta.execPath,
        prefixArgs,
        displayPath: prefixArgs.length ? `${meta.execPath} ${prefixArgs.join(' ')}` : meta.execPath,
        version: meta.version || probe.version,
    };
}

function storeManagedResolution({ mode, version, execPath, execPrefixArgs = [], preferZipapp, assetPath }) {
    writeMeta({
        version,
        mode,
        execPath,
        execPrefixArgs,
        preferZipapp: !!preferZipapp,
        assetPath,
        managed: true,
    });
    resolvedYtDlp = {
        command: execPath,
        prefixArgs: execPrefixArgs,
        displayPath: execPrefixArgs.length ? `${execPath} ${execPrefixArgs.join(' ')}` : execPath,
        version,
    };
    featureSupport = null;
}

async function installNativeAsset(releaseTag) {
    const asset = nativeAssetName();
    if (!asset) {
        return null;
    }

    const finalPath = path.join(BIN_DIR, asset);
    const tempPath = `${finalPath}.download.${process.pid}`;

    try {
        await downloadToFile(`${YTDLP_RELEASE_BASE}/${asset}`, tempPath);
        chmodExecutable(tempPath);

        let probe = probeBinaryDetailed(tempPath);
        if (!probe.ok && asset === 'yt-dlp_linux_armv7l') {
            deleteIfExists(tempPath);
            const zipTemp = `${finalPath}.zip.download.${process.pid}`;
            await downloadToFile(`${YTDLP_RELEASE_BASE}/yt-dlp_linux_armv7l.zip`, zipTemp);
            const unzip = spawnSync('unzip', ['-o', '-j', zipTemp, '-d', BIN_DIR], { encoding: 'utf8' });
            deleteIfExists(zipTemp);
            if (unzip.status !== 0) {
                throw new Error(unzip.stderr || 'unzip failed');
            }
            const extracted = path.join(BIN_DIR, 'yt-dlp_linux_armv7l');
            if (fs.existsSync(extracted)) {
                fs.renameSync(extracted, tempPath);
                chmodExecutable(tempPath);
                probe = probeBinaryDetailed(tempPath);
            }
        }

        if (!probe.ok) {
            logProbeFailure('native download', tempPath, probe);
            deleteIfExists(tempPath);
            return null;
        }

        if (fs.existsSync(finalPath)) {
            deleteIfExists(`${finalPath}.bak`);
            fs.renameSync(finalPath, `${finalPath}.bak`);
        }
        atomicReplace(tempPath, finalPath);
        deleteIfExists(`${finalPath}.bak`);

        storeManagedResolution({
            mode: 'native',
            version: probe.version || releaseTag,
            execPath: finalPath,
            preferZipapp: false,
            assetPath: finalPath,
        });
        return resolvedYtDlp;
    } catch (error) {
        deleteIfExists(tempPath);
        console.warn('Native yt-dlp install failed:', error.message);
        return null;
    }
}

async function installZipapp(releaseTag) {
    const python = await requireZipappPython(releaseTag);
    const tempPath = `${ZIPAPP_PATH}.download.${process.pid}`;

    try {
        await downloadToFile(`${YTDLP_RELEASE_BASE}/${ZIPAPP_ASSET}`, tempPath);
        chmodExecutable(tempPath);

        const zipProbe = probeBinaryDetailed(python.path, [tempPath]);
        if (!zipProbe.ok) {
            logProbeFailure('zipapp download', `${python.path} ${tempPath}`, zipProbe);
            deleteIfExists(tempPath);
            throw new Error(`Downloaded yt-dlp zipapp failed --version with ${python.path}`);
        }

        if (fs.existsSync(ZIPAPP_PATH)) {
            deleteIfExists(`${ZIPAPP_PATH}.bak`);
            fs.renameSync(ZIPAPP_PATH, `${ZIPAPP_PATH}.bak`);
        }
        atomicReplace(tempPath, ZIPAPP_PATH);
        deleteIfExists(`${ZIPAPP_PATH}.bak`);

        const wrapper = ensureZipappWrapper(python.path);
        const wrapperProbe = probeBinaryDetailed(wrapper);
        if (!wrapperProbe.ok) {
            logProbeFailure('zipapp wrapper', wrapper, wrapperProbe);
            throw new Error('yt-dlp zipapp wrapper failed --version');
        }

        storeManagedResolution({
            mode: 'zipapp',
            version: zipProbe.version || releaseTag,
            execPath: wrapper,
            preferZipapp: true,
            assetPath: ZIPAPP_PATH,
        });
        return resolvedYtDlp;
    } catch (error) {
        deleteIfExists(tempPath);
        throw error;
    }
}

async function installManagedCopy(releaseTag, meta) {
    if (meta?.preferZipapp) {
        return installZipapp(releaseTag);
    }

    const native = await installNativeAsset(releaseTag);
    if (native) {
        return native;
    }

    if (is32BitArmLinux()) {
        console.warn(
            'Native yt-dlp_linux_armv7l does not run on this device; using zipapp with YTDLP_PYTHON.'
        );
        writeMeta({ preferZipapp: true });
    }

    return installZipapp(releaseTag);
}

function shouldCheckGitHub(meta) {
    if (!meta?.lastGithubCheckAt) {
        return true;
    }
    return Date.now() - meta.lastGithubCheckAt > VERSION_CHECK_INTERVAL_MS;
}

function getInstalledVersion(meta, resolution) {
    if (meta?.version) {
        return meta.version;
    }
    if (resolution?.version) {
        return resolution.version.replace(/^v/, '').trim();
    }
    const probe = resolution ? probeBinaryDetailed(resolution.command, resolution.prefixArgs) : null;
    return probe?.version || null;
}

async function ensureManagedYtDlp({ reason = 'startup' } = {}) {
    if (process.env.YTDLP_BINARY_PATH) {
        const envPath = process.env.YTDLP_BINARY_PATH;
        if (!fs.existsSync(envPath)) {
            throw new Error(`YTDLP_BINARY_PATH does not exist: ${envPath}`);
        }
        const probe = probeBinaryDetailed(envPath);
        if (!probe.ok) {
            logProbeFailure('YTDLP_BINARY_PATH', envPath, probe);
            throw new Error(`YTDLP_BINARY_PATH failed --version: ${envPath}`);
        }
        resolvedYtDlp = {
            command: envPath,
            prefixArgs: [],
            displayPath: envPath,
            version: probe.version,
        };
        featureSupport = null;
        return { resolution: resolvedYtDlp, status: 'env-override', previousVersion: null, latestTag: null };
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    let meta = readMeta();
    let resolution = resolutionFromMeta(meta);
    if (resolution) {
        resolvedYtDlp = resolution;
    }

    let status = 'unchanged';
    let previousVersion = getInstalledVersion(meta, resolution);
    let latestTag = meta?.latestKnownRelease || null;

    if (!shouldCheckGitHub(meta)) {
        if (resolution) {
            resolvedYtDlp = resolution;
            return finalizeManagedResult({
                resolution: resolvedYtDlp,
                status: 'already-latest',
                previousVersion,
                latestTag,
            });
        }
    }

    try {
        latestTag = await fetchLatestReleaseTag();
        writeMeta({ lastGithubCheckAt: Date.now(), latestKnownRelease: latestTag });
        meta = readMeta();
    } catch (error) {
        console.warn(`yt-dlp GitHub version check failed (${reason}): ${error.message}`);
        if (resolution) {
            resolvedYtDlp = resolution;
            return finalizeManagedResult({
                resolution: resolvedYtDlp,
                status: 'github-unreachable',
                previousVersion,
                latestTag,
            });
        }
        throw new Error('No managed yt-dlp copy and GitHub is unreachable');
    }

    resolution = resolutionFromMeta(meta) || resolution;
    const installedVersion = getInstalledVersion(meta, resolution);
    const needsInstall = !resolution;
    const needsUpgrade = installedVersion && compareReleaseVersions(installedVersion, latestTag) < 0;

    if (!needsInstall && !needsUpgrade) {
        if (resolution) {
            resolvedYtDlp = resolution;
        }
        return finalizeManagedResult({
            resolution: resolvedYtDlp,
            status: 'already-latest',
            previousVersion: installedVersion,
            latestTag,
        });
    }

    previousVersion = installedVersion;
    try {
        await installManagedCopy(latestTag, meta);
        status = needsInstall ? 'installed' : 'updated';
    } catch (error) {
        console.error('Managed yt-dlp update failed:', error.message);
        if (resolution) {
            resolvedYtDlp = resolution;
            return finalizeManagedResult({
                resolution: resolvedYtDlp,
                status: 'update-failed-kept-existing',
                previousVersion: installedVersion,
                latestTag,
            });
        }
        throw error;
    }

    return finalizeManagedResult({ resolution: resolvedYtDlp, status, previousVersion, latestTag });
}

function resolveYtDlpCommand() {
    if (!resolvedYtDlp) {
        throw new Error('Managed yt-dlp is not ready; call ensureManagedYtDlp() first');
    }
    return resolvedYtDlp;
}

function runHelp(resolution) {
    const result = spawnSync(
        resolution.command,
        [...resolution.prefixArgs, '--help'],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function getFeatureSupport(resolution) {
    if (featureSupport) {
        return featureSupport;
    }
    const help = runHelp(resolution);
    featureSupport = {
        jsRuntimes: /--js-runtimes\b/m.test(help),
        noWarnings: /--no-warnings\b/m.test(help),
        extractorArgs: /--extractor-args\b/m.test(help),
        fragmentRetries: /--fragment-retries\b/m.test(help),
        extractorRetries: /--extractor-retries\b/m.test(help),
    };
    return featureSupport;
}

function disableFeature(flag) {
    if (!featureSupport) {
        return;
    }
    if (flag === '--js-runtimes') {
        featureSupport.jsRuntimes = false;
    } else if (flag === '--no-warnings') {
        featureSupport.noWarnings = false;
    } else if (flag === '--extractor-args') {
        featureSupport.extractorArgs = false;
    } else if (flag === '--fragment-retries') {
        featureSupport.fragmentRetries = false;
    } else if (flag === '--extractor-retries') {
        featureSupport.extractorRetries = false;
    }
}

function parseUnsupportedOption(errorMessage) {
    const match = errorMessage.match(/no such option: (--[\w-]+)/i);
    return match ? match[1] : null;
}

function jsRuntimeArgs(features) {
    if (!features.jsRuntimes) {
        return [];
    }
    const args = ['--js-runtimes', `node:${process.execPath}`];
    const deno = spawnSync('sh', ['-c', 'command -v deno 2>/dev/null'], { encoding: 'utf8' });
    if (deno.status === 0 && deno.stdout.trim()) {
        args.push('--js-runtimes', `deno:${deno.stdout.trim()}`);
    }
    return args;
}

function buildDownloadArgs(url, outputPath, features) {
    const args = ['--no-playlist', '-f', AUDIO_FORMAT, '-o', outputPath, '--retries', '5'];
    if (features.fragmentRetries) {
        args.push('--fragment-retries', '10');
    }
    if (features.extractorRetries) {
        args.push('--extractor-retries', '5');
    }
    if (features.noWarnings) {
        args.push('--no-warnings');
    }
    args.push(...jsRuntimeArgs(features));
    if (features.extractorArgs) {
        args.push(
            '--extractor-args',
            `youtube:player_client=${YOUTUBE_PLAYER_CLIENTS.join(',')}`
        );
    }
    args.push(url);
    return args;
}

function runDownload(resolution, url, outputPath, onProgress) {
    const features = getFeatureSupport(resolution);
    const args = buildDownloadArgs(url, outputPath, features);

    return new Promise((resolve, reject) => {
        const child = spawn(resolution.command, [...resolution.prefixArgs, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        const handleChunk = (chunk) => {
            const text = chunk.toString();
            stderr += text;
            if (onProgress) {
                const percentMatch = text.match(/(\d+(?:\.\d+)?)%/);
                if (percentMatch) {
                    onProgress(Number(percentMatch[1]));
                }
            }
        };

        child.stderr.on('data', handleChunk);
        child.stdout.on('data', handleChunk);
        child.on('error', (error) => reject(new Error(`Failed to start yt-dlp: ${error.message}`)));
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`));
        });
    });
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

function logManagedStatus(result) {
    const { resolution, status, previousVersion, latestTag } = result;
    if (!resolution) {
        return;
    }
    const pathInfo = resolution.displayPath;
    const versionInfo = resolution.version || 'unknown';

    if (status === 'updated') {
        console.log(
            `Managed yt-dlp: ${pathInfo} (${versionInfo}) — updated from ${previousVersion} to ${latestTag}`
        );
    } else if (status === 'installed') {
        console.log(`Managed yt-dlp: ${pathInfo} (${versionInfo}) — installed (latest ${latestTag})`);
    } else if (status === 'already-latest') {
        console.log(`Managed yt-dlp: ${pathInfo} (${versionInfo}) — already latest`);
    } else if (status === 'env-override') {
        console.log(`Managed yt-dlp: using YTDLP_BINARY_PATH ${pathInfo} (${versionInfo})`);
    } else if (status === 'github-unreachable') {
        console.log(
            `Managed yt-dlp: ${pathInfo} (${versionInfo}) — GitHub unreachable, keeping existing copy`
        );
    } else if (status === 'update-failed-kept-existing') {
        console.log(
            `Managed yt-dlp: ${pathInfo} (${versionInfo}) — update failed, keeping existing copy`
        );
    }
}

async function downloadYoutubeAudio(url, outputPath, onProgress) {
    const check = await ensureManagedYtDlp({ reason: 'add-sound' });
    if (check.status !== 'already-latest') {
        logManagedStatus(check);
    }
    const resolution = resolveYtDlpCommand();

    try {
        await runDownload(resolution, url, outputPath, onProgress);
    } catch (error) {
        const message = error?.message || String(error);
        const unsupported = parseUnsupportedOption(message);
        if (unsupported) {
            disableFeature(unsupported);
            try {
                await runDownload(resolution, url, outputPath, onProgress);
                return;
            } catch (retryError) {
                throw new Error(
                    sanitizeYtDlpError(retryError?.message || String(retryError)) ||
                        'yt-dlp download failed'
                );
            }
        }
        throw new Error(sanitizeYtDlpError(message) || 'yt-dlp download failed');
    }
}

async function initYtDlpOnStartup() {
    try {
        const result = await ensureManagedYtDlp({ reason: 'startup' });
        if (result.resolution) {
            getFeatureSupport(result.resolution);
        }
        logManagedStatus(result);
    } catch (error) {
        console.warn('Managed yt-dlp not ready at startup (bot will still run):', error.message);
    }
}

module.exports = {
    initYtDlpOnStartup,
    downloadYoutubeAudio,
    sanitizeYtDlpError,
    resolveYtDlpCommand,
    ensureManagedYtDlp,
};
