# LG IPK Download

A host-side CLI that downloads the current official IPK for an LG Content
Store app. The target does not need to be installed on the TV.

The command runs on your computer. It temporarily executes a small helper on
the TV because private palmbus, device-bound SDX authentication, and the
short-lived signed package URL are only available there. Sensitive headers and
signed URL parameters never leave the TV.

## Requirements

- LG webOS TV with Developer Mode and SSH enabled
- Node.js on the computer
- `ares-setup-device` from the webOS CLI
- `expect`, `ssh`, and `scp`

Configure and verify the TV first:

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

The positional argument can be any of:

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

If no output path is supplied, the default is:

```text
<app-id>_<store-version>.ipk
```

## Options

```text
-o, --output <path>       Local output path
-d, --device <name>       ares-setup-device profile name
    --api-version <ver>   SDP apps API version (default: 10.0.0)
    --timeout <seconds>   Download timeout (default: 180)
    --keep-remote         Keep the temporary package on the TV
    --force               Replace an existing output file
    --json                Print machine-readable output
-h, --help                Show help
```

Machine-readable example:

```bash
./bin/lg-ipk-download.js --json com.palmdts.devmode
```

## How it works

### On the computer

1. If given a numeric store ID, query LG Apps' `retrieveAppInfo.ajax`
   endpoint for the app name and category.
2. Read the selected TV connection from `ares-setup-device`.
3. Push `tv/download-ipk.js` to a unique path under `/tmp`.
4. Run the helper over SSH.
5. Pull the completed IPK with SCP.
6. Verify the size reported by LG and calculate SHA-256.
7. Remove the temporary helper and, unless `--keep-remote` is used, the TV
   copy of the IPK.

### On the TV

1. Open an anonymous private palmbus handle:

   ```js
   new palmbus.Handle('', false)
   ```

   Anonymous private-bus access pattern:
   [lennylxx/lg-geolock-bypass](https://github.com/lennylxx/lg-geolock-bypass)

2. For an LG Apps numeric ID, query the TV's `/app/list` catalog and map the
   website name/category to the TV's internal app ID. Ambiguous matches are
   rejected rather than guessed.

3. Call:

   ```text
   luna://com.webos.service.sdx/getHttpHeaderForServiceRequest
   ```

   This provides device-bound Content Store request headers and the regional
   SDP host.

4. Query the app detail endpoint:

   ```text
   /apps/<api-version>/app/app?app_id=<internal-app-id>
   ```

5. Optionally call:

   ```text
   luna://com.webos.applicationManager/getAppInfo
   ```

   If the app is installed, this supplies its current version and `binId`.
   If it is not installed, the helper uses `bin_id=0&version=0`.

6. Request A.001 install metadata without installing:

   ```text
   /apps/<api-version>/app/install
       ?id=<internal-app-id>
       &bin_id=<installed-bin-id-or-0>
       &version=<installed-version-or-0>
   ```

7. Validate the returned HTTPS package URL and stream it directly to a
   temporary file on the TV.

The install metadata response contains the current package version, expected
packed size, and a short-lived signed GFTS URL. The helper uses that URL only
in memory.

## Temporary directories

The helper probes writable locations in this order:

1. `/tmp/lg-ipk-download`
2. `/media/developer/temp/lg-ipk-download`

The second location supports platforms such as webOS 26, where `/tmp` may not
be writable from the Developer Mode environment.

The tool deliberately does not use `/media/internal` or downloadmanager.
Successful downloads are removed from the TV after SCP unless
`--keep-remote` is specified.

## Security

- SDX authentication headers never leave the TV process.
- Authorization values, device identifiers, cookies, and session tokens are
  never printed.
- Signed URL query parameters are never printed or persisted.
- The computer receives only non-sensitive package metadata and the IPK.
- Downloaded IPKs are ignored by this repository.
- A TV-side download error removes its partial file.
- If SCP fails after the TV download completes, the TV file is retained and
  its local path is shown for manual recovery.

## Limitations

- Website numeric IDs are not the same as TV bundle IDs. The tool resolves
  them through the regional website metadata and TV catalog. If multiple apps
  are equally plausible, use the internal app ID explicitly.
- Catalog availability and package compatibility are determined by the
  selected TV, its region, firmware, and Content Store account state.
- The default API version is `10.0.0`, verified on an OLED77C5PUA running
  webOS 10.3.1 / firmware 33.31.69.
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
