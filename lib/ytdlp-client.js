const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
/** @type {{ jsRuntimes: boolean, noWarnings: boolean, extractorArgs: boolean } | null} */
let featureSupport = null;

function probeVersion(command, prefixArgs = []) {
    const result = spawnSync(command, [...prefixArgs, '--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
        return null;
    }
    return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

function probeCommand(command, prefixArgs = []) {
    const version = probeVersion(command, prefixArgs);
    if (!version) {
        return null;
    }
    return { command, prefixArgs, displayPath: formatDisplayPath(command, prefixArgs), version };
}

function formatDisplayPath(command, prefixArgs) {
    if (prefixArgs.length === 0) {
        return command;
    }
    return `${command} ${prefixArgs.join(' ')}`.trim();
}

function findYtDlpOnPath() {
    const candidates = [];

    if (process.env.YTDLP_BINARY_PATH) {
        candidates.push(process.env.YTDLP_BINARY_PATH);
    }

    const home = process.env.HOME || os.homedir();
    candidates.push(path.join(home, '.local', 'bin', 'yt-dlp'));

    const which = spawnSync('sh', ['-c', 'command -v yt-dlp'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) {
        candidates.push(which.stdout.trim());
    }

    candidates.push('/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp');

    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const resolved = probeCommand(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

function findPythonModuleYtDlp() {
    return probeCommand('python3', ['-m', 'yt_dlp']);
}

function resolveYtDlpCommand() {
    if (resolvedYtDlp) {
        return resolvedYtDlp;
    }

    const fromPath = findYtDlpOnPath();
    if (fromPath) {
        resolvedYtDlp = fromPath;
        return resolvedYtDlp;
    }

    const fromPython = findPythonModuleYtDlp();
    if (fromPython) {
        resolvedYtDlp = fromPython;
        return resolvedYtDlp;
    }

    throw new Error(
        'yt-dlp was not found. Install it with: pip3 install -U yt-dlp ' +
            '(ensure ~/.local/bin is on your PATH, or set YTDLP_BINARY_PATH).'
    );
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

        child.on('error', (error) => {
            reject(new Error(`Failed to start yt-dlp: ${error.message}`));
        });

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

async function downloadYoutubeAudio(url, outputPath, onProgress) {
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

function initYtDlpOnStartup() {
    try {
        const resolution = resolveYtDlpCommand();
        getFeatureSupport(resolution);
        console.log(`yt-dlp resolved: ${resolution.displayPath} (version ${resolution.version})`);
    } catch (error) {
        console.error(error.message);
        console.error('Install yt-dlp with: pip3 install -U yt-dlp');
    }
}

module.exports = {
    initYtDlpOnStartup,
    downloadYoutubeAudio,
    sanitizeYtDlpError,
    resolveYtDlpCommand,
};
