#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TV_TRANSPORT = path.join(ROOT, 'lib', 'tv.sh');
const TV_HELPER = path.join(ROOT, 'tv', 'download-ipk.js');

function fail(message) {
  process.stderr.write(`lg-ipk-download: ${message}\n`);
  process.exitCode = 1;
}

function usage() {
  process.stdout.write(`Usage:
  lg-ipk-download [options] <internal-app-id|numeric-store-id>

Options:
  -o, --output <path>       Local output path
  -d, --device <name>       ares-setup-device profile name
      --country <code>      Store country/region (e.g. US, DE, CN)
      --api-version <ver>   SDP apps API version (default: 10.0.0)
      --timeout <seconds>   Download timeout (default: 180)
      --keep-remote         Keep the downloaded file on the TV
      --force               Replace an existing output file
      --json                Print the final result as JSON
  -h, --help                Show this help

Numeric store IDs use the selected country's LG Apps site (default: US).
Without --country, TV requests use the TV's current store region.
`);
}

function parseArgs(argv) {
  const options = {
    apiVersion: '10.0.0',
    timeout: 180,
    keepRemote: false,
    force: false,
    json: false,
    output: null,
    device: null,
    country: null,
    input: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '-o' || arg === '--output') {
      options.output = argv[++i];
    } else if (arg === '-d' || arg === '--device') {
      options.device = argv[++i];
    } else if (arg === '--country') {
      options.country = argv[++i];
    } else if (arg === '--api-version') {
      options.apiVersion = argv[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number(argv[++i]);
    } else if (arg === '--keep-remote') {
      options.keepRemote = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.input) {
      throw new Error('only one app identifier may be specified');
    } else {
      options.input = arg;
    }
  }
  if (!options.input) throw new Error('app identifier is required');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(options.apiVersion || '')) {
    throw new Error('API version must look like 10.0.0');
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 15 || options.timeout > 3600) {
    throw new Error('timeout must be between 15 and 3600 seconds');
  }
  if ((options.output === undefined) || (options.device === undefined) ||
      (options.apiVersion === undefined) || (options.country === undefined)) {
    throw new Error('an option value is missing');
  }
  if (options.country !== null) {
    if (!/^(?:[A-Za-z]{2}|C01)$/i.test(options.country)) {
      throw new Error('country must be a two-letter code such as US, DE, or CN');
    }
    options.country = options.country.toUpperCase();
    if (options.country === 'C01') options.country = 'CN';
  }
  return options;
}

function requestWebsiteApp(appId, country) {
  return new Promise((resolve, reject) => {
    const storeCountry = country === 'CN' ? 'C01' : country || 'US';
    const website = country === 'CN' ? 'wasu' : storeCountry.toLowerCase();
    const body = `appId=${encodeURIComponent(appId)}&searchCntryCode=${storeCountry}`;
    const request = https.request({
      hostname: `${website}.lgappstv.com`,
      port: 443,
      method: 'POST',
      path: '/api/tvapp/retrieveAppInfo.ajax',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`LG Apps metadata HTTP ${response.statusCode}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          reject(new Error('LG Apps metadata returned invalid JSON'));
          return;
        }
        const product = (parsed.prodInfo || [])[0];
        if (!product || !product.appName || !product.catCode) {
          reject(new Error(`LG Apps store ID ${appId} was not found in ${country || 'US'}`));
          return;
        }
        resolve({
          webAppId: String(appId),
          catalogName: String(product.appName),
          categoryId: String(product.catCode),
          websiteVersion: product.appVer ? String(product.appVer) : null
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('LG Apps metadata timeout')));
    request.end(body);
  });
}

async function resolveInput(input, country) {
  if (/^[0-9]+$/.test(input)) {
    return requestWebsiteApp(input, country);
  }
  if (/^https?:\/\//i.test(input)) {
    throw new Error('store page URLs are not supported; pass the numeric appId instead');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input)) {
    throw new Error('internal app ID contains unsupported characters');
  }
  return { appId: input };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runTransport(action, args, options) {
  const env = Object.assign({}, process.env, {
    TV_TIMEOUT: String(Math.max(options.timeout + 60, 120))
  });
  if (options.device) env.TV_DEVICE = options.device;
  const result = childProcess.spawnSync(TV_TRANSPORT, [action].concat(args), {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${action} failed${detail ? `: ${detail}` : ''}`);
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function parseLastJson(output) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i][0] !== '{') continue;
    try {
      return JSON.parse(lines[i]);
    } catch (error) {
      // Continue looking for the final machine-readable line.
    }
  }
  throw new Error('TV helper did not return a JSON result');
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolvedInput = await resolveInput(options.input, options.country);
  const remoteHelper = `/tmp/lg-ipk-download-${process.pid}.js`;
  let download = null;
  let pulled = false;

  runTransport('push', [TV_HELPER, remoteHelper], options);
  try {
    const commandParts = [
      'NODE_PATH=/usr/lib/node_modules:/usr/lib/nodejs',
      'node',
      shellQuote(remoteHelper),
      '--api-version', shellQuote(options.apiVersion),
      '--timeout', shellQuote(String(options.timeout))
    ];
    if (options.country) {
      commandParts.push('--country', shellQuote(options.country));
    }
    if (resolvedInput.appId) {
      commandParts.push('--app-id', shellQuote(resolvedInput.appId));
    } else {
      commandParts.push(
        '--catalog-name', shellQuote(resolvedInput.catalogName),
        '--category-id', shellQuote(resolvedInput.categoryId),
        '--web-app-id', shellQuote(resolvedInput.webAppId)
      );
    }
    const command = commandParts.join(' ');
    const result = runTransport('run', [command], options);
    if (result.stderr) process.stderr.write(result.stderr);
    download = parseLastJson(result.stdout);
    if (!download.ok) throw new Error(download.error || 'TV download failed');

    const defaultName = `${download.appId}_${download.packageVersion}.ipk`;
    const output = path.resolve(options.output || defaultName);
    if (fs.existsSync(output) && !options.force) {
      throw new Error(`output already exists: ${output} (use --force to replace it)`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const partial = `${output}.partial-${process.pid}`;
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      runTransport('pull', [download.remotePath, partial], options);
      const size = fs.statSync(partial).size;
      if (size !== download.expectedSize) {
        throw new Error(`size mismatch: expected ${download.expectedSize}, received ${size}`);
      }
      const sha256 = await sha256File(partial);
      if (fs.existsSync(output)) fs.unlinkSync(output);
      fs.renameSync(partial, output);
      pulled = true;

      const finalResult = {
        appId: download.appId,
        webAppId: download.webAppId || null,
        installedVersion: download.installedVersion,
        storeVersion: download.storeVersion,
        packageVersion: download.packageVersion,
        size,
        sha256,
        output
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(finalResult)}\n`);
      } else {
        if (download.webAppId) {
          process.stdout.write(`Resolved LG Apps ${download.webAppId} -> ${download.appId}\n`);
        }
        process.stdout.write(`Downloaded ${download.appId} ${download.packageVersion}\n`);
        process.stdout.write(`Output:  ${output}\n`);
        process.stdout.write(`Size:    ${size} bytes\n`);
        process.stdout.write(`SHA-256: ${sha256}\n`);
      }
    } finally {
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
    }

    if (!options.keepRemote && pulled) {
      const cleanupCommand = [
        'rm -f --', shellQuote(download.remotePath),
        '; rmdir', shellQuote(path.posix.dirname(download.remotePath)),
        '2>/dev/null || true'
      ].join(' ');
      try {
        runTransport('run', [cleanupCommand], options);
      } catch (error) {
        process.stderr.write(`warning: TV file cleanup failed: ${error.message}\n`);
      }
    }
  } finally {
    const removeCommand = `rm -f -- ${shellQuote(remoteHelper)}`;
    try {
      runTransport('run', [removeCommand], options);
    } catch (error) {
      process.stderr.write(`warning: temporary helper cleanup failed: ${error.message}\n`);
    }
    if (download && !pulled) {
      process.stderr.write(`TV file retained for recovery: ${download.remotePath}\n`);
    }
  }
}

main().catch(error => fail(error.message));
