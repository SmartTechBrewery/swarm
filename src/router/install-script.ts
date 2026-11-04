/**
 * `GET /install.sh` — the one command that sets a worker host up with no SWARM
 * clone (issue #1312):
 *
 *   curl -fsSL https://<installation>/install.sh | sh
 *   curl -fsSL https://<installation>/install.sh | sh -s -- [<subcommand>] [flags]
 *
 * Run in the project checkout the worker is to serve, the script checks for Node
 * >= 22 and git, downloads the installation's own launcher package
 * (`./worker-launcher.ts`) and checks its SHA-256 against the manifest, installs it
 * at `~/.swarm/launcher` with `swarm-worker` linked into `~/.swarm/bin` (and
 * `~/.local/bin` when that is on `PATH`), and hands over to `swarm-worker setup
 * --control-plane-url <installation>` — or to the subcommand given after `sh -s --`
 * — with the remaining flags passed through and the terminal as stdin, since under
 * `curl | sh` stdin is the script. Nothing is downloaded from GitHub.
 *
 * **Re-running it upgrades the launcher in place.** The new package is unpacked to
 * `~/.swarm/launcher.new` and swapped in, the previous one kept until the swap has
 * succeeded. A LaunchAgent installed by `swarm-worker setup` names the stable
 * `~/.swarm/launcher/bin/swarm-worker.js`, so it runs the new launcher on its next
 * start.
 *
 * **Trust:** the launcher is not signed. Installing it trusts the installation over
 * TLS, exactly as `curl | sh` always does; the runtimes it then installs stay
 * minisign-verified against the key the package carries (ADR-007).
 *
 * `GET /install.ps1` (issue #1324) is the same installer for Windows, in PowerShell:
 *
 *   irm https://<installation>/install.ps1 | iex
 *   & ([scriptblock]::Create((irm https://<installation>/install.ps1))) [<subcommand>] [flags]
 *
 * It takes the same steps with the same messages, puts a `swarm-worker.cmd` in
 * `~\.swarm\bin` and that directory on the user's `PATH`, and hands over the same
 * way. A Task Scheduler task installed by `swarm-worker setup` names the same stable
 * `~\.swarm\launcher\bin\swarm-worker.js`.
 *
 * The installation's base URL is baked into each script: `WEBHOOK_CALLBACK_BASE_URL`
 * when set (SWARM's public base URL, authoritative), otherwise the request's own
 * `Host` and `X-Forwarded-Proto` — the order `./webhook-callback-url.ts` uses, for
 * the same reason. It is single-quoted, so no value can break out of it.
 */

import type { Hono } from 'hono';

import { resolveWebhookCallbackBaseUrl } from '../lib/env.js';
import {
	WORKER_LAUNCHER_ARTIFACTS_PATH,
	WORKER_LAUNCHER_MANIFEST_PATH,
} from '../transport/runtime-manifest.js';

/** The route the installer is served on. */
export const INSTALL_SCRIPT_PATH = '/install.sh';
/** The route the Windows (PowerShell) installer is served on. */
export const INSTALL_POWERSHELL_PATH = '/install.ps1';

/** `value` as one single-quoted POSIX shell word: nothing in it is expanded. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `value` as one single-quoted PowerShell string: nothing in it is expanded.
 * PowerShell also reads the Unicode single quotes as quotes, so each is doubled too.
 */
export function powershellQuote(value: string): string {
	return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * The installation's base URL as a client reached it: `configured` (the
 * `WEBHOOK_CALLBACK_BASE_URL` value) when set, otherwise the request's `Host` with
 * `X-Forwarded-Proto` (else the scheme the request itself arrived on). `undefined`
 * when there is no usable `Host`.
 */
export function resolveInstallationBaseUrl(
	header: (name: string) => string | undefined,
	requestUrl: string,
	configured: string | undefined = resolveWebhookCallbackBaseUrl(),
): string | undefined {
	if (configured) return configured;
	const host = header('host')?.trim();
	if (!host) return undefined;
	const forwarded = header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
	const scheme =
		forwarded === 'http' || forwarded === 'https'
			? forwarded
			: new URL(requestUrl).protocol.replace(/:$/, '');
	try {
		const url = new URL(`${scheme}://${host}`);
		// A Host that smuggles a path, query or credentials is not a host.
		if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/**
 * The installer for the installation at `baseUrl`. POSIX `sh`, `set -eu`; the whole
 * body is a function called on the last line, so a download cut short runs nothing.
 */
export function renderInstallScript(baseUrl: string): string {
	return String.raw`#!/bin/sh
# Install the SWARM worker launcher from this installation, then run
# swarm-worker setup (issue #1312). Run it in the project checkout the worker is
# to serve:
#
#   curl -fsSL <installation>/install.sh | sh
#   curl -fsSL <installation>/install.sh | sh -s -- [<subcommand>] [flags]
#
# Needs Node.js >= 22, git, curl and tar. Everything is downloaded from the
# installation below and checked against its SHA-256; nothing from GitHub.
set -eu

SWARM_URL=${shellQuote(baseUrl)}

say() {
	printf '%s\n' "swarm install: $*" >&2
}

fail() {
	say "$*"
	exit 1
}

require_prerequisites() {
	command -v node >/dev/null 2>&1 ||
		fail "Node.js >= 22 is required, and node is not on PATH. Install it (https://nodejs.org) and re-run."
	node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
		fail "Node.js >= 22 is required, and node is $(node --version 2>/dev/null || echo 'of an unknown version'). Upgrade it and re-run."
	command -v git >/dev/null 2>&1 ||
		fail "git is required, and git is not on PATH. Install it and re-run."
	command -v curl >/dev/null 2>&1 ||
		fail "curl is required, and curl is not on PATH. Install it and re-run."
	command -v tar >/dev/null 2>&1 ||
		fail "tar is required, and tar is not on PATH. Install it and re-run."
}

# The launcher manifest on stdin, as "<version> <file> <sha256>", or the reason
# the installation serves none (on stderr, exit 1).
read_manifest() {
	node -e '
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
	const refuse = (reason) => { console.error("swarm install: " + reason); process.exit(1); };
	let m;
	try { m = JSON.parse(text); } catch { refuse("the launcher manifest is not JSON"); }
	if (!m || m.available !== true)
		refuse("this installation serves no worker launcher: " + (m && m.reason ? m.reason : "no reason given"));
	if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/.test(String(m.version)) ||
		m.file !== "swarm-worker-launcher-" + m.version + ".tar.gz" ||
		!/^[0-9a-f]{64}$/.test(String(m.sha256)))
		refuse("the launcher manifest is malformed");
	process.stdout.write(m.version + " " + m.file + " " + m.sha256 + "\n");
});'
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		fail "neither sha256sum nor shasum is available to verify the download."
	fi
}

link_command() {
	rm -f "$2"
	ln -s "$1" "$2"
}

main() {
	require_prerequisites

	# A first argument that is not a flag names the subcommand; setup otherwise.
	subcommand=setup
	if [ "$#" -gt 0 ]; then
		case "$1" in
			-*) ;;
			*)
				subcommand=$1
				shift
				;;
		esac
	fi

	swarm_dir="$HOME/.swarm"
	launcher_dir="$swarm_dir/launcher"
	entry="$launcher_dir/bin/swarm-worker.js"
	mkdir -p "$swarm_dir"
	# Beside the destination, so the swap below is a rename.
	work=$(mktemp -d "$swarm_dir/.install.XXXXXX")
	trap 'rm -rf "$work"' EXIT

	say "reading the worker launcher manifest from $SWARM_URL"
	curl -fsSL -o "$work/manifest.json" "$SWARM_URL${WORKER_LAUNCHER_MANIFEST_PATH}" ||
		fail "could not read $SWARM_URL${WORKER_LAUNCHER_MANIFEST_PATH}"
	fields=$(read_manifest <"$work/manifest.json") || exit 1
	read -r version file sha256 <<EOF
$fields
EOF

	say "downloading swarm-worker $version"
	curl -fsSL -o "$work/$file" "$SWARM_URL${WORKER_LAUNCHER_ARTIFACTS_PATH}/$file" ||
		fail "could not download $SWARM_URL${WORKER_LAUNCHER_ARTIFACTS_PATH}/$file"
	actual=$(sha256_of "$work/$file")
	[ "$actual" = "$sha256" ] ||
		fail "$file does not match the installation's SHA-256 (expected $sha256, got $actual). Nothing was installed."

	mkdir "$work/unpack"
	tar -xzf "$work/$file" -C "$work/unpack" || fail "could not unpack $file. Nothing was installed."
	unpacked="$work/unpack/swarm-worker-launcher-$version"
	[ -f "$unpacked/bin/swarm-worker.js" ] ||
		fail "$file holds no swarm-worker-launcher-$version/bin/swarm-worker.js. Nothing was installed."

	# Swap it in, keeping the previous launcher until the new one is in place.
	rm -rf "$launcher_dir.new" "$launcher_dir.old"
	mv "$unpacked" "$launcher_dir.new"
	if [ -e "$launcher_dir" ] || [ -L "$launcher_dir" ]; then
		mv "$launcher_dir" "$launcher_dir.old"
		if ! mv "$launcher_dir.new" "$launcher_dir"; then
			mv "$launcher_dir.old" "$launcher_dir"
			fail "could not move the new launcher into $launcher_dir; the previous one is kept."
		fi
		rm -rf "$launcher_dir.old"
	else
		mv "$launcher_dir.new" "$launcher_dir"
	fi

	mkdir -p "$swarm_dir/bin"
	link_command "$entry" "$swarm_dir/bin/swarm-worker"
	on_path=
	case ":$PATH:" in
		*":$swarm_dir/bin:"*) on_path=yes ;;
	esac
	case ":$PATH:" in
		*":$HOME/.local/bin:"*)
			if [ -L "$HOME/.local/bin/swarm-worker" ] || [ ! -e "$HOME/.local/bin/swarm-worker" ]; then
				mkdir -p "$HOME/.local/bin"
				link_command "$entry" "$HOME/.local/bin/swarm-worker"
				on_path=yes
			else
				say "$HOME/.local/bin/swarm-worker exists and is not a link, so it was left as it is."
			fi
			;;
	esac
	say "installed swarm-worker $version in $launcher_dir"
	[ -n "$on_path" ] ||
		say "to run swarm-worker by name, add it to your PATH: export PATH=\"\$HOME/.swarm/bin:\$PATH\""

	rm -rf "$work"
	trap - EXIT
	# Under curl | sh, stdin is this script: answer setup's questions from the terminal.
	if (: </dev/tty) 2>/dev/null; then
		exec node "$entry" "$subcommand" --control-plane-url "$SWARM_URL" "$@" </dev/tty
	fi
	exec node "$entry" "$subcommand" --control-plane-url "$SWARM_URL" "$@"
}

main "$@"
`;
}

/**
 * The Windows installer for the installation at `baseUrl` (issue #1324): the steps
 * and messages of {@link renderInstallScript}, in PowerShell that Windows
 * PowerShell 5.1 runs as well as pwsh 7. The whole body is a function called on the
 * last line, so a download cut short runs nothing, and nothing in it calls `exit`,
 * which under `irm | iex` would close the window it was pasted into: a refusal is a
 * thrown `swarm install: …` error instead. The arguments are the script's plain
 * `$args`, not a `ValueFromRemainingArguments` parameter, which would make it an
 * advanced script that binds a flag like `-p` or `-ea` to a common parameter
 * rather than passing it through. ASCII only, so no code page can garble it.
 */
export function renderInstallPowerShell(baseUrl: string): string {
	return String.raw`# Install the SWARM worker launcher from this installation, then run
# swarm-worker setup (issue #1324). Run it in PowerShell, in the project checkout
# the worker is to serve:
#
#   irm <installation>/install.ps1 | iex
#   & ([scriptblock]::Create((irm <installation>/install.ps1))) [<subcommand>] [flags]
#
# Needs Node.js >= 22, git and tar (tar.exe ships with Windows 10 1803 and later).
# Everything is downloaded from the installation below and checked against its
# SHA-256; nothing from GitHub.

function Install-SwarmWorker {
	param([string[]]$Arguments)

	Set-StrictMode -Version Latest
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'

	$SwarmUrl = ${powershellQuote(baseUrl)}
	$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

	function Say([string]$Message) {
		[Console]::Error.WriteLine("swarm install: $Message")
	}

	# Never exit: under irm | iex that would close the window.
	function Fail([string]$Message) {
		throw "swarm install: $Message"
	}

	function Find-Command([string]$Name) {
		$found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($found) { return $found.Path }
		return $null
	}

	# A field of the parsed manifest, or $null; strict mode refuses a missing property.
	function Get-Field($Object, [string]$Name) {
		if ($Object -isnot [System.Management.Automation.PSCustomObject]) { return $null }
		$property = $Object.PSObject.Properties[$Name]
		if ($property) { return $property.Value }
		return $null
	}

	function Test-PathEntry([string]$List, [string]$Dir) {
		foreach ($item in ($List -split ';')) {
			if ($item.Trim().TrimEnd('\') -eq $Dir.TrimEnd('\')) { return $true }
		}
		return $false
	}

	# Windows PowerShell 5.1 does not offer TLS 1.2 by default.
	if ($PSVersionTable.PSVersion.Major -lt 6) {
		[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	}

	$node = Find-Command 'node'
	if (-not $node) {
		Fail 'Node.js >= 22 is required, and node is not on PATH. Install it (https://nodejs.org) and re-run.'
	}
	$nodeVersion = ''
	try { $nodeVersion = ([string](& $node --version 2>$null)).Trim() } catch { }
	if (-not ($nodeVersion -match '^v(\d+)\.') -or [int]$Matches[1] -lt 22) {
		if (-not $nodeVersion) { $nodeVersion = 'of an unknown version' }
		Fail "Node.js >= 22 is required, and node is $nodeVersion. Upgrade it and re-run."
	}
	if (-not (Find-Command 'git')) {
		Fail 'git is required, and git is not on PATH. Install it and re-run.'
	}
	# Windows' own bsdtar, rather than a GNU tar that reads C:\... as a remote host.
	$tar = $null
	if ($onWindows -and $env:SystemRoot) {
		$systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
		if (Test-Path -LiteralPath $systemTar) { $tar = $systemTar }
	}
	if (-not $tar) { $tar = Find-Command 'tar' }
	if (-not $tar) {
		Fail 'tar is required, and tar is not on PATH. Install it and re-run.'
	}

	# A first argument that is not a flag names the subcommand; setup otherwise.
	$rest = @()
	if ($null -ne $Arguments) { $rest = @($Arguments) }
	$subcommand = 'setup'
	if ($rest.Count -gt 0 -and -not $rest[0].StartsWith('-')) {
		$subcommand = $rest[0]
		$rest = @($rest | Select-Object -Skip 1)
	}

	# Windows PowerShell 5.1's $HOME is HOMEDRIVE+HOMEPATH, which a redirected home
	# moves off USERPROFILE: the home Node's os.homedir() reads, and the one the .cmd
	# and the PATH entry below name.
	$userHome = if ($onWindows -and $env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
	$swarmDir = Join-Path $userHome '.swarm'
	$launcherDir = Join-Path $swarmDir 'launcher'
	$entry = Join-Path (Join-Path $launcherDir 'bin') 'swarm-worker.js'
	$binDir = Join-Path $swarmDir 'bin'
	New-Item -ItemType Directory -Force -Path $swarmDir | Out-Null
	# Beside the destination, so the swap below is a rename.
	$work = Join-Path $swarmDir ('.install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
	New-Item -ItemType Directory -Path $work | Out-Null
	try {
		$manifestUrl = "$SwarmUrl${WORKER_LAUNCHER_MANIFEST_PATH}"
		$manifestFile = Join-Path $work 'manifest.json'
		Say "reading the worker launcher manifest from $SwarmUrl"
		try {
			Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl -OutFile $manifestFile
		} catch {
			Fail "could not read $manifestUrl ($($_.Exception.Message))"
		}
		$manifest = $null
		try {
			$manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
		} catch {
			Fail 'the launcher manifest is not JSON'
		}
		$available = Get-Field $manifest 'available'
		if (-not ($available -is [bool] -and $available)) {
			$reason = Get-Field $manifest 'reason'
			if (-not $reason) { $reason = 'no reason given' }
			Fail "this installation serves no worker launcher: $reason"
		}
		$version = [string](Get-Field $manifest 'version')
		$file = [string](Get-Field $manifest 'file')
		$sha256 = [string](Get-Field $manifest 'sha256')
		if ($version -cnotmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}\z' -or
			$file -cne "swarm-worker-launcher-$version.tar.gz" -or
			$sha256 -cnotmatch '^[0-9a-f]{64}\z') {
			Fail 'the launcher manifest is malformed'
		}

		$packageUrl = "$SwarmUrl${WORKER_LAUNCHER_ARTIFACTS_PATH}/$file"
		$package = Join-Path $work $file
		Say "downloading swarm-worker $version"
		try {
			Invoke-WebRequest -UseBasicParsing -Uri $packageUrl -OutFile $package
		} catch {
			Fail "could not download $packageUrl ($($_.Exception.Message))"
		}
		$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
		if ($actual -cne $sha256) {
			Fail "$file does not match the installation's SHA-256 (expected $sha256, got $actual). Nothing was installed."
		}

		$unpack = Join-Path $work 'unpack'
		New-Item -ItemType Directory -Path $unpack | Out-Null
		& $tar -xzf $package -C $unpack
		if ($LASTEXITCODE -ne 0) { Fail "could not unpack $file. Nothing was installed." }
		$unpacked = Join-Path $unpack "swarm-worker-launcher-$version"
		if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $unpacked 'bin') 'swarm-worker.js') -PathType Leaf)) {
			Fail "$file holds no swarm-worker-launcher-$version/bin/swarm-worker.js. Nothing was installed."
		}

		# Swap it in, keeping the previous launcher until the new one is in place.
		$newDir = "$launcherDir.new"
		$oldDir = "$launcherDir.old"
		foreach ($stale in @($newDir, $oldDir)) {
			if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force }
		}
		Move-Item -LiteralPath $unpacked -Destination $newDir
		if (Test-Path -LiteralPath $launcherDir) {
			$movedAside = $false
			try {
				Move-Item -LiteralPath $launcherDir -Destination $oldDir
				$movedAside = $true
			} catch { }
			if (-not $movedAside) {
				Remove-Item -LiteralPath $newDir -Recurse -Force -ErrorAction SilentlyContinue
				Fail "could not move the previous launcher out of $launcherDir (is a program using it?). Nothing was installed."
			}
			$swapped = $false
			try {
				Move-Item -LiteralPath $newDir -Destination $launcherDir
				$swapped = $true
			} catch { }
			if (-not $swapped) {
				Move-Item -LiteralPath $oldDir -Destination $launcherDir
				Fail "could not move the new launcher into $launcherDir; the previous one is kept."
			}
			Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
		} else {
			Move-Item -LiteralPath $newDir -Destination $launcherDir
		}
	} finally {
		Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
	}
	Say "installed swarm-worker $version in $launcherDir"

	# swarm-worker by name: a .cmd in ~\.swarm\bin, which goes on the user's PATH.
	New-Item -ItemType Directory -Force -Path $binDir | Out-Null
	Set-Content -LiteralPath (Join-Path $binDir 'swarm-worker.cmd') -Encoding ASCII -Value '@node "%USERPROFILE%\.swarm\launcher\bin\swarm-worker.js" %*'
	if ($onWindows) {
		# Read and written unexpanded, so entries like %USERPROFILE%\... stay as they are.
		$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
		try {
			$userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
			if (-not (Test-PathEntry ([Environment]::ExpandEnvironmentVariables($userPath)) $binDir)) {
				if ($userPath -and -not $userPath.EndsWith(';')) { $userPath += ';' }
				$key.SetValue('Path', $userPath + '%USERPROFILE%\.swarm\bin', [Microsoft.Win32.RegistryValueKind]::ExpandString)
				# Setting any user variable through .NET announces the change to Explorer,
				# so terminals opened from now on see the new PATH.
				[Environment]::SetEnvironmentVariable('SWARM_INSTALL_PATH_CHANGED', '1', 'User')
				[Environment]::SetEnvironmentVariable('SWARM_INSTALL_PATH_CHANGED', '', 'User')
				Say "added $binDir to your user PATH; terminals opened from now on run swarm-worker by name."
			}
		} finally {
			$key.Close()
		}
		if (-not (Test-PathEntry $env:Path $binDir)) { $env:Path = "$binDir;$env:Path" }
	} else {
		Say "swarm-worker.cmd is for Windows; on this system, install with: curl -fsSL $SwarmUrl${INSTALL_SCRIPT_PATH} | sh"
	}

	& $node $entry $subcommand --control-plane-url $SwarmUrl @rest
	if ($LASTEXITCODE -ne 0) { Fail "swarm-worker $subcommand exited with code $LASTEXITCODE." }
}

Install-SwarmWorker -Arguments $args
`;
}

const NO_BASE_URL =
	"Cannot tell this installation's public URL: the request has no usable Host header and WEBHOOK_CALLBACK_BASE_URL is not set.\n";

/**
 * Mount `GET /install.sh` and `GET /install.ps1` on the router's `app`.
 * `configuredBaseUrl` is for tests.
 */
export function registerInstallScript(
	app: Hono,
	options: { configuredBaseUrl?: () => string | undefined } = {},
): void {
	const configured = options.configuredBaseUrl ?? (() => resolveWebhookCallbackBaseUrl());
	const scripts = [
		{ path: INSTALL_SCRIPT_PATH, render: renderInstallScript, type: 'text/x-shellscript' },
		{ path: INSTALL_POWERSHELL_PATH, render: renderInstallPowerShell, type: 'text/plain' },
	];
	for (const { path, render, type } of scripts) {
		app.get(path, (c) => {
			const baseUrl = resolveInstallationBaseUrl(
				(name) => c.req.header(name),
				c.req.url,
				configured(),
			);
			if (!baseUrl) return c.text(NO_BASE_URL, 400, { 'Cache-Control': 'no-store' });
			return c.body(render(baseUrl), 200, {
				'Content-Type': `${type}; charset=utf-8`,
				'Cache-Control': 'no-store',
			});
		});
	}
}
