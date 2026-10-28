const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const META_PATH = path.join(BIN_DIR, '.yt-dlp-meta.json');
const YTDLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const GITHUB_LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const ZIPAPP_ASSET = 'yt-dlp';
const ZIPAPP_PATH = path.join(BIN_DIR, ZIPAPP_ASSET);
const ZIPAPP_WRAPPER = path.join(BIN_DIR, 'yt-dlp-zipapp-wrapper');
const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UV_PYTHON_INSTALL_HINT =
    'curl -LsSf https://astral.sh/uv/install.sh | sh && ~/.local/bin/uv python install 3.12';

function getEffectiveHome() {
    return process.env.HOME || os.homedir();
}

const AUDIO_FORMAT =
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[height<=480]/best';

const PLAYER_CLIENT_STRATEGIES = [
    ['ios', 'web'],
    ['mweb', 'web'],
    ['android', 'web'],
    ['tv', 'web'],
    ['web'],
];

/** @type {{ command: string, prefixArgs: string[], displayPath: string, version: string } | null} */
let resolvedYtDlp = null;
/** @type {object | null} */
let featureSupport = null;

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

function realpathSafe(filePath) {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return filePath;
    }
}

function resolveExecutable(nameOrPath) {
    if (nameOrPath.includes('/')) {
        if (!fs.existsSync(nameOrPath)) {
            return null;
        }
        return realpathSafe(nameOrPath);
    }
    const result = spawnSync('sh', ['-c', `command -v ${nameOrPath} 2>/dev/null`], {
        encoding: 'utf8',
    });
    if (result.status !== 0 || !result.stdout.trim()) {
        return null;
    }
    return realpathSafe(result.stdout.trim());
}

function getPythonVersionInfo(interpreterPath) {
    const probe = spawnSync(interpreterPath, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
        return {
            error: `exit ${probe.status}${probe.stderr ? `: ${probe.stderr.trim()}` : ''}`,
        };
    }
    const text = (probe.stdout || probe.stderr || '').trim();
    const parsed = parsePythonVersionString(text);
    if (!parsed) {
        return { error: `unparseable version output: ${text}` };
    }
    return { path: interpreterPath, text, parsed };
}

function findUvExecutable() {
    const home = getEffectiveHome();
    const candidates = [
        'uv',
        path.join(home, '.local', 'bin', 'uv'),
        path.join(home, '.cargo', 'bin', 'uv'),
    ];
    for (const candidate of candidates) {
        const resolved = resolveExecutable(candidate);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}

function runUvPythonFind(uvPath, minVersionStr, diagnostics) {
    const spec = `>=${minVersionStr}`;
    const result = spawnSync(uvPath, ['python', 'find', spec], { encoding: 'utf8' });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        diagnostics.push(`uv python find '${spec}': rejected — exit ${result.status}${detail ? ` (${detail})` : ''}`);
        return null;
    }
    const found = result.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)[0];
    if (!found) {
        diagnostics.push(`uv python find '${spec}': rejected — empty output`);
        return null;
    }
    diagnostics.push(`uv python find '${spec}': candidate ${found}`);
    return found;
}

function getUvPythonInstallRoots(uvPath, diagnostics) {
    const roots = new Set();
    if (process.env.UV_PYTHON_INSTALL_DIR) {
        roots.add(process.env.UV_PYTHON_INSTALL_DIR);
        diagnostics.push(`UV_PYTHON_INSTALL_DIR: ${process.env.UV_PYTHON_INSTALL_DIR}`);
    }

    const home = getEffectiveHome();
    roots.add(path.join(home, '.local', 'share', 'uv', 'python'));

    if (uvPath) {
        const result = spawnSync(uvPath, ['python', 'dir'], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim()) {
            roots.add(result.stdout.trim());
            diagnostics.push(`uv python dir: ${result.stdout.trim()}`);
        } else {
            const detail = (result.stderr || result.stdout || '').trim();
            diagnostics.push(
                `uv python dir: rejected — exit ${result.status}${detail ? ` (${detail})` : ''}`
            );
        }
    }

    return [...roots];
}

function isPythonBinName(fileName) {
    return /^python(3(\.\d+)?)?$/.test(fileName);
}

function scanUvPythonInstallRoot(root) {
    const paths = [];
    if (!root || !fs.existsSync(root)) {
        return paths;
    }

    const collectFromBin = (binDir) => {
        if (!fs.existsSync(binDir)) {
            return;
        }
        for (const file of fs.readdirSync(binDir)) {
            if (isPythonBinName(file)) {
                paths.push(path.join(binDir, file));
            }
        }
    };

    collectFromBin(path.join(root, 'bin'));

    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return paths;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            collectFromBin(path.join(root, entry.name, 'bin'));
        }
    }

    return paths;
}

function discoverUvPythonInterpreters(uvPath, diagnostics) {
    const interpreters = [];
    for (const root of getUvPythonInstallRoots(uvPath, diagnostics)) {
        for (const interpreter of scanUvPythonInstallRoot(root)) {
            interpreters.push(interpreter);
        }
    }
    return interpreters;
}

function collectPathPythonCandidates() {
    const home = getEffectiveHome();
    const searchDirs = [
        path.join(home, '.local', 'bin'),
        ...(process.env.PATH || '').split(':').filter(Boolean),
    ];
    const bareNames = [
        'python3.14',
        'python3.13',
        'python3.12',
        'python3.11',
        'python3',
        'python',
    ];
    const candidates = new Set();

    for (const name of bareNames) {
        for (const dir of searchDirs) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                candidates.add(full);
            }
        }
        const resolved = resolveExecutable(name);
        if (resolved) {
            candidates.add(resolved);
        }
    }

    return [...candidates];
}

function collectPythonCandidates(uvPath, diagnostics) {
    const candidates = new Set();
    for (const interpreter of discoverUvPythonInterpreters(uvPath, diagnostics)) {
        candidates.add(interpreter);
    }
    for (const interpreter of collectPathPythonCandidates()) {
        candidates.add(interpreter);
    }
    return [...candidates];
}

function evaluatePythonCandidate(candidatePath, minVersionStr, diagnostics, source) {
    if (!candidatePath) {
        diagnostics.push(`${source}: rejected — empty path`);
        return null;
    }

    if (!fs.existsSync(candidatePath)) {
        diagnostics.push(`${source}: ${candidatePath} — rejected (not found)`);
        return null;
    }

    const resolved = realpathSafe(candidatePath);
    const info = getPythonVersionInfo(resolved);
    if (info.error) {
        diagnostics.push(`${source}: ${resolved} — rejected (${info.error})`);
        return null;
    }
    if (!pythonVersionAtLeast(info.parsed, minVersionStr)) {
        diagnostics.push(
            `${source}: ${resolved} (${info.text}) — rejected (requires >= ${minVersionStr})`
        );
        return null;
    }
    diagnostics.push(`${source}: ${resolved} (${info.text}) — accepted`);
    return info;
}

function logPythonCandidateDiagnostics(diagnostics) {
    console.log('yt-dlp Python candidate scan:');
    for (const line of diagnostics) {
        console.log(`  ${line}`);
    }
}

function selectZipappPython(minVersionStr) {
    const diagnostics = [];

    if (process.env.YTDLP_PYTHON) {
        diagnostics.push(`YTDLP_PYTHON env: ${process.env.YTDLP_PYTHON}`);
        const resolved = resolveExecutable(process.env.YTDLP_PYTHON) || process.env.YTDLP_PYTHON;
        const info = evaluatePythonCandidate(resolved, minVersionStr, diagnostics, 'YTDLP_PYTHON');
        logPythonCandidateDiagnostics(diagnostics);
        if (info) {
            return info;
        }
        throw new Error(
            `YTDLP_PYTHON ${process.env.YTDLP_PYTHON} is not usable for yt-dlp (needs Python >= ${minVersionStr})`
        );
    }

    const uvPath = findUvExecutable();
    if (uvPath) {
        diagnostics.push(`uv executable: ${uvPath}`);
        const uvFound = runUvPythonFind(uvPath, minVersionStr, diagnostics);
        if (uvFound) {
            const uvInfo = evaluatePythonCandidate(
                uvFound,
                minVersionStr,
                diagnostics,
                'uv python find'
            );
            if (uvInfo) {
                logPythonCandidateDiagnostics(diagnostics);
                return uvInfo;
            }
        }
    } else {
        diagnostics.push('uv executable: not found (checked PATH, ~/.local/bin/uv, ~/.cargo/bin/uv)');
    }

    const qualifying = [];
    const seen = new Set();
    for (const candidate of collectPythonCandidates(uvPath, diagnostics)) {
        const info = evaluatePythonCandidate(candidate, minVersionStr, diagnostics, 'scan');
        if (info && !seen.has(info.path)) {
            seen.add(info.path);
            qualifying.push(info);
        }
    }

    logPythonCandidateDiagnostics(diagnostics);

    qualifying.sort((a, b) => comparePythonParsed(b.parsed, a.parsed));

    if (qualifying.length === 0) {
        const systemPath = resolveExecutable('python3');
        let systemNote = '';
        if (systemPath) {
            const systemInfo = getPythonVersionInfo(systemPath);
            if (systemInfo.text) {
                systemNote = ` (system python3 is ${systemInfo.text})`;
            }
        }
        throw new Error(
            `No Python >= ${minVersionStr} found for yt-dlp zipapp${systemNote}. ` +
                `Install a newer Python with:\n  ${UV_PYTHON_INSTALL_HINT}`
        );
    }

    return qualifying[0];
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

function ensureZipappWrapper(zipappPath = ZIPAPP_PATH, pythonPath) {
    if (!pythonPath) {
        throw new Error('ensureZipappWrapper requires pythonPath');
    }
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(
        ZIPAPP_WRAPPER,
        `#!/bin/sh\nexec "${pythonPath}" "${zipappPath}" "$@"\n`,
        { mode: 0o755 }
    );
    return ZIPAPP_WRAPPER;
}

async function syncZipappWrapper(releaseTag) {
    const meta = readMeta();
    if (meta?.mode !== 'zipapp' || !fs.existsSync(ZIPAPP_PATH)) {
        return null;
    }

    const minPython = await fetchMinimumPythonVersion(releaseTag || meta.latestKnownRelease || 'master');
    const pythonInfo = selectZipappPython(minPython);
    ensureZipappWrapper(ZIPAPP_PATH, pythonInfo.path);
    writeMeta({
        pythonInterpreter: pythonInfo.path,
        pythonVersion: pythonInfo.text,
    });
    return pythonInfo;
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

function storeManagedResolution({
    mode,
    version,
    execPath,
    execPrefixArgs = [],
    preferZipapp,
    assetPath,
    pythonInterpreter,
    pythonVersion,
}) {
    writeMeta({
        version,
        mode,
        execPath,
        execPrefixArgs,
        preferZipapp: !!preferZipapp,
        assetPath,
        managed: true,
        pythonInterpreter,
        pythonVersion,
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
    const minPython = await fetchMinimumPythonVersion(releaseTag);
    const pythonInfo = selectZipappPython(minPython);

    const tempPath = `${ZIPAPP_PATH}.download.${process.pid}`;
    try {
        await downloadToFile(`${YTDLP_RELEASE_BASE}/${ZIPAPP_ASSET}`, tempPath);
        chmodExecutable(tempPath);

        const zipProbe = probeBinaryDetailed(pythonInfo.path, [tempPath]);
        if (!zipProbe.ok) {
            logProbeFailure('zipapp download', `${pythonInfo.path} ${tempPath}`, zipProbe);
            deleteIfExists(tempPath);
            throw new Error(
                `Downloaded yt-dlp zipapp failed --version with ${pythonInfo.path} (${pythonInfo.text})`
            );
        }

        if (fs.existsSync(ZIPAPP_PATH)) {
            deleteIfExists(`${ZIPAPP_PATH}.bak`);
            fs.renameSync(ZIPAPP_PATH, `${ZIPAPP_PATH}.bak`);
        }
        atomicReplace(tempPath, ZIPAPP_PATH);
        deleteIfExists(`${ZIPAPP_PATH}.bak`);

        const wrapper = ensureZipappWrapper(ZIPAPP_PATH, pythonInfo.path);
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
            pythonInterpreter: pythonInfo.path,
            pythonVersion: pythonInfo.text,
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
            'Native yt-dlp_linux_armv7l does not run on this device; using zipapp via a compatible Python.'
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
            if (meta?.mode === 'zipapp') {
                try {
                    await syncZipappWrapper(meta.latestKnownRelease);
                } catch (error) {
                    console.warn('Could not refresh zipapp Python wrapper:', error.message);
                }
            }
            return {
                resolution: resolvedYtDlp,
                status: 'already-latest',
                previousVersion,
                latestTag,
            };
        }
        // No local copy yet — install even if we checked GitHub recently.
    }

    try {
        latestTag = await fetchLatestReleaseTag();
        writeMeta({ lastGithubCheckAt: Date.now(), latestKnownRelease: latestTag });
        meta = readMeta();
    } catch (error) {
        console.warn(`yt-dlp GitHub version check failed (${reason}): ${error.message}`);
        if (resolution) {
            resolvedYtDlp = resolution;
            return {
                resolution: resolvedYtDlp,
                status: 'github-unreachable',
                previousVersion,
                latestTag,
            };
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
        if (meta?.mode === 'zipapp') {
            try {
                await syncZipappWrapper(latestTag);
            } catch (error) {
                console.warn('Could not refresh zipapp Python wrapper:', error.message);
            }
        }
        return {
            resolution: resolvedYtDlp,
            status: 'already-latest',
            previousVersion: installedVersion,
            latestTag,
        };
    }

    previousVersion = installedVersion;
    try {
        await installManagedCopy(latestTag, meta);
        status = needsInstall ? 'installed' : 'updated';
    } catch (error) {
        console.error('Managed yt-dlp update failed:', error.message);
        if (resolution) {
            resolvedYtDlp = resolution;
            return {
                resolution: resolvedYtDlp,
                status: 'update-failed-kept-existing',
                previousVersion: installedVersion,
                latestTag,
            };
        }
        throw error;
    }

    return { resolution: resolvedYtDlp, status, previousVersion, latestTag };
}

function resolveYtDlpCommand() {
    if (process.env.YTDLP_BINARY_PATH) {
        if (!resolvedYtDlp) {
            throw new Error('Call ensureManagedYtDlp() before resolveYtDlpCommand()');
        }
        return resolvedYtDlp;
    }
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
    const deno = spawnSync('sh', ['-c', 'command -v deno'], { encoding: 'utf8' });
    if (deno.status === 0 && deno.stdout.trim()) {
        args.push('--js-runtimes', `deno:${deno.stdout.trim()}`);
    }
    return args;
}

function buildDownloadArgs(url, outputPath, clients, features) {
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
        args.push('--extractor-args', `youtube:player_client=${clients.join(',')}`);
    }
    args.push(url);
    return args;
}

function runDownload(resolution, url, outputPath, clients, onProgress) {
    const features = getFeatureSupport(resolution);
    const args = buildDownloadArgs(url, outputPath, clients, features);

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

function logManagedStatus(result) {
    const { resolution, status, previousVersion, latestTag } = result;
    if (!resolution) {
        return;
    }
    const pathInfo = resolution.displayPath;
    const versionInfo = resolution.version || 'unknown';
    const meta = readMeta();

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

    if (meta?.pythonInterpreter) {
        console.log(
            `yt-dlp zipapp interpreter: ${meta.pythonInterpreter} (${meta.pythonVersion || 'unknown'})`
        );
    }
}

async function downloadYoutubeAudio(url, outputPath, onProgress) {
    const check = await ensureManagedYtDlp({ reason: 'add-sound' });
    if (check.status !== 'already-latest') {
        logManagedStatus(check);
    }
    const resolution = resolveYtDlpCommand();

    let lastError;
    for (const clients of PLAYER_CLIENT_STRATEGIES) {
        try {
            await runDownload(resolution, url, outputPath, clients, onProgress);
            return;
        } catch (error) {
            lastError = error;
            const message = error?.message || String(error);
            const unsupported = parseUnsupportedOption(message);
            if (unsupported) {
                disableFeature(unsupported);
                try {
                    await runDownload(resolution, url, outputPath, clients, onProgress);
                    return;
                } catch (retryError) {
                    lastError = retryError;
                }
            }

            const retryMessage = lastError?.message || String(lastError);
            if (!isRetriableDownloadError(retryMessage)) {
                throw lastError;
            }
            console.warn(
                `yt-dlp failed with clients [${clients.join(', ')}], trying next strategy...`
            );
        }
    }

    const raw = lastError?.message || String(lastError);
    throw new Error(sanitizeYtDlpError(raw) || 'yt-dlp download failed');
}

async function initYtDlpOnStartup() {
    try {
        const result = await ensureManagedYtDlp({ reason: 'startup' });
        getFeatureSupport(result.resolution);
        logManagedStatus(result);
    } catch (error) {
        console.error('Failed to prepare managed yt-dlp:', error.message);
    }
}

module.exports = {
    initYtDlpOnStartup,
    downloadYoutubeAudio,
    sanitizeYtDlpError,
    resolveYtDlpCommand,
    ensureManagedYtDlp,
};
