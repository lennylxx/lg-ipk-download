# LG IPK Download

A command-line tool that downloads the latest official IPK for any LG Content
Store app. You don't need to install the app on your TV first.

**More webOS tools:** [IPTV Player](https://github.com/lennylxx/webos-iptv-player) · [DevMode Forever](https://github.com/lennylxx/lg-devmode-forever) · [GeoLock Bypass](https://github.com/lennylxx/lg-geolock-bypass)

> [!NOTE]
> The CLI runs on your computer. It temporarily runs a small helper on the TV,
> because the private palmbus, device-bound SDX authentication, and the
> short-lived signed package URL are only available there. Sensitive headers and
> signed URL parameters never leave the TV.

## Requirements

- An LG webOS TV with Developer Mode and SSH enabled
- Node.js on your computer
- `ares-setup-device` from the webOS CLI
- `expect`, `ssh`, and `scp`

Configure the TV with `ares-setup-device` first, then verify it is listed:

```bash
ares-setup-device --list
```

## Quick start

```bash
cd lg-ipk-download

./bin/lg-ipk-download.js \
  --device tv \
  --output /tmp/com.palmdts.devmode.ipk \
  com.palmdts.devmode
```

The positional argument can be either:

```bash
# Internal Content Store app ID
./bin/lg-ipk-download.js com.palmdts.devmode

# Numeric ID from the US LG Apps website
./bin/lg-ipk-download.js 232503
```

Numeric IDs are resolved through `us.lgappstv.com`.

Example output:

```text
Downloaded com.palmdts.devmode 2.1.4
Output:  /tmp/com.palmdts.devmode.ipk
Size:    6435718 bytes
SHA-256: 610d87c5a3b5a569130dbf7ea515f7395afc4589cd0fb397c3144af93390e5d4
```

If `--output` is omitted, the IPK is saved to the current directory as:

```text
<app-id>_<store-version>.ipk
```

## Options

```text
-o, --output <path>       Local output path
-d, --device <name>       ares-setup-device profile name
    --api-version <ver>   SDP apps API version (default: 10.0.0)
    --timeout <seconds>   Download timeout (default: 180)
    --keep-remote         Keep the downloaded file on the TV
    --force               Replace an existing output file
    --json                Print the final result as JSON
-h, --help                Show this help
```

Machine-readable example:

```bash
./bin/lg-ipk-download.js --json com.palmdts.devmode
```

## How it works

### On the computer

1. If given a numeric store ID, look up the app name and category through
   the LG Apps `retrieveAppInfo.ajax` endpoint.
2. Read the selected TV connection from `ares-setup-device`.
3. Push `tv/download-ipk.js` to a unique path under `/tmp`.
4. Run the helper over SSH.
5. Pull the completed IPK with SCP.
6. Check the file size against the size reported by LG, and compute the
   SHA-256.
7. Remove the temporary helper from the TV. The TV copy of the IPK is also
   removed unless `--keep-remote` is used.

### On the TV

1. Open an anonymous private palmbus handle:

   ```js
   new palmbus.Handle('', false)
   ```

   This anonymous private-bus access pattern comes from
   [lennylxx/lg-geolock-bypass](https://github.com/lennylxx/lg-geolock-bypass).

2. For an LG Apps numeric ID, query the TV's `/app/list` catalog and map the
   website name and category to the TV's internal app ID. Ambiguous matches are
   rejected rather than guessed.

3. Call:

   ```text
   luna://com.webos.service.sdx/getHttpHeaderForServiceRequest
   ```

   This returns the device-bound Content Store request headers and the
   regional SDP host.

4. Query the app detail endpoint:

   ```text
   /apps/<api-version>/app/app?app_id=<internal-app-id>
   ```

5. Optionally call:

   ```text
   luna://com.webos.applicationManager/getAppInfo
   ```

   If the app is installed, this returns its current version and `binId`.
   Otherwise, the helper uses `bin_id=0&version=0`.

6. Request A.001 install metadata without actually installing the app:

   ```text
   /apps/<api-version>/app/install
       ?id=<internal-app-id>
       &bin_id=<installed-bin-id-or-0>
       &version=<installed-version-or-0>
   ```

7. Validate that the returned package URL uses HTTPS, then stream the package
   directly to a temporary file on the TV.

The install metadata response contains the current package version, the
expected packed size, and a short-lived signed GFTS URL. The helper keeps that
URL in memory only.

## Temporary directories

The helper uses the first writable location from this list:

1. `/tmp/lg-ipk-download`
2. `/media/developer/temp/lg-ipk-download`

The second location is for platforms such as webOS 26, where `/tmp` may not
be writable from the Developer Mode environment.

The tool deliberately avoids `/media/internal` and downloadmanager, because
IPKs saved there stay in `/media/internal` and keep taking up storage on your
TV. `/tmp`, on the other hand, is cleared on every reboot. After a successful
SCP, the IPK is removed from the TV unless `--keep-remote` is specified.

## Security

- SDX authentication headers never leave the helper process on the TV.
- Authorization values, device identifiers, cookies, and session tokens are
  never printed.
- Signed URL query parameters are never printed or persisted.
- The computer receives only non-sensitive package metadata and the IPK.
- Downloaded IPKs are excluded from git via `.gitignore`.
- If the download fails on the TV, the partial file is removed.
- If SCP fails after the TV download completes, the file is kept on the TV
  and its path there is printed so you can copy it manually.

## Limitations

- Numeric IDs from the website are not the same as the TV's internal app IDs.
  The tool maps them using the regional website metadata and the TV catalog.
  If more than one app is an equally good match, pass the internal app ID
  instead.
- Which apps are available, and which package is returned, depend on the
  selected TV's model, region, firmware, and Content Store account state.
- The default API version, `10.0.0`, was verified on an OLED77C5PUA running
  webOS 10.3.1 (firmware 33.31.69).
- Use `--api-version` when targeting a different SDP API generation.
- LG may change private services, authentication requirements, or SDP
  response formats in future firmware.

## Development

Run syntax checks:

```bash
npm run check
bash -n lib/tv.sh
```

Repository layout:

```text
bin/lg-ipk-download.js  Host CLI and verification
lib/tv.sh               SSH/SCP transport
tv/download-ipk.js      Temporary TV-side helper
```
