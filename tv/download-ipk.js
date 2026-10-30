#!/usr/bin/env node
'use strict';

// Runs on the TV. Sensitive SDX headers and signed URLs never leave this
// process; stdout contains only non-sensitive metadata.
var Module = require('module');
var originalLoad = Module._load;
var noop = function () {};
var logger = function () {
  return { log: noop, info: noop, warn: noop, warning: noop, error: noop };
};

Module._load = function (request) {
  if (request === 'pmloglib') {
    return {
      log: noop,
      info: noop,
      warning: noop,
      error: noop,
      Console: logger,
      Context: logger
    };
  }
  return originalLoad.apply(this, arguments);
};

var fs = require('fs');
var https = require('https');
var path = require('path');
var url = require('url');
var palmbus = require('palmbus');

var args = {};
for (var i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i]] = process.argv[i + 1];
}

function die(message, detail) {
  console.log(JSON.stringify({
    ok: false,
    error: message,
    detail: detail || null
  }));
  process.exit(1);
}

function openPrivateHandle() {
  try {
    // Anonymous private-bus access pattern from:
    // https://github.com/lennylxx/lg-geolock-bypass
    return new palmbus.Handle('', false);
  } catch (error) {
    throw new Error('anonymous private palmbus handle unavailable: ' + error.message);
  }
}

function callLunaRaw(handle, uri, payload, timeoutMs, callback) {
  var done = false;
  var timer;
  var finish = function (error, response) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    callback(error, response);
  };
  var call;
  try {
    call = handle.call(uri, JSON.stringify(payload || {}));
  } catch (error) {
    finish(error);
    return;
  }
  call.on('response', function (message) {
    var response;
    try {
      response = JSON.parse(message.payload());
    } catch (error) {
      finish(new Error('invalid JSON from ' + uri));
      return;
    }
    finish(null, response);
  });
  call.on('error', function (error) {
    finish(new Error(String(error && error.message || error)));
  });
  timer = setTimeout(function () {
    finish(new Error('timeout calling ' + uri));
  }, timeoutMs);
}

function callLuna(handle, uri, payload, timeoutMs, callback) {
  callLunaRaw(handle, uri, payload, timeoutMs, function (error, response) {
    if (error) {
      callback(error);
      return;
    }
    if (response.returnValue === false) {
      callback(new Error(response.errorText || response.statusCode || 'Luna call failed'));
      return;
    }
    callback(null, response);
  });
}

function requestJson(hostname, requestPath, headers, callback) {
  var request = https.request({
    hostname: hostname,
    port: 443,
    method: 'GET',
    path: requestPath,
    headers: headers
  }, function (response) {
    var chunks = [];
    response.on('data', function (chunk) { chunks.push(chunk); });
    response.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        callback(new Error('SDP HTTP ' + response.statusCode + ' (' + body.length + ' bytes)'));
        return;
      }
      try {
        callback(null, JSON.parse(body));
      } catch (error) {
        callback(new Error('invalid SDP JSON (' + body.length + ' bytes)'));
      }
    });
  });
  request.on('error', callback);
  request.setTimeout(30000, function () {
    request.destroy(new Error('SDP request timeout'));
  });
  request.end();
}

function sdxHeaders(response) {
  var headers = {};
  Object.keys(response).forEach(function (key) {
    if (key !== 'returnValue' && key !== 'header' && key !== 'HOST') {
      headers[key] = String(response[key]);
    }
  });
  return headers;
}

function storeRegion(sdx, country) {
  var headers = sdxHeaders(sdx);
  if (!country) return { hostname: sdx.HOST, headers: headers };
  headers['X-Device-Country'] = country === 'CN' ? 'C01' : country;
  headers['X-Device-Country-Group'] = country;
  if (country === 'CN') {
    headers['X-Device-Language'] = 'zh-CN';
    headers['X-Device-Locale'] = 'zh-CN';
  }
  return { hostname: country + '.nextlgsdp.com', headers: headers };
}

function validateDownloadUrl(value) {
  var parsed = url.parse(value);
  if (parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      (!/\.wiselg\.com$/i.test(parsed.hostname) &&
       parsed.hostname.toLowerCase() !== 'cn-gfts.tv.wiselg.cn')) {
    throw new Error('SDP returned an unexpected download host');
  }
}

function normalizeCatalogName(value) {
  return String(value || '').toLowerCase()
    .replace(/[\s\u2000-\u206f\u3000-\u303f]+/g, '')
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, '');
}

function catalogMatchScore(targetName, candidateName) {
  var target = normalizeCatalogName(targetName);
  var candidate = normalizeCatalogName(candidateName);
  if (!target || !candidate) return 0;
  if (target === candidate) return 100;
  if (candidate.indexOf(target) === 0 || target.indexOf(candidate) === 0) return 90;
  if (candidate.indexOf(target) !== -1 || target.indexOf(candidate) !== -1) return 80;
  return 0;
}

function selectCatalogCandidate(targetName, apps) {
  var byId = {};
  apps.forEach(function (app) {
    if (!app || !app.id || !app.name) return;
    var score = catalogMatchScore(targetName, app.name);
    if (!score) return;
    if (!byId[app.id] || score > byId[app.id].score) {
      byId[app.id] = { id: app.id, name: app.name, score: score };
    }
  });
  var candidates = Object.keys(byId).map(function (id) { return byId[id]; });
  candidates.sort(function (left, right) {
    return right.score - left.score || left.name.localeCompare(right.name);
  });
  if (!candidates.length) return { error: 'no matching TV catalog app' };
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return {
      error: 'ambiguous TV catalog match',
      candidates: candidates.slice(0, 5)
    };
  }
  return { app: candidates[0] };
}

function catalogList(hostname, basePath, headers, categoryId,
    rankType, startIdx, callback) {
  var requestPath = basePath + '/app/list?categoryId=' +
    encodeURIComponent(categoryId) + '&itemCnt=92&startIdx=' +
    encodeURIComponent(String(startIdx)) + '&rankType=' +
    encodeURIComponent(String(rankType)) + '&newCnt=92';
  requestJson(hostname, requestPath, headers, callback);
}

function resolveCatalogApp(hostname, basePath, headers,
    categoryId, targetName, callback) {
  catalogList(hostname, basePath, headers, categoryId, 1, 1,
    function (popularError, popularResponse) {
      if (popularError) {
        callback(popularError);
        return;
      }
      var popularList = (popularResponse.rankTypeList || []).filter(function (list) {
        return Number(list.type) === 1;
      })[0] || {};
      var popular = selectCatalogCandidate(targetName, popularList.appList || []);
      if (popular.app && popular.app.score === 100) {
        callback(null, popular.app);
        return;
      }

      var apps = [];
      var pageSize = 92;
      var fetchPage = function (startIdx) {
        catalogList(hostname, basePath, headers, categoryId, 5, startIdx,
          function (pageError, pageResponse) {
            if (pageError) {
              callback(pageError);
              return;
            }
            var list = (pageResponse.rankTypeList || []).filter(function (item) {
              return Number(item.type) === 5;
            })[0] || {};
            apps = apps.concat(list.appList || []);
            var total = Number(list.totalAppCount || apps.length);
            if ((list.appList || []).length && startIdx + pageSize <= total) {
              fetchPage(startIdx + pageSize);
              return;
            }
            var selected = selectCatalogCandidate(targetName, apps);
            if (!selected.app) {
              var detail = selected.candidates
                ? JSON.stringify(selected.candidates)
                : selected.error;
              callback(new Error(selected.error + (detail ? ': ' + detail : '')));
              return;
            }
            callback(null, selected.app);
          });
      };
      fetchPage(1);
    });
}

function chooseTargetDir() {
  var candidates = [
    '/tmp/lg-ipk-download',
    '/media/developer/temp/lg-ipk-download'
  ];
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = candidates[index];
    try {
      try { fs.mkdirSync(candidate); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      var probe = path.join(candidate, '.write-probe');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return candidate;
    } catch (error) {
      // Try the platform-specific fallback.
    }
  }
  throw new Error('no writable temporary download directory');
}

function downloadFile(target, targetPath, expectedSize, timeoutSeconds,
    redirects, callback) {
  if (redirects > 5) {
    callback(new Error('too many download redirects'));
    return;
  }
  var parsed = url.parse(target);
  if (parsed.protocol !== 'https:') {
    callback(new Error('download redirect changed to a non-HTTPS URL'));
    return;
  }
  var request = https.get(parsed, function (response) {
    if (response.statusCode >= 300 && response.statusCode < 400 &&
        response.headers.location) {
      response.resume();
      downloadFile(
        url.resolve(target, response.headers.location),
        targetPath,
        expectedSize,
        timeoutSeconds,
        redirects + 1,
        callback
      );
      return;
    }
    if (response.statusCode !== 200) {
      response.resume();
      callback(new Error('download HTTP ' + response.statusCode));
      return;
    }
    var output = fs.createWriteStream(targetPath, { flags: 'w', mode: 384 });
    var received = 0;
    var done = false;
    var finish = function (error) {
      if (done) return;
      done = true;
      callback(error);
    };
    output.on('error', finish);
    response.on('error', finish);
    response.on('data', function (chunk) {
      received += chunk.length;
      if (received > expectedSize) {
        request.destroy(new Error('download exceeded expected size'));
      }
    });
    output.on('finish', function () {
      if (received !== expectedSize) {
        finish(new Error('download size mismatch: received ' + received));
        return;
      }
      finish(null);
    });
    response.pipe(output);
  });
  request.on('error', callback);
  request.setTimeout(timeoutSeconds * 1000, function () {
    request.destroy(new Error('download timeout'));
  });
}

var appId = args['--app-id'] || null;
var catalogName = args['--catalog-name'] || null;
var categoryId = args['--category-id'] || null;
var webAppId = args['--web-app-id'] || null;
var apiVersion = args['--api-version'] || '10.0.0';
var timeoutSeconds = Number(args['--timeout'] || 180);
var country = args['--country'];
if (country !== undefined) {
  if (!/^(?:[A-Za-z]{2}|C01)$/i.test(country)) die('invalid country code');
  country = country.toUpperCase();
  if (country === 'C01') country = 'CN';
}
if (appId && !/^[A-Za-z0-9._-]+$/.test(appId)) die('invalid app ID');
if (!appId && (!catalogName || !categoryId)) die('app ID or catalog hints are required');
if (categoryId && !/^[A-Za-z0-9._-]+$/.test(categoryId)) die('invalid category ID');
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(apiVersion)) die('invalid API version');
if (!isFinite(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 3600) {
  die('invalid timeout');
}

var handle;
try { handle = openPrivateHandle(); } catch (error) { die(error.message); }

callLuna(
  handle,
  'luna://com.webos.service.sdx/getHttpHeaderForServiceRequest',
  {},
  10000,
  function (sdxError, sdx) {
    if (sdxError) die('SDX header request failed', sdxError.message);
    if (!sdx.HOST || !/^[A-Za-z0-9.-]+$/.test(sdx.HOST)) {
      die('SDX returned an invalid host');
    }
    var region = storeRegion(sdx, country);
    var hostname = region.hostname;
    var headers = region.headers;
    var basePath = '/apps/' + apiVersion;

    var continueWithAppId = function (resolvedAppId) {
      appId = resolvedAppId;
      var detailPath = basePath + '/app/app?app_id=' + encodeURIComponent(appId);
      requestJson(hostname, detailPath, headers, function (detailError, detail) {
        if (detailError) die('app detail request failed', detailError.message);
        var storeApp = detail.app || detail;
        var storeVersion = storeApp.version || null;

        callLunaRaw(
          handle,
          'luna://com.webos.applicationManager/getAppInfo',
          { id: appId },
          10000,
          function (appInfoError, appResponse) {
            var appInfo = !appInfoError && appResponse.returnValue !== false
              ? appResponse.appInfo || {}
              : {};
            var installedVersion = appInfo.version || null;
            var binId = appInfo.binId;
            var requestBinId = binId === undefined || binId === null ? 0 : binId;
            var requestVersion = installedVersion || '0';
            var installPath = basePath + '/app/install?id=' +
              encodeURIComponent(appId) + '&bin_id=' +
              encodeURIComponent(String(requestBinId)) + '&version=' +
              encodeURIComponent(requestVersion);
            requestJson(hostname, installPath, headers, function (installError, install) {
              if (installError) die('install metadata request failed', installError.message);
              var appFile = install.appFile || {};
              var packageVersion = appFile.appVer || storeVersion;
              var expectedSize = Number(appFile.packFileSize);
              if (appFile.appId && appFile.appId !== appId) {
                die('install metadata app ID mismatch');
              }
              if (!packageVersion || !isFinite(expectedSize) || expectedSize <= 0 ||
                  typeof appFile.fileURL !== 'string') {
                die('install metadata is incomplete');
              }
              try { validateDownloadUrl(appFile.fileURL); } catch (error) {
                die(error.message);
              }
              var safeVersion = String(packageVersion).replace(/[^A-Za-z0-9._-]/g, '_');
              var targetFilename = appId + '_' + safeVersion + '.ipk';
              var targetDir;
              try { targetDir = chooseTargetDir(); } catch (error) {
                die('temporary directory selection failed', error.message);
              }
              var targetPath = path.join(targetDir, targetFilename);
              try { fs.unlinkSync(targetPath); } catch (error) {
                if (error.code !== 'ENOENT') die('old download cleanup failed', error.message);
              }
              downloadFile(
                appFile.fileURL,
                targetPath,
                expectedSize,
                timeoutSeconds,
                0,
                function (downloadError) {
                  if (downloadError) {
                    try { fs.unlinkSync(targetPath); } catch (cleanupError) {}
                    die('download failed', downloadError.message);
                  }
                  console.log(JSON.stringify({
                    ok: true,
                    appId: appId,
                    webAppId: webAppId,
                    installedVersion: installedVersion,
                    storeVersion: storeVersion,
                    packageVersion: packageVersion,
                    expectedSize: expectedSize,
                    remotePath: targetPath
                  }));
                  process.exit(0);
                }
              );
            });
          }
        );
      });
    };

    if (appId) {
      continueWithAppId(appId);
      return;
    }
    resolveCatalogApp(
      hostname,
      basePath,
      headers,
      categoryId,
      catalogName,
      function (resolveError, resolved) {
        if (resolveError) die('catalog app resolution failed', resolveError.message);
        continueWithAppId(resolved.id);
      }
    );
  }
);
