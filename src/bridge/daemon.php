<?php
/**
 * Minibee Viewer bridge - shared core (do not run directly).
 * Start: start-minibee.bat  OR  php bridge/poll.php + php bridge/caps.php
 */

declare(strict_types=1);

const HOST = '127.0.0.1';
const PORT = 8794;
const POLL_PORT = 8795;
const POLL_MS = 50;
const CA_BUNDLE_URL = 'https://curl.se/ca/cacert.pem';

if (!defined('MINIBEE_BRIDGE_ROLE')) {
    define('MINIBEE_BRIDGE_ROLE', 'combined');
}

function bridge_entry_script(): string
{
    global $argv;
    return basename((string)($argv[0] ?? 'daemon.php'));
}

function bridge_role(): string
{
    return (string)MINIBEE_BRIDGE_ROLE;
}

function bridge_is_poll_role(): bool
{
    $role = bridge_role();
    return $role === 'poll' || $role === 'combined';
}

function bridge_is_caps_role(): bool
{
    $role = bridge_role();
    return $role === 'caps' || $role === 'combined';
}

function bridge_listen_port(): int
{
    if (defined('MINIBEE_BRIDGE_PORT')) {
        return (int)MINIBEE_BRIDGE_PORT;
    }
    return bridge_role() === 'poll' ? POLL_PORT : PORT;
}

function bridge_poll_base_url(): string
{
    $port = (int)(getenv('FS_BRIDGE_POLL_PORT') ?: POLL_PORT);
    return 'http://' . HOST . ':' . $port;
}

function bridge_is_circuit_path(string $path): bool
{
    return str_starts_with($path, '/circuit/');
}

/** @return array{ok:bool,url:string,sessions?:int,udp?:bool} */
function bridge_poll_health_snapshot(): array
{
    $url = bridge_poll_base_url() . '/health';
    $ctx = stream_context_create(['http' => ['timeout' => 1.5, 'ignore_errors' => true]]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) {
        return ['ok' => false, 'url' => $url];
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || empty($data['ok'])) {
        return ['ok' => false, 'url' => $url];
    }
    return [
        'ok' => true,
        'url' => $url,
        'sessions' => (int)($data['sessions'] ?? 0),
        'udp' => !empty($data['udp']),
    ];
}

function minibee_version_path(): string
{
    return dirname(__DIR__) . '/js/version.json';
}

/** @return array{channel:string,major:int,minor:int,patch:int,build:int} */
function minibee_version_data(): array
{
    static $data = null;
    if (is_array($data)) {
        return $data;
    }
    $path = minibee_version_path();
    $raw = @file_get_contents($path);
    if ($raw === false) {
        throw new RuntimeException('version.json not found at ' . $path);
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('invalid version.json');
    }
    $data = [
        'channel' => (string)($decoded['channel'] ?? 'Minibee-Viewer'),
        'major' => (int)($decoded['major'] ?? 0),
        'minor' => (int)($decoded['minor'] ?? 0),
        'patch' => (int)($decoded['patch'] ?? 0),
        'build' => (int)($decoded['build'] ?? 0),
    ];
    return $data;
}

function minibee_version_string(?array $data = null): string
{
    $v = $data ?? minibee_version_data();
    $base = $v['major'] . '.' . $v['minor'] . '.' . $v['patch'];
    if ($v['build'] > 0) {
        $base .= '.' . $v['build'];
    }
    return $base;
}

/** @return array{channel:string,version:string,major:int,minor:int,patch:int,build:int} */
function minibee_version_payload(): array
{
    $v = minibee_version_data();
    return [
        'channel' => $v['channel'],
        'version' => minibee_version_string($v),
        'major' => $v['major'],
        'minor' => $v['minor'],
        'patch' => $v['patch'],
        'build' => $v['build'],
    ];
}

function minibee_print_bridge_banner(): void
{
    try {
        fwrite(STDOUT, 'Minibee Viewer bridge ' . minibee_version_string() . ' [' . bridge_role() . "]\n");
    } catch (Throwable $e) {
        fwrite(STDOUT, 'Minibee Viewer bridge [' . bridge_role() . "]\n");
        fwrite(STDERR, 'Warning: ' . $e->getMessage() . "\n");
    }
    $port = bridge_listen_port();
    fwrite(STDOUT, 'Listening on http://' . HOST . ':' . $port . "/\n");
    if (bridge_role() === 'caps') {
        fwrite(STDOUT, 'UDP poll bridge: ' . bridge_poll_base_url() . "\n");
        fwrite(STDOUT, 'Open viewer: http://' . HOST . ':' . $port . "/\n");
    } elseif (bridge_role() === 'poll') {
        fwrite(STDOUT, "Caps / UI bridge: http://" . HOST . ':' . PORT . "\n");
    } else {
        fwrite(STDOUT, 'Open viewer: http://' . HOST . ':' . PORT . "/\n");
    }
}

function minibee_print_stop_notice(): void
{
    $line = str_repeat('-', 72);
    fwrite(STDOUT, "\n" . $line . "\n");
    fwrite(STDOUT, " Stop Minibee bridge: Ctrl+C or close this terminal window.\n");
    fwrite(STDOUT, "\n");
    fwrite(STDOUT, " Closing the bridge ends all communication between the viewer in your\n");
    fwrite(STDOUT, " web browser and Second Life's servers.\n");
    fwrite(STDOUT, $line . "\n\n");
}

function minibee_user_agent(): string
{
    $v = minibee_version_data();
    return 'SecondLife/' . minibee_version_string($v) . ' (' . $v['channel'] . '; Minibee Viewer)';
}

function resolve_ca_bundle(bool $forceRefresh = false): ?string
{
    static $resolved = null;
    static $checked = false;
    if ($forceRefresh) {
        $checked = false;
        $resolved = null;
    }
    if ($checked) {
        return $resolved;
    }
    $checked = true;

    foreach (ca_bundle_candidate_paths(true) as $path) {
        if (is_file($path) && is_readable($path)) {
            $resolved = $path;
            return $resolved;
        }
    }

    return null;
}

/** @return list<string> */
function ca_bundle_candidate_paths(bool $includeDownloaded = true): array
{
    $candidates = [];
    foreach (['FS_BRIDGE_CACERT', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE'] as $envVar) {
        $env = getenv($envVar);
        if (is_string($env) && $env !== '') {
            $candidates[] = $env;
        }
    }
    if ($includeDownloaded) {
        $candidates[] = __DIR__ . DIRECTORY_SEPARATOR . 'cacert.pem';
    }

    foreach (['curl.cainfo', 'openssl.cafile'] as $iniKey) {
        $iniCa = ini_get($iniKey);
        if (is_string($iniCa) && $iniCa !== '') {
            $candidates[] = $iniCa;
        }
    }

    if (defined('PHP_BINARY')) {
        $phpDir = dirname(PHP_BINARY);
        $candidates[] = $phpDir . DIRECTORY_SEPARATOR . 'extras' . DIRECTORY_SEPARATOR . 'ssl' . DIRECTORY_SEPARATOR . 'cacert.pem';
        $candidates[] = dirname($phpDir) . DIRECTORY_SEPARATOR . 'extras' . DIRECTORY_SEPARATOR . 'ssl' . DIRECTORY_SEPARATOR . 'cacert.pem';
    }

    if (PHP_OS_FAMILY === 'Linux' || PHP_OS_FAMILY === 'Darwin') {
        $candidates[] = '/etc/ssl/certs/ca-certificates.crt';
        $candidates[] = '/etc/pki/tls/certs/ca-bundle.crt';
        $candidates[] = '/etc/ssl/ca-bundle.pem';
        $candidates[] = '/etc/ssl/cert.pem';
    }

    return $candidates;
}

function resolve_bootstrap_ca_bundle(): ?string
{
    foreach (ca_bundle_candidate_paths(false) as $path) {
        if (is_file($path) && is_readable($path)) {
            return $path;
        }
    }
    return null;
}

function ca_bundle_local_path(): string
{
    return __DIR__ . DIRECTORY_SEPARATOR . 'cacert.pem';
}

function ca_bundle_etag_path(): string
{
    return __DIR__ . DIRECTORY_SEPARATOR . 'cacert.etag';
}

/** @return array{ok:bool,path?:string,updated?:bool,unchanged?:bool,error?:string} */
function download_ca_bundle(): array
{
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'PHP curl extension required to download CA bundle'];
    }

    $dest = ca_bundle_local_path();
    $etagPath = ca_bundle_etag_path();
    $knownEtag = is_file($etagPath) ? trim((string)@file_get_contents($etagPath)) : '';
    $hadLocal = is_file($dest);

    $headers = [];
    if ($knownEtag !== '' && $hadLocal) {
        $headers[] = 'If-None-Match: ' . $knownEtag;
    }

    $ch = curl_init(CA_BUNDLE_URL);
    if ($ch === false) {
        return ['ok' => false, 'error' => 'Failed to initialise curl'];
    }

    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_HEADER => true,
    ];

    $bootstrapCa = resolve_bootstrap_ca_bundle();
    if ($bootstrapCa !== null) {
        $opts[CURLOPT_SSL_VERIFYPEER] = true;
        $opts[CURLOPT_SSL_VERIFYHOST] = 2;
        $opts[CURLOPT_CAINFO] = $bootstrapCa;
    } else {
        // First-time bootstrap from the canonical curl.se CA extract (Mozilla NSS -> PEM).
        $opts[CURLOPT_SSL_VERIFYPEER] = false;
        $opts[CURLOPT_SSL_VERIFYHOST] = 0;
    }

    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        return ['ok' => false, 'error' => 'Download failed: ' . $err];
    }

    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    $rawHeaders = substr($raw, 0, $headerSize);
    $body = substr($raw, $headerSize);

    if ($status === 304 && $hadLocal) {
        resolve_ca_bundle(true);
        return ['ok' => true, 'path' => $dest, 'updated' => false, 'unchanged' => true];
    }

    if ($status !== 200) {
        return ['ok' => false, 'error' => 'curl.se returned HTTP ' . $status];
    }

    if (strpos($body, '-----BEGIN CERTIFICATE-----') === false) {
        return ['ok' => false, 'error' => 'Downloaded file does not look like a PEM CA bundle'];
    }

    if (@file_put_contents($dest, $body) === false) {
        return ['ok' => false, 'error' => 'Could not write ' . $dest];
    }

    $newEtag = '';
    if (preg_match('/^etag:\s*(\S+)/im', $rawHeaders, $m)) {
        $newEtag = trim($m[1], '"');
    }
    if ($newEtag !== '') {
        @file_put_contents($etagPath, $newEtag . "\n");
    }

    resolve_ca_bundle(true);
    return ['ok' => true, 'path' => $dest, 'updated' => true, 'unchanged' => false];
}

/** @return array{ok:bool,path?:string,source?:string,updated?:bool,unchanged?:bool,error?:string} */
function ensure_ca_bundle(): array
{
    $existing = resolve_ca_bundle();
    if ($existing !== null) {
        $local = realpath(ca_bundle_local_path());
        $resolved = realpath($existing);
        return [
            'ok' => true,
            'path' => $existing,
            'source' => ($local !== false && $resolved !== false && $local === $resolved) ? 'downloaded' : 'system',
        ];
    }

    $downloaded = download_ca_bundle();
    if ($downloaded['ok']) {
        $downloaded['source'] = 'downloaded';
        return $downloaded;
    }

    return $downloaded;
}

/** @return array{ok:bool,path?:string,downloaded?:bool,source?:string} */
function ca_bundle_status(): array
{
    $path = resolve_ca_bundle();
    if ($path === null) {
        return ['ok' => false];
    }
    $local = realpath(ca_bundle_local_path());
    $resolved = realpath($path);
    $isDownloaded = $local !== false && $resolved !== false && $local === $resolved;
    return [
        'ok' => true,
        'path' => $path,
        'downloaded' => $isDownloaded,
        'source' => $isDownloaded ? 'downloaded' : 'system',
    ];
}

/** @return array<int, mixed> */
function curl_cookie_options(): array
{
    static $jar = null;
    if ($jar === null) {
        $jar = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR .
            'fs_bridge_cookies_' . getmypid() . '.txt';
    }
    return [
        CURLOPT_COOKIEFILE => $jar,
        CURLOPT_COOKIEJAR => $jar,
    ];
}

/** @return array<int, mixed> */
function curl_common_options(): array
{
    return curl_ssl_options() + curl_cookie_options();
}

/** @return array<int, mixed> */
function curl_ssl_options(): array
{
    $opts = [
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ];
    $ca = resolve_ca_bundle();
    if ($ca !== null) {
        $opts[CURLOPT_CAINFO] = $ca;
    }
    return $opts;
}

/** @param resource|\CurlHandle $ch */
function apply_curl_ssl($ch): void
{
    curl_setopt_array($ch, curl_common_options());
}

function curl_ssl_hint(): string
{
    $ca = resolve_ca_bundle();
    if ($ca !== null) {
        return '';
    }
    return ' Set FS_BRIDGE_CACERT, or let the viewer download bridge/cacert.pem from curl.se.';
}

/** @var array<string, array{sock: resource, ip: string, port: int, inbox: string[]}> */
$sessions = [];

class HttpResponse extends Exception
{
    /** @param array<string, string> $headers */
    public function __construct(
        public int $status,
        public array $headers,
        public string $body
    ) {
        parent::__construct('HTTP response');
    }
}

/** @return array<string, string> */
function cors_header_array(): array
{
    return [
        'Access-Control-Allow-Origin' => '*',
        'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers' => 'Content-Type',
        'Access-Control-Max-Age' => '86400',
    ];
}

function minibee_root_path(): string
{
    return dirname(__DIR__);
}

function static_mime_type(string $ext): string
{
    return match (strtolower($ext)) {
        'html' => 'text/html; charset=utf-8',
        'js' => 'application/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'png' => 'image/png',
        'jpg', 'jpeg' => 'image/jpeg',
        'svg' => 'image/svg+xml',
        'ico' => 'image/x-icon',
        'webp' => 'image/webp',
        default => 'application/octet-stream',
    };
}

function serve_static_file(string $relativePath): ?HttpResponse
{
    $root = realpath(minibee_root_path());
    if ($root === false) {
        return null;
    }
    $relativePath = '/' . ltrim(str_replace('\\', '/', $relativePath), '/');
    $candidate = realpath($root . $relativePath);
    if ($candidate === false || !str_starts_with($candidate, $root) || !is_file($candidate)) {
        return null;
    }
    $body = @file_get_contents($candidate);
    if ($body === false) {
        return null;
    }
    $headers = cors_header_array();
    $headers['Content-Type'] = static_mime_type(pathinfo($candidate, PATHINFO_EXTENSION));
    if (str_ends_with(strtolower($relativePath), '.html')) {
        $headers['Cache-Control'] = 'no-cache';
    }
    return new HttpResponse(200, $headers, $body);
}

function json_response_data(int $code, array $data): HttpResponse
{
    $headers = cors_header_array();
    $headers['Content-Type'] = 'application/json; charset=utf-8';
    return new HttpResponse($code, $headers, json_encode($data, JSON_UNESCAPED_SLASHES));
}

function fetch_map_tile(int $level, int $gridX, int $gridY, string $mapServer): HttpResponse
{
    if (!function_exists('curl_init')) {
        return json_response_data(500, ['error' => 'curl required']);
    }
    $server = trim($mapServer);
    if ($server === '' || !preg_match('#^https?://#i', $server)) {
        $server = 'https://map.secondlife.com/';
    }
    $url = rtrim($server, '/') . '/map-' . $level . '-' . $gridX . '-' . $gridY . '-objects.jpg';
    $ch = curl_init($url);
    if ($ch === false) {
        return json_response_data(500, ['error' => 'curl_init failed']);
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'User-Agent: ' . minibee_user_agent(),
            'Referer: https://secondlife.com/',
            'Accept: image/jpeg,image/*,*/*',
        ],
    ] + curl_common_options());
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false || $code < 200 || $code >= 300) {
        return json_response_data(502, [
            'error' => 'map tile fetch failed',
            'code' => $code,
            'detail' => $err !== '' ? $err : $url,
        ]);
    }
    $headers = cors_header_array();
    $headers['Content-Type'] = (strpos($ctype, 'image/') === 0) ? $ctype : 'image/jpeg';
    $headers['Cache-Control'] = 'public, max-age=300';
    return new HttpResponse(200, $headers, $body);
}

function destinations_api_base(): string
{
    return 'https://worldaping.agni.lindenlab.com/v2/destinations/';
}

function fetch_destinations_feed(string $feed): HttpResponse
{
    $allowed = ['mobile', 'popular', 'new', 'editor', 'events'];
    if (!in_array($feed, $allowed, true)) {
        return json_response_data(400, ['error' => 'invalid feed']);
    }
    if (!function_exists('curl_init')) {
        return json_response_data(500, ['error' => 'curl required']);
    }
    $url = destinations_api_base() . $feed . '/';
    $ch = curl_init($url);
    if ($ch === false) {
        return json_response_data(500, ['error' => 'curl_init failed']);
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_HTTPHEADER => [
            'User-Agent: ' . minibee_user_agent(),
            'Accept: application/json',
        ],
    ] + curl_common_options());
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false || $code < 200 || $code >= 300) {
        return json_response_data(502, [
            'error' => 'destinations fetch failed',
            'code' => $code,
            'detail' => $err !== '' ? $err : $url,
        ]);
    }
    $items = json_decode($body, true);
    if (!is_array($items)) {
        return json_response_data(502, ['error' => 'invalid destinations response']);
    }
    $headers = cors_header_array();
    $headers['Content-Type'] = 'application/json; charset=utf-8';
    $headers['Cache-Control'] = 'public, max-age=300';
    return new HttpResponse(200, $headers, json_encode([
        'ok' => true,
        'feed' => $feed,
        'items' => $items,
    ], JSON_UNESCAPED_SLASHES));
}

function parse_region_cap_js(string $body): ?string
{
    if (preg_match("/var\\s+region\\s*=\\s*['\"]([^'\"]*)['\"]/", $body, $m)) {
        return $m[1];
    }
    return null;
}

function parse_region_coords_cap_js(string $body): ?array
{
    if (preg_match("/['\"]error['\"]\s*:\s*true/", $body)) {
        return null;
    }
    if (!preg_match("/['\"]x['\"]\s*:\s*(-?\d+)/", $body, $mx)) {
        return null;
    }
    if (!preg_match("/['\"]y['\"]\s*:\s*(-?\d+)/", $body, $my)) {
        return null;
    }
    return [
        'x' => (int)$mx[1],
        'y' => (int)$my[1],
    ];
}

function cap_coords_to_grid(int $x, int $y): array
{
    if ($x < 4096 && $y < 4096) {
        return [
            'gridX' => $x,
            'gridY' => $y,
            'globalX' => $x * 256,
            'globalY' => $y * 256,
        ];
    }
    $gridX = intdiv($x, 256);
    $gridY = intdiv($y, 256);
    return [
        'gridX' => $gridX,
        'gridY' => $gridY,
        'globalX' => $gridX * 256,
        'globalY' => $gridY * 256,
    ];
}

function fetch_region_by_name(string $regionName): HttpResponse
{
    if (!function_exists('curl_init')) {
        return json_response_data(500, ['error' => 'curl required']);
    }
    $name = trim($regionName);
    if ($name === '') {
        return json_response_data(400, ['error' => 'region name required']);
    }
    $urls = [
        'https://cap.secondlife.com/cap/0/d661249b-2b5a-4436-966a-3d3b8d7a574f?var=coords&sim_name=' . rawurlencode($name),
        'http://slurl.com/get-region-coords-by-name?var=coords&sim_name=' . rawurlencode($name),
    ];
    foreach ($urls as $url) {
        $ch = curl_init($url);
        if ($ch === false) {
            continue;
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 25,
            CURLOPT_HTTPHEADER => [
                'User-Agent: ' . minibee_user_agent(),
                'Accept: text/plain,*/*',
            ],
        ] + curl_common_options());
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || $code < 200 || $code >= 300) {
            continue;
        }
        $coords = parse_region_coords_cap_js((string)$body);
        if ($coords === null) {
            continue;
        }
        $grid = cap_coords_to_grid($coords['x'], $coords['y']);
        $verified = fetch_region_cap_body($grid['gridX'], $grid['gridY']);
        if ($verified === null || strcasecmp($verified, $name) !== 0) {
            continue;
        }
        return json_response_data(200, [
            'name' => $verified,
            'globalX' => $grid['globalX'],
            'globalY' => $grid['globalY'],
            'gridX' => $grid['gridX'],
            'gridY' => $grid['gridY'],
        ]);
    }
    return json_response_data(404, [
        'error' => 'region not found',
        'name' => $name,
    ]);
}

function fetch_region_cap_body(int $gridX, int $gridY): ?string
{
    if (!function_exists('curl_init')) {
        return null;
    }
    $urls = [
        'https://cap.secondlife.com/cap/0/b713fe80-283b-4585-af4d-a3b7d9a32492?var=region&grid_x=' . $gridX . '&grid_y=' . $gridY,
        'http://slurl.com/get-region-name-by-coords?var=region&grid_x=' . $gridX . '&grid_y=' . $gridY,
    ];
    foreach ($urls as $url) {
        $ch = curl_init($url);
        if ($ch === false) {
            continue;
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_HTTPHEADER => [
                'User-Agent: ' . minibee_user_agent(),
                'Accept: text/plain,*/*',
            ],
        ] + curl_common_options());
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || $code < 200 || $code >= 300) {
            continue;
        }
        $name = parse_region_cap_js((string)$body);
        if ($name !== null && $name !== '') {
            return $name;
        }
    }
    return null;
}

function fetch_regions_by_grid_batch(string $tilesParam): HttpResponse
{
    $tiles = [];
    foreach (explode(';', $tilesParam) as $part) {
        $part = trim($part);
        if ($part === '') {
            continue;
        }
        $xy = array_map('intval', explode(',', $part, 2));
        if (count($xy) < 2 || $xy[0] < 0 || $xy[1] < 0 || $xy[0] > 65535 || $xy[1] > 65535) {
            continue;
        }
        $tiles[] = ['x' => $xy[0], 'y' => $xy[1]];
    }
    if ($tiles === []) {
        return json_response_data(400, ['error' => 'no valid tiles']);
    }
    $tiles = array_slice($tiles, 0, 25);
    $results = [];

    if (function_exists('curl_multi_init')) {
        $mh = curl_multi_init();
        if ($mh !== false) {
            $handles = [];
            foreach ($tiles as $tile) {
                $gx = $tile['x'];
                $gy = $tile['y'];
                $url = 'https://cap.secondlife.com/cap/0/b713fe80-283b-4585-af4d-a3b7d9a32492?var=region&grid_x=' . $gx . '&grid_y=' . $gy;
                $ch = curl_init($url);
                if ($ch === false) {
                    continue;
                }
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_TIMEOUT => 12,
                    CURLOPT_HTTPHEADER => [
                        'User-Agent: ' . minibee_user_agent(),
                        'Accept: text/plain,*/*',
                    ],
                ] + curl_common_options());
                curl_multi_add_handle($mh, $ch);
                $handles[(int)$ch] = ['ch' => $ch, 'x' => $gx, 'y' => $gy];
            }
            if ($handles !== []) {
                $running = null;
                do {
                    $status = curl_multi_exec($mh, $running);
                    if ($running > 0) {
                        curl_multi_select($mh, 0.4);
                    }
                } while ($running > 0 && $status === CURLM_OK);

                foreach ($handles as $meta) {
                    $ch = $meta['ch'];
                    $body = curl_multi_getcontent($ch);
                    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_multi_remove_handle($mh, $ch);
                    curl_close($ch);
                    $name = null;
                    if ($body !== false && $code >= 200 && $code < 300) {
                        $name = parse_region_cap_js((string)$body);
                    }
                    $results[] = [
                        'gridX' => $meta['x'],
                        'gridY' => $meta['y'],
                        'name' => $name ?? '',
                        'empty' => $name === null || $name === '',
                    ];
                }
            }
            curl_multi_close($mh);
        }
    }

    if ($results === []) {
        foreach ($tiles as $tile) {
            $name = fetch_region_cap_body($tile['x'], $tile['y']);
            $results[] = [
                'gridX' => $tile['x'],
                'gridY' => $tile['y'],
                'name' => $name ?? '',
                'empty' => $name === null || $name === '',
            ];
        }
    }

    return json_response_data(200, ['regions' => $results]);
}

function fetch_region_by_grid(int $gridX, int $gridY): HttpResponse
{
    if (!function_exists('curl_init')) {
        return json_response_data(500, ['error' => 'curl required']);
    }
    $name = fetch_region_cap_body($gridX, $gridY);
    if ($name !== null && $name !== '') {
        return json_response_data(200, [
            'name' => $name,
            'gridX' => $gridX,
            'gridY' => $gridY,
        ]);
    }
    return json_response_data(404, [
        'error' => 'region not found',
        'gridX' => $gridX,
        'gridY' => $gridY,
    ]);
}

function read_body(): ?array
{
    $raw = $GLOBALS['BRIDGE_RAW_BODY'] ?? '';
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function xml_value_to_php(SimpleXMLElement $value): mixed
{
    if (isset($value->string)) {
        return (string)$value->string;
    }
    if (isset($value->URI)) {
        return (string)$value->URI;
    }
    if (isset($value->uri)) {
        return (string)$value->uri;
    }
    if (isset($value->int) || isset($value->i4)) {
        return (int)($value->int ?? $value->i4);
    }
    if (isset($value->boolean)) {
        $b = strtolower((string)$value->boolean);
        return $b === '1' || $b === 'true';
    }
    if (isset($value->double)) {
        return (float)$value->double;
    }
    if (isset($value->array)) {
        $out = [];
        foreach ($value->array->data->value ?? [] as $item) {
            $out[] = xml_value_to_php($item);
        }
        return $out;
    }
    if (isset($value->struct)) {
        $out = [];
        foreach ($value->struct->member as $member) {
            $name = (string)$member->name;
            $out[$name] = xml_value_to_php($member->value);
        }
        return $out;
    }
    return (string)$value;
}

function parse_login_response(string $xml): array
{
    $sx = @simplexml_load_string($xml);
    if ($sx === false) {
        throw new RuntimeException('Invalid XML-RPC response');
    }
    $params = $sx->params->param->value->struct->member ?? [];
    $result = [];
    foreach ($params as $member) {
        $name = (string)$member->name;
        $result[$name] = xml_value_to_php($member->value);
    }
    return $result;
}

function sl_login_passwd(array $p): string
{
    $plain = substr(trim((string)($p['passwd'] ?? '')), 0, 16);
    $authType = (string)($p['auth_type'] ?? 'agent');
    if ($authType === 'account') {
        return $plain;
    }
    return '$1$' . md5($plain);
}

function build_login_xml(array $p): string
{
    $esc = static fn(string $s): string => htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    $memberString = static function (string $name, string $value) use ($esc): string {
        return '<member><name>' . $esc($name) . '</name><value><string>' . $esc($value) . '</string></value></member>';
    };
    $memberBool = static function (string $name, bool $value): string {
        return '<member><name>' . $name . '</name><value><boolean>' . ($value ? '1' : '0') . '</boolean></value></member>';
    };
    $memberInt = static function (string $name, int $value) use ($esc): string {
        return '<member><name>' . $esc($name) . '</name><value><int>' . $value . '</int></value></member>';
    };

    $options = '';
    foreach ($p['options'] as $opt) {
        $options .= '<value><string>' . $esc($opt) . '</string></value>';
    }

    $members = [];
    if (!empty($p['username'])) {
        $members[] = $memberString('username', (string)$p['username']);
    }
    if (!empty($p['first']) || empty($p['username'])) {
        $members[] = $memberString('first', (string)($p['first'] ?? ''));
    }
    if (!empty($p['last']) || empty($p['username'])) {
        $members[] = $memberString('last', (string)($p['last'] ?? ''));
    }
    $members[] = $memberString('passwd', sl_login_passwd($p));
    $members[] = $memberString('start', (string)($p['start'] ?? 'last'));
    $members[] = $memberString('channel', (string)($p['channel'] ?? ''));
    $members[] = $memberString('version', (string)($p['version'] ?? ''));
    $members[] = $memberString('platform', (string)($p['platform'] ?? 'Win'));
    $members[] = $memberString('mac', (string)($p['mac'] ?? ''));
    $members[] = $memberString('id0', (string)($p['id0'] ?? ''));
    if (!empty($p['host_id'])) {
        $members[] = $memberString('host_id', (string)$p['host_id']);
    }
    if (!empty($p['platform_version'])) {
        $members[] = $memberString('platform_version', (string)$p['platform_version']);
    }
    if (!empty($p['platform_string'])) {
        $members[] = $memberString('platform_string', (string)$p['platform_string']);
    }
    if (isset($p['address_size'])) {
        $members[] = $memberInt('address_size', (int)$p['address_size']);
    }
    if (!empty($p['extended_errors'])) {
        $members[] = $memberBool('extended_errors', true);
    }
    if (isset($p['last_exec_event'])) {
        $members[] = $memberInt('last_exec_event', (int)$p['last_exec_event']);
    }
    if (isset($p['last_exec_duration'])) {
        $members[] = $memberInt('last_exec_duration', (int)$p['last_exec_duration']);
    }
    $members[] = $memberBool('agree_to_tos', !empty($p['agree_to_tos']));
    $members[] = $memberBool('read_critical', !empty($p['read_critical']));
    $members[] = $memberString('token', (string)($p['token'] ?? ''));
    $members[] = $memberString('mfa_hash', (string)($p['mfa_hash'] ?? ''));
    $members[] = '<member><name>options</name><value><array><data>' . $options . '</data></array></value></member>';

    return '<?xml version="1.0"?>' .
        '<methodCall><methodName>login_to_simulator</methodName><params><param><value><struct>' .
        implode('', $members) .
        '</struct></value></param></params></methodCall>';
}

function http_login(string $url, string $xml): string
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP curl extension required');
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $xml,
        CURLOPT_HTTPHEADER => ['Content-Type: text/xml'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 90,
    ] + curl_common_options());
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        throw new RuntimeException('Login HTTP error: ' . $err . curl_ssl_hint());
    }
    if ($code < 200 || $code >= 300) {
        throw new RuntimeException('Login HTTP status ' . $code);
    }
    return $body;
}

function normalize_sim_ip(mixed $ip): string
{
    if (is_int($ip) || is_float($ip)) {
        return long2ip((int)$ip & 0xFFFFFFFF);
    }
    $s = trim((string)$ip, " \t\"'");
    if ($s === '') {
        return '';
    }
    if (filter_var($s, FILTER_VALIDATE_IP)) {
        return $s;
    }
    if (ctype_digit($s)) {
        return long2ip((int)$s & 0xFFFFFFFF);
    }
    $resolved = gethostbyname($s);
    return $resolved !== $s ? $resolved : $s;
}

function trim_login_for_client(array $login): array
{
    $keys = [
        'login', 'reason', 'status', 'message', 'message_id', 'agent_id', 'first_name', 'last_name',
        'session_id', 'secure_session_id', 'circuit_code', 'sim_ip', 'sim_port', 'seed_capability',
        'buddy-list', 'region_x', 'region_y', 'sim_name', 'look_at', 'home_info', 'home',
        'start_location', 'mfa_hash', 'agent_access',
    ];
    $out = [];
    foreach ($keys as $key) {
        if (array_key_exists($key, $login)) {
            $out[$key] = $login[$key];
        }
    }
    if (!empty($out['seed_capability'])) {
        $raw = trim((string)$out['seed_capability'], " \t\"'");
        $normalized = normalize_seed_url($raw);
        if ($normalized !== '' && $normalized !== $raw) {
            $out['seed_capability_raw'] = $raw;
        }
        $out['seed_capability'] = $normalized !== '' ? $normalized : $raw;
    }
    return $out;
}

function parse_uuid_bytes(string $uuid): string
{
    $hex = preg_replace('/[^a-fA-F0-9]/', '', $uuid);
    if ($hex === null || strlen($hex) !== 32) {
        return str_repeat("\0", 16);
    }
    $bin = hex2bin($hex);
    return ($bin === false) ? str_repeat("\0", 16) : $bin;
}

function encode_use_circuit_code(int $circuitCode, string $sessionId, string $agentId, int $seq = 1, bool $resent = false): string
{
    $flags = 0x40 | ($resent ? 0x20 : 0);
    $header = chr($flags) . pack('N', $seq) . "\x00";
    $msgId = "\xFF\xFF\x00\x03";
    $body = pack('V', $circuitCode & 0xFFFFFFFF)
        . parse_uuid_bytes($sessionId)
        . parse_uuid_bytes($agentId);
    return $header . $msgId . $body;
}

/** @return array<string, mixed>|null */
function bootstrap_circuit_from_login(array $login): ?array
{
    // UDP circuit opens when the browser calls /circuit/open (not during login).
    return null;
}

/** @return array<string, mixed> */
function begin_circuit_handshake(string $id, int $circuitCode, string $sessionId, string $agentId): array
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return ['packets' => [], 'sent' => 0, 'recv' => 0, 'bytesSent' => 0, 'useCircuitSeq' => 1];
    }
    $bytesSent = 0;
    $sent = 0;
    for ($try = 0; $try < 4; $try++) {
        $bin = encode_use_circuit_code($circuitCode, $sessionId, $agentId, 1, $try > 0);
        $n = udp_send($sessions[$id], $bin);
        if ($n > 0) {
            $sent++;
            $bytesSent += $n;
        }
        drain_udp($id);
        if (count($sessions[$id]['inbox']) > 0) {
            break;
        }
        wait_for_udp($id, 1.5);
        if (count($sessions[$id]['inbox']) > 0) {
            break;
        }
    }
    $packets = $sessions[$id]['inbox'];
    $sessions[$id]['inbox'] = [];
    return [
        'packets' => $packets,
        'sent' => $sent,
        'recv' => count($packets),
        'bytesSent' => $bytesSent,
        'useCircuitSeq' => 1,
    ];
}

function udp_selftest_ok(): bool
{
    if (!function_exists('socket_create')) {
        return false;
    }
    $recv = @socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
    if ($recv === false) {
        return false;
    }
    if (!@socket_bind($recv, '127.0.0.1', 0)) {
        @socket_close($recv);
        return false;
    }
    $port = 0;
    @socket_getsockname($recv, $addr, $port);
    $send = @socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
    if ($send === false) {
        @socket_close($recv);
        return false;
    }
    @socket_sendto($send, 'ping', 4, 0, '127.0.0.1', $port);
    @socket_set_option($recv, SOL_SOCKET, SO_RCVTIMEO, ['sec' => 1, 'usec' => 0]);
    $buf = str_repeat("\0", 64);
    $from = '';
    $remotePort = 0;
    $n = @socket_recvfrom($recv, $buf, 64, 0, $from, $remotePort);
    @socket_close($recv);
    @socket_close($send);
    return $n !== false && $n > 0;
}

function udp_send(array &$session, string $bin, ?string $targetIp = null, ?int $targetPort = null): int
{
    $len = strlen($bin);
    if ($len === 0) {
        return 0;
    }
    $ip = ($targetIp !== null && $targetIp !== '') ? $targetIp : $session['ip'];
    $port = ($targetPort !== null && $targetPort > 0) ? $targetPort : (int)$session['port'];
    // sendto allows recvfrom any sim on the same local port during teleports.
    $n = @socket_sendto($session['sock'], $bin, $len, 0, $ip, $port);
    if ($n === false) {
        $session['last_send_error'] = socket_last_error($session['sock']);
        @socket_clear_error($session['sock']);
        return 0;
    }
    $session['last_send_error'] = 0;
    return (int)$n;
}

function wait_for_udp(string $id, float $timeoutSec): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    $sock = $sessions[$id]['sock'];
    $deadline = microtime(true) + $timeoutSec;
    while (microtime(true) < $deadline) {
        if (count($sessions[$id]['inbox']) > 0) {
            return;
        }
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) {
            break;
        }
        $sec = (int)$remaining;
        $usec = (int)(($remaining - $sec) * 1000000);
        if ($sec === 0 && $usec < 50000) {
            $usec = 50000;
        }
        @socket_set_block($sock);
        @socket_set_option($sock, SOL_SOCKET, SO_RCVTIMEO, ['sec' => $sec, 'usec' => $usec]);
        $buf = str_repeat("\0", 65535);
        $from = '';
        $port = 0;
        $n = @socket_recvfrom($sock, $buf, 65535, 0, $from, $port);
        @socket_set_nonblock($sock);
        if ($n !== false && $n > 0) {
            $sessions[$id]['inbox'][] = base64_encode(substr($buf, 0, $n));
            return;
        }
        $err = socket_last_error($sock);
        @socket_clear_error($sock);
        if ($err !== 0 && $err !== 11 && $err !== 10035 && $err !== 10060) {
            $sessions[$id]['last_recv_error'] = $err;
        }
    }
    @socket_set_nonblock($sock);
    drain_udp($id);
}

function sim_packet_matches(array $session, string $from, int $port): bool
{
    $fromIp = normalize_sim_ip($from);
    $expectedIp = normalize_sim_ip($session['ip']);
    if ($fromIp !== '' && $expectedIp !== '' && $fromIp === $expectedIp) {
        return true;
    }
    return $port === (int)$session['port'];
}

function open_circuit(array $body): string
{
    global $sessions;
    $id = bin2hex(random_bytes(16));
    $sock = socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
    if ($sock === false) {
        throw new RuntimeException('socket_create failed');
    }
    socket_set_nonblock($sock);
    socket_set_option($sock, SOL_SOCKET, SO_REUSEADDR, 1);
    socket_set_option($sock, SOL_SOCKET, SO_RCVBUF, 262144);
    @socket_bind($sock, '0.0.0.0', 0);
    $ip = normalize_sim_ip($body['sim_ip']);
    $port = (int)$body['sim_port'];
    if ($ip === '' || $port <= 0) {
        throw new RuntimeException('Invalid sim_ip or sim_port');
    }
    $localPort = 0;
    $localAddr = '';
    @socket_getsockname($sock, $localAddr, $localPort);
    $sessions[$id] = [
        'sock' => $sock,
        'ip' => $ip,
        'port' => $port,
        'local_port' => (int)$localPort,
        'connected' => false,
        'last_send_error' => 0,
        'last_recv_error' => 0,
        'inbox' => [],
        'http_inbox' => [],
        'http_clients' => [],
    ];
    ensure_circuit_http_server($id);
    return $id;
}

function retarget_circuit(string $id, string $simIp, int $simPort): array
{
    global $sessions;
    if (!isset($sessions[$id])) {
        throw new RuntimeException('Unknown circuit session');
    }
    $ip = normalize_sim_ip($simIp);
    $port = (int)$simPort;
    if ($ip === '' || $port <= 0) {
        throw new RuntimeException('Invalid sim_ip or sim_port');
    }
    $s = &$sessions[$id];
    $s['ip'] = $ip;
    $s['port'] = $port;
    $s['connected'] = false;
    $s['last_send_error'] = 0;
    $s['last_recv_error'] = 0;
    return circuit_exchange_meta($s);
}

function close_circuit(string $id): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    close_circuit_http($id);
    @socket_close($sessions[$id]['sock']);
    unset($sessions[$id]);
}

/** @param array<string, mixed> $session */
function circuit_pending_recv_count(array $session): int
{
    return count($session['inbox'] ?? []) + count($session['http_inbox'] ?? []);
}

/**
 * @param array<string, mixed> $session
 * @return array{packets:list<string>, httpMessages?:list<array<string, string>>}
 */
function circuit_take_recv_payload(array &$session): array
{
    $payload = ['packets' => $session['inbox'] ?? []];
    $session['inbox'] = [];
    $http = $session['http_inbox'] ?? [];
    if ($http) {
        $payload['httpMessages'] = $http;
        $session['http_inbox'] = [];
    }
    return $payload;
}

function close_circuit_http(string $id): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    $s = &$sessions[$id];
    foreach ($s['http_clients'] ?? [] as $client) {
        if (!empty($client['stream'])) {
            @fclose($client['stream']);
        }
    }
    if (!empty($s['http_server'])) {
        @fclose($s['http_server']);
    }
    unset($s['http_server'], $s['http_clients'], $s['http_listen_failed']);
}

function ensure_circuit_http_server(string $id): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    $s = &$sessions[$id];
    if (!empty($s['http_server']) || !empty($s['http_listen_failed'])) {
        return;
    }
    $port = (int)($s['local_port'] ?? 0);
    if ($port <= 0) {
        return;
    }
    $errno = 0;
    $errstr = '';
    $server = @stream_socket_server(
        'tcp://0.0.0.0:' . $port,
        $errno,
        $errstr,
        STREAM_SERVER_BIND | STREAM_SERVER_LISTEN
    );
    if ($server === false) {
        $s['http_listen_failed'] = true;
        return;
    }
    stream_set_blocking($server, false);
    $s['http_server'] = $server;
    if (!isset($s['http_clients']) || !is_array($s['http_clients'])) {
        $s['http_clients'] = [];
    }
    if (!isset($s['http_inbox']) || !is_array($s['http_inbox'])) {
        $s['http_inbox'] = [];
    }
}

function circuit_http_respond($stream): void
{
    $body = "<llsd><map></map></llsd>\n";
    $response = "HTTP/1.1 200 OK\r\n"
        . "Content-Type: application/llsd+xml\r\n"
        . "Content-Length: " . strlen($body) . "\r\n"
        . "Connection: close\r\n\r\n"
        . $body;
    @fwrite($stream, $response);
    @fclose($stream);
}

function circuit_http_message_name(string $path): string
{
    $path = trim($path);
    if (preg_match('#/(?:trusted-message|message)/([^/?]+)#i', $path, $matches)) {
        return (string)$matches[1];
    }
    return '';
}

function circuit_http_handle_request(string $sessionId, string $raw): void
{
    global $sessions;
    if (!isset($sessions[$sessionId])) {
        return;
    }
    $parts = explode("\r\n\r\n", $raw, 2);
    $headerBlock = $parts[0] ?? '';
    $body = $parts[1] ?? '';
    $lines = preg_split("/\r\n/", $headerBlock) ?: [];
    if (!$lines) {
        return;
    }
    $requestLine = array_shift($lines);
    if (!is_string($requestLine) || stripos($requestLine, 'POST ') !== 0) {
        return;
    }
    $bits = preg_split('/\s+/', trim($requestLine)) ?: [];
    $path = (string)($bits[1] ?? '');
    $name = circuit_http_message_name($path);
    if ($name === '' || $body === '') {
        return;
    }
    $contentType = 'application/llsd+xml';
    foreach ($lines as $line) {
        if (stripos($line, 'Content-Type:') === 0) {
            $contentType = trim(substr($line, strlen('Content-Type:')));
            break;
        }
    }
    $sessions[$sessionId]['http_inbox'][] = [
        'name' => $name,
        'body' => $body,
        'contentType' => $contentType,
    ];
}

function drain_circuit_http(string $id): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    ensure_circuit_http_server($id);
    $s = &$sessions[$id];
    if (empty($s['http_server'])) {
        return;
    }
    while (true) {
        $client = @stream_socket_accept($s['http_server'], 0);
        if ($client === false) {
            break;
        }
        stream_set_blocking($client, false);
        $s['http_clients'][] = ['stream' => $client, 'buffer' => ''];
    }
    $keep = [];
    foreach ($s['http_clients'] as $client) {
        $stream = $client['stream'] ?? null;
        if (!$stream) {
            continue;
        }
        $chunk = @fread($stream, 65536);
        if ($chunk === false) {
            @fclose($stream);
            continue;
        }
        if ($chunk !== '') {
            $client['buffer'] .= $chunk;
        }
        if ($chunk === '' && feof($stream)) {
            if ($client['buffer'] !== '') {
                circuit_http_handle_request($id, $client['buffer']);
            }
            circuit_http_respond($stream);
            continue;
        }
        if (strpos($client['buffer'], "\r\n\r\n") !== false) {
            circuit_http_handle_request($id, $client['buffer']);
            circuit_http_respond($stream);
            continue;
        }
        if (strlen($client['buffer']) > 1048576) {
            @fclose($stream);
            continue;
        }
        $keep[] = $client;
    }
    $s['http_clients'] = $keep;
}

function drain_all_circuit_http(): void
{
    global $sessions;
    foreach (array_keys($sessions) as $sid) {
        drain_circuit_http($sid);
    }
}

/** @return list<resource> */
function circuit_http_servers(): array
{
    global $sessions;
    $servers = [];
    foreach ($sessions as $s) {
        if (!empty($s['http_server'])) {
            $servers[] = $s['http_server'];
        }
    }
    return $servers;
}

function drain_udp(string $id): void
{
    global $sessions;
    if (!isset($sessions[$id])) {
        return;
    }
    $s = &$sessions[$id];
    while (true) {
        $buf = str_repeat("\0", 65535);
        $from = '';
        $port = 0;
        $n = @socket_recvfrom($s['sock'], $buf, 65535, 0, $from, $port);
        if ($n === false || $n <= 0) {
            break;
        }
        $s['inbox'][] = base64_encode(substr($buf, 0, $n));
    }
}

function drain_all_udp_sessions(): void
{
    global $sessions;
    foreach (array_keys($sessions) as $sid) {
        drain_udp($sid);
    }
}

/** @return array<string, mixed> */
function circuit_exchange_meta(array $session): array
{
    return [
        'target' => $session['ip'] . ':' . $session['port'],
        'localPort' => $session['local_port'] ?? 0,
        'connected' => !empty($session['connected']),
        'sendError' => $session['last_send_error'] ?? 0,
        'recvError' => $session['last_recv_error'] ?? 0,
    ];
}

function normalize_seed_url(string $url): string
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }
    if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $url)) {
        $url = 'https://' . ltrim($url, '/');
    }

    $parts = parse_url($url);
    if (is_array($parts) && !empty($parts['host'])) {
        $host = (string)$parts['host'];
        $port = isset($parts['port']) ? (':' . $parts['port']) : '';
        $path = (string)($parts['path'] ?? '');
        $query = isset($parts['query']) ? ('?' . $parts['query']) : '';
        $fragment = isset($parts['fragment']) ? ('#' . $parts['fragment']) : '';
        $fullPath = $path . $query . $fragment;

        if (preg_match('#^/([0-9a-f]+)\\.agni\\.secondlife\\.io(:\\d+)?(/cap/.*)$#i', $fullPath, $slash) &&
            preg_match('#^simhost-\\d+$#i', $host)) {
            return 'https://' . $host . $slash[1] . '.agni.secondlife.io' . ($slash[2] ?: $port) . $slash[3];
        }
    }

    $fixed = preg_replace(
        '#^https?://simhost-(\\d+)/([0-9a-f]+)\\.agni\\.secondlife\\.io(:\\d+)?(/.*)?$#i',
        'https://simhost-$1$2.agni.secondlife.io$3$4',
        $url
    );
    return is_string($fixed) ? $fixed : $url;
}

function proxy_sim_ip_for_session(?string $sessionId, string $explicitIp = ''): string
{
    if ($explicitIp !== '') {
        return normalize_sim_ip($explicitIp);
    }
    global $sessions;
    if ($sessionId !== '' && isset($sessions[$sessionId])) {
        return normalize_sim_ip($sessions[$sessionId]['ip'] ?? '');
    }
    return '';
}

/** @return array{opts: array<int, mixed>, pinnedIp: string} */
function proxy_simhost_curl_opts(string $url, string $simIp): array
{
    $simIp = normalize_sim_ip($simIp);
    $parts = parse_url($url);
    if (!is_array($parts) || empty($parts['host'])) {
        return ['opts' => [], 'pinnedIp' => ''];
    }
    $host = (string)$parts['host'];
    if (!preg_match('/^simhost-/i', $host)) {
        return ['opts' => [], 'pinnedIp' => ''];
    }
    $port = (int)($parts['port'] ?? 443);
    $opts = [CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4];
    if ($simIp !== '') {
        $opts[CURLOPT_RESOLVE] = [$host . ':' . $port . ':' . $simIp];
        return ['opts' => $opts, 'pinnedIp' => $simIp];
    }
    $resolved = @gethostbyname($host);
    if ($resolved !== $host && filter_var($resolved, FILTER_VALIDATE_IP)) {
        return ['opts' => $opts, 'pinnedIp' => $resolved];
    }
    return ['opts' => $opts, 'pinnedIp' => ''];
}

function refresh_session_local_port(string $sessionId): void
{
    global $sessions;
    if ($sessionId === '' || !isset($sessions[$sessionId])) {
        return;
    }
    $addr = '';
    $port = 0;
    if (@socket_getsockname($sessions[$sessionId]['sock'], $addr, $port) && $port > 0) {
        $sessions[$sessionId]['local_port'] = (int)$port;
    }
}

/** @param list<string> $names */
function llsd_array_xml(array $names): string
{
    $inner = '';
    foreach ($names as $name) {
        $inner .= '<string>' . htmlspecialchars((string)$name, ENT_XML1 | ENT_QUOTES, 'UTF-8') . '</string>';
    }
    return "<llsd><array>{$inner}</array></llsd>\n";
}

/** @return list<string> */
function llsd_cap_keys(string $body): array
{
    $keys = [];
    if (preg_match_all('/<key>([^<]+)<\/key>\s*<(?:uri|string)>/i', $body, $matches)) {
        foreach ($matches[1] as $key) {
            $keys[] = (string)$key;
        }
    }
    return $keys;
}

/** @return array<string, string> */
function llsd_cap_map(string $body): array
{
    $map = [];
    if (preg_match_all(
        '/<key>([^<]+)<\/key>\s*<(?:uri|string)>([^<]+)<\/(?:uri|string)>/i',
        $body,
        $matches,
        PREG_SET_ORDER
    )) {
        foreach ($matches as $row) {
            $map[(string)$row[1]] = (string)$row[2];
        }
    }
    return $map;
}

/** @param list<string> $keys */
function seed_has_region_caps(array $keys): bool
{
    $lower = array_map('strtolower', $keys);
    foreach (['eventqueueget', 'getdisplaynames', 'remoteparcelrequest'] as $need) {
        if (in_array($need, $lower, true)) {
            return true;
        }
    }
    return false;
}

/** @return list<string> */
function seed_bootstrap_cap_names(): array
{
    return [
        'EventQueueGet',
        'GetDisplayNames',
        'AgentPreferences',
        'ChatSessionRequest',
        'RemoteParcelRequest',
        'LandResources',
        'ParcelPropertiesUpdate',
        'ViewerBenefits',
        'AgentProfile',
    ];
}

/** @return array<string, mixed> */
function fetch_login_seed_caps(string $seedUrl, string $simIp, string $sessionId = ''): array
{
    $seedUrl = normalize_seed_url($seedUrl);
    if ($seedUrl === '') {
        return ['ok' => false, 'error' => 'No seed capability URL'];
    }

    $simIp = normalize_sim_ip($simIp);
    $lists = [
        seed_bootstrap_cap_names(),
        array_merge(seed_bootstrap_cap_names(), [
            'AgentState', 'AvatarPickerSearch', 'HomeLocation', 'ReadOfflineMsgs',
            'UserInfo', 'GetMetadata',
            'GetMesh', 'GetMesh2', 'GetTexture', 'FetchInventory2', 'FetchInventoryDescendents2',
            'InventoryAPIv3', 'LibraryAPIv3', 'ViewerAsset', 'SimulatorFeatures',
        ]),
    ];

    $lastKeys = [];
    $lastStatus = 0;
    $lastBytes = 0;
    $lastBody = '';

    foreach ($lists as $names) {
        $payload = llsd_array_xml($names);
        $headers = [
            'Accept: application/llsd+xml',
            'Content-Type: application/llsd+xml',
            'User-Agent: ' . minibee_user_agent(),
        ];
        $sessionId = trim($sessionId, " \t\"'");
        if ($sessionId !== '') {
            $headers[] = 'X-SecondLife-Session-ID: ' . $sessionId;
        }

        $resolve = proxy_simhost_curl_opts($seedUrl, $simIp);
        try {
            $exchange = curl_proxy_exchange(
                'POST',
                $seedUrl,
                $payload,
                'application/llsd+xml',
                $headers,
                $resolve['opts']
            );
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }

        $lastStatus = $exchange['status'];
        $lastBody = $exchange['body'];
        $lastBytes = strlen($lastBody);
        $lastKeys = llsd_cap_keys($lastBody);
        if (seed_has_region_caps($lastKeys)) {
            return [
                'ok' => true,
                'body' => $lastBody,
                'caps' => llsd_cap_map($lastBody),
                'contentType' => $exchange['contentType'] !== '' ? $exchange['contentType'] : 'application/llsd+xml',
                'capKeys' => $lastKeys,
                'status' => $lastStatus,
                'responseBytes' => $lastBytes,
                'requestBytes' => strlen($payload),
                'simPinnedIp' => $resolve['pinnedIp'],
            ];
        }
    }

    return [
        'ok' => false,
        'error' => 'Seed grant missing region caps (got: ' . implode(', ', array_slice($lastKeys, 0, 12)) .
            ($lastKeys ? ('; total=' . count($lastKeys)) : '') . ')',
        'body' => $lastBody,
        'caps' => llsd_cap_map($lastBody),
        'contentType' => 'application/llsd+xml',
        'capKeys' => $lastKeys,
        'status' => $lastStatus,
        'responseBytes' => $lastBytes,
        'simPinnedIp' => $simIp,
    ];
}

function circuit_udp_listen_port(?string $sessionId, int $explicitPort = 0): int
{
    if ($explicitPort > 0) {
        return $explicitPort;
    }
    global $sessions;
    if ($sessionId !== '' && isset($sessions[$sessionId])) {
        return (int)($sessions[$sessionId]['local_port'] ?? 0);
    }
    return 0;
}

/** @param array<string, string> $headers */
function proxy_sl_headers(array &$headers, ?string $sessionId, int $udpListenPort = 0): void
{
    $port = circuit_udp_listen_port($sessionId ?? '', $udpListenPort);
    if ($port > 0) {
        $headers[] = 'X-SecondLife-UDP-Listen-Port: ' . $port;
    }
}

/**
 * @param array<string, string> $headers
 * @return array{status:int, body:string, contentType:string, effectiveUrl:string, redirectCount:int}
 */
function curl_proxy_exchange(string $method, string $url, string $payload, string $contentType, array $headers, array $extraCurlOpts = []): array
{
    $redirectCount = 0;
    $maxRedirects = 6;
    $currentMethod = strtoupper($method);
    $currentPayload = $payload;
    $currentContentType = $contentType;

    while (true) {
        $ch = curl_init($url);
        $reqHeaders = $headers;
        if ($currentMethod === 'POST' && $currentContentType !== '') {
            $hasContentType = false;
            foreach ($reqHeaders as $hdr) {
                if (stripos($hdr, 'Content-Type:') === 0) {
                    $hasContentType = true;
                    break;
                }
            }
            if (!$hasContentType) {
                $reqHeaders[] = 'Content-Type: ' . $currentContentType;
            }
        }

        $opts = array_replace([
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 45,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADER => true,
            CURLOPT_HTTPHEADER => $reqHeaders,
        ], curl_common_options(), $extraCurlOpts);

        if ($currentMethod === 'GET') {
            $opts[CURLOPT_HTTPGET] = true;
        } else {
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = $currentPayload;
        }

        $lastUdpDrain = 0.0;
        $opts[CURLOPT_NOPROGRESS] = false;
        $opts[CURLOPT_XFERINFOFUNCTION] = static function (
            $resource,
            float $dlTotal,
            float $dlNow,
            float $ulTotal,
            float $ulNow
        ) use (&$lastUdpDrain) {
            $now = microtime(true);
            if ($now - $lastUdpDrain >= 0.05) {
                $lastUdpDrain = $now;
                drain_all_udp_sessions();
            }
            return 0;
        };

        curl_setopt_array($ch, $opts);
        drain_all_udp_sessions();
        $raw = curl_exec($ch);
        drain_all_udp_sessions();
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $effectiveUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $err = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new RuntimeException('Proxy HTTP error: ' . $err . curl_ssl_hint());
        }

        $rawHeaders = substr($raw, 0, $headerSize);
        $body = substr($raw, $headerSize);

        if ($code >= 300 && $code < 400 && $redirectCount < $maxRedirects) {
            $location = '';
            foreach (preg_split("/\r\n|\n|\r/", $rawHeaders) as $line) {
                if (stripos($line, 'Location:') === 0) {
                    $location = trim(substr($line, 9));
                    break;
                }
            }
            if ($location === '') {
                return [
                    'status' => $code,
                    'body' => $body,
                    'contentType' => $ctype,
                    'effectiveUrl' => $effectiveUrl !== '' ? $effectiveUrl : $url,
                    'redirectCount' => $redirectCount,
                ];
            }
            $origHost = parse_url($url, PHP_URL_HOST) ?: '';
            $nextHost = parse_url($location, PHP_URL_HOST) ?: '';
            if ($origHost !== '' && $nextHost !== '' &&
                strcasecmp($origHost, $nextHost) !== 0 &&
                !preg_match('/^simhost-/i', $nextHost)) {
                throw new RuntimeException(
                    'Seed cap redirect left simhost (' . $origHost . ' -> ' . $nextHost . ')'
                );
            }
            if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $location)) {
                $parts = parse_url($url);
                $scheme = $parts['scheme'] ?? 'http';
                $host = $parts['host'] ?? '';
                $port = isset($parts['port']) ? (':' . $parts['port']) : '';
                $prefix = $scheme . '://' . $host . $port;
                if (str_starts_with($location, '/')) {
                    $location = $prefix . $location;
                } else {
                    $dir = $parts['path'] ?? '/';
                    $dir = preg_replace('#/[^/]*$#', '/', $dir) ?? '/';
                    $location = $prefix . $dir . $location;
                }
            }
            $url = $location;
            $redirectCount++;
            // Keep POST body for SL seed capability grants (303 must not downgrade to GET).
            continue;
        }

        return [
            'status' => $code,
            'body' => $body,
            'contentType' => $ctype,
            'effectiveUrl' => $effectiveUrl !== '' ? $effectiveUrl : $url,
            'redirectCount' => $redirectCount,
        ];
    }
}

function handle_request(string $method, string $path): HttpResponse
{
    global $sessions;

    if ($method === 'OPTIONS') {
        return new HttpResponse(204, cors_header_array(), '');
    }
    if ($path === '/health' && $method === 'GET') {
        if (bridge_role() === 'poll') {
            return json_response_data(200, [
                'ok' => true,
                'role' => 'poll',
                'sessions' => count($sessions),
                'udp' => udp_selftest_ok(),
                'viewer' => minibee_version_payload(),
            ]);
        }
        $payload = [
            'ok' => true,
            'role' => bridge_role(),
            'sessions' => count($sessions),
            'udp' => udp_selftest_ok(),
            'caBundle' => ca_bundle_status(),
            'viewer' => minibee_version_payload(),
        ];
        if (bridge_role() === 'caps') {
            $payload['poll'] = bridge_poll_health_snapshot();
            $payload['pollUrl'] = bridge_poll_base_url();
            if (empty($payload['poll']['ok'])) {
                $payload['ok'] = false;
            }
        }
        return json_response_data(200, $payload);
    }
    if ($path === '/ca-bundle/fetch' && $method === 'POST') {
        $result = download_ca_bundle();
        if (!$result['ok']) {
            $existing = resolve_ca_bundle();
            if ($existing !== null) {
                return json_response_data(200, [
                    'ok' => true,
                    'path' => $existing,
                    'source' => 'system',
                    'unchanged' => true,
                ]);
            }
            return json_response_data(502, $result);
        }
        return json_response_data(200, $result);
    }
    if ($path === '/version' && $method === 'GET') {
        return json_response_data(200, minibee_version_payload());
    }
    if ($path === '/destinations' && $method === 'GET') {
        $feed = strtolower(trim((string)($_GET['feed'] ?? 'mobile')));
        return fetch_destinations_feed($feed);
    }
    if ($path === '/map/tile' && $method === 'GET') {
        $level = max(1, min(8, (int)($_GET['level'] ?? 1)));
        $gridX = (int)($_GET['x'] ?? -1);
        $gridY = (int)($_GET['y'] ?? -1);
        if ($gridX < 0 || $gridY < 0 || $gridX > 65535 || $gridY > 65535) {
            return json_response_data(400, ['error' => 'invalid tile coordinates']);
        }
        $server = (string)($_GET['server'] ?? 'https://map.secondlife.com/');
        return fetch_map_tile($level, $gridX, $gridY, $server);
    }
    if ($path === '/map/region' && $method === 'GET') {
        $gridX = (int)($_GET['x'] ?? -1);
        $gridY = (int)($_GET['y'] ?? -1);
        if ($gridX < 0 || $gridY < 0 || $gridX > 65535 || $gridY > 65535) {
            return json_response_data(400, ['error' => 'invalid grid coordinates']);
        }
        return fetch_region_by_grid($gridX, $gridY);
    }
    if ($path === '/map/regions' && $method === 'GET') {
        $tiles = (string)($_GET['tiles'] ?? '');
        if ($tiles === '') {
            return json_response_data(400, ['error' => 'tiles required']);
        }
        return fetch_regions_by_grid_batch($tiles);
    }
    if ($path === '/map/region-by-name' && $method === 'GET') {
        $name = trim((string)($_GET['name'] ?? ''));
        if ($name === '') {
            return json_response_data(400, ['error' => 'region name required']);
        }
        return fetch_region_by_name($name);
    }
    if ($path === '/login' && $method === 'POST') {
        $body = read_body();
        if ($body === null) {
            return json_response_data(400, ['error' => 'Invalid JSON']);
        }
        try {
            $parsed = parse_login_response(http_login($body['url'], build_login_xml($body)));
            $circuit = bootstrap_circuit_from_login($parsed);
            $seedCaps = ['ok' => false];
            $loginOk = ($parsed['login'] ?? false) === true || ($parsed['login'] ?? '') === 'true';
            if ($loginOk && !empty($parsed['seed_capability'])) {
                $sessionId = trim((string)($parsed['session_id'] ?? ''), " \t\"'");
                $seedCaps = fetch_login_seed_caps(
                    (string)$parsed['seed_capability'],
                    (string)($parsed['sim_ip'] ?? ''),
                    $sessionId
                );
            }
            return json_response_data(200, [
                'login' => trim_login_for_client($parsed),
                'circuit' => $circuit,
                'seedCaps' => $seedCaps,
            ]);
        } catch (Throwable $e) {
            return json_response_data(502, ['error' => $e->getMessage()]);
        }
    }
    if ($path === '/proxy' && ($method === 'POST' || $method === 'GET')) {
        $body = read_body();
        if ($method === 'GET') {
            $url = $_GET['url'] ?? '';
            $contentType = 'application/llsd+xml';
            $payload = '';
            $sessionId = (string)($_GET['sessionId'] ?? '');
            $udpListenPort = empty($_GET['preCircuit']) ? (int)($_GET['udpListenPort'] ?? 0) : 0;
            $simIp = (string)($_GET['simIp'] ?? '');
            $pinSimIp = ($_GET['pinSimIp'] ?? '1') !== '0';
        } else {
            if ($body === null || empty($body['url'])) {
                return json_response_data(400, ['error' => 'url required']);
            }
            $url = $body['url'];
            $payload = $body['body'] ?? '';
            $contentType = $body['contentType'] ?? 'application/llsd+xml';
            $sessionId = (string)($body['sessionId'] ?? '');
            $udpListenPort = empty($body['preCircuit']) ? (int)($body['udpListenPort'] ?? 0) : 0;
            $simIp = (string)($body['simIp'] ?? '');
            $pinSimIp = !isset($body['pinSimIp']) || $body['pinSimIp'] !== false;
        }
        if ($url === '') {
            return json_response_data(400, ['error' => 'url required']);
        }
        $url = normalize_seed_url($url);
        try {
            if (!function_exists('curl_init')) {
                throw new RuntimeException('curl required');
            }
            $headers = [
                'Accept: application/llsd+xml',
                'User-Agent: ' . minibee_user_agent(),
            ];
            $agentSessionId = '';
            if ($method === 'GET') {
                $agentSessionId = trim((string)($_GET['agentSessionId'] ?? ''), " \t\"'");
            } elseif (is_array($body)) {
                $agentSessionId = trim((string)($body['agentSessionId'] ?? ''), " \t\"'");
            }
            if ($agentSessionId !== '') {
                $headers[] = 'X-SecondLife-Session-ID: ' . $agentSessionId;
            }
            if ($sessionId !== '') {
                refresh_session_local_port($sessionId);
            }
            proxy_sl_headers($headers, $sessionId, $udpListenPort);
            $postBody = is_string($payload) ? $payload : json_encode($payload);
            $simIp = proxy_sim_ip_for_session($sessionId, $simIp);
            $resolve = proxy_simhost_curl_opts($url, $pinSimIp ? $simIp : '');
            $proxyTimeout = 45;
            if ($method === 'POST' && is_array($body) && isset($body['timeoutSec'])) {
                $proxyTimeout = min(95, max(10, (int)$body['timeoutSec']));
            }
            drain_all_udp_sessions();
            $exchange = curl_proxy_exchange(
                $method,
                $url,
                $method === 'POST' ? $postBody : '',
                $method === 'POST' ? $contentType : '',
                $headers,
                array_replace($resolve['opts'], [CURLOPT_TIMEOUT => $proxyTimeout])
            );
            drain_all_udp_sessions();
            return json_response_data(200, [
                'status' => $exchange['status'],
                'contentType' => $exchange['contentType'],
                'body' => $exchange['body'],
                'effectiveUrl' => $exchange['effectiveUrl'],
                'redirectCount' => $exchange['redirectCount'],
                'requestBytes' => $method === 'POST' ? strlen($postBody) : 0,
                'responseBytes' => strlen($exchange['body']),
                'udpListenPort' => circuit_udp_listen_port($sessionId, $udpListenPort),
                'simPinnedIp' => $resolve['pinnedIp'],
            ]);
        } catch (Throwable $e) {
            return json_response_data(502, ['error' => $e->getMessage()]);
        }
    }
    if ($path === '/circuit/open' && $method === 'POST') {
        $body = read_body();
        if ($body === null || empty($body['sim_ip']) || empty($body['sim_port'])) {
            return json_response_data(400, ['error' => 'sim_ip and sim_port required']);
        }
        try {
            $sid = open_circuit($body);
            $s = $sessions[$sid];
            $out = [
                'sessionId' => $sid,
                'sim' => normalize_sim_ip($body['sim_ip']) . ':' . (int)$body['sim_port'],
                'localPort' => $s['local_port'] ?? 0,
                'connected' => !empty($s['connected']),
                'packets' => [],
                'sent' => 0,
                'recv' => 0,
                'bytesSent' => 0,
            ];
            $circuitCode = (int)($body['circuit_code'] ?? 0);
            $sessionId = trim((string)($body['session_id'] ?? ''), " \t\"'");
            $agentId = trim((string)($body['agent_id'] ?? ''), " \t\"'");
            if ($circuitCode > 0 && $sessionId !== '' && $agentId !== '') {
                $out = array_merge($out, begin_circuit_handshake($sid, $circuitCode, $sessionId, $agentId));
            }
            return json_response_data(200, $out);
        } catch (Throwable $e) {
            return json_response_data(500, ['error' => $e->getMessage()]);
        }
    }
    if ($path === '/circuit/close' && $method === 'POST') {
        $body = read_body();
        close_circuit($body['sessionId'] ?? '');
        return json_response_data(200, ['ok' => true]);
    }
    if ($path === '/circuit/retarget' && $method === 'POST') {
        $body = read_body();
        if ($body === null || empty($body['sessionId']) || empty($body['sim_ip']) || empty($body['sim_port'])) {
            return json_response_data(400, ['error' => 'sessionId, sim_ip and sim_port required']);
        }
        try {
            $meta = retarget_circuit(
                (string)$body['sessionId'],
                (string)$body['sim_ip'],
                (int)$body['sim_port']
            );
            return json_response_data(200, array_merge(['ok' => true], $meta));
        } catch (Throwable $e) {
            return json_response_data(500, ['error' => $e->getMessage()]);
        }
    }
    if ($path === '/circuit/send' && $method === 'POST') {
        $body = read_body();
        $id = $body['sessionId'] ?? '';
        $packet = $body['packet'] ?? '';
        if (!isset($sessions[$id]) || $packet === '') {
            return json_response_data(400, ['error' => 'Invalid session or packet']);
        }
        $bin = base64_decode($packet, true);
        if ($bin === false) {
            return json_response_data(400, ['error' => 'Invalid base64 packet']);
        }
        $s = $sessions[$id];
        drain_udp($id);
        $targetIp = isset($body['sim_ip']) ? normalize_sim_ip((string)$body['sim_ip']) : null;
        $targetPort = isset($body['sim_port']) ? (int)$body['sim_port'] : null;
        $sent = udp_send(
            $s,
            $bin,
            ($targetIp !== '' ? $targetIp : null),
            ($targetPort > 0 ? $targetPort : null)
        );
        drain_udp($id);
        return json_response_data(200, ['sent' => $sent > 0, 'bytesSent' => $sent]);
    }
    if ($path === '/circuit/poll' && $method === 'GET') {
        $id = $_GET['sessionId'] ?? '';
        $timeout = min(60, max(0.1, (float)($_GET['timeout'] ?? 25)));
        if (!isset($sessions[$id])) {
            return json_response_data(404, ['error' => 'Unknown session']);
        }
        wait_for_udp($id, $timeout);
        drain_circuit_http($id);
        if (circuit_pending_recv_count($sessions[$id]) > 0) {
            return json_response_data(200, circuit_take_recv_payload($sessions[$id]));
        }
        return json_response_data(200, ['packets' => []]);
    }
    if ($path === '/circuit/exchange' && $method === 'POST') {
        $body = read_body();
        if ($body === null) {
            return json_response_data(400, ['error' => 'Invalid JSON']);
        }
        $id = $body['sessionId'] ?? '';
        if (!isset($sessions[$id])) {
            return json_response_data(404, ['error' => 'Unknown session']);
        }
        $timeout = min(60, max(0.05, (float)($body['timeout'] ?? 5)));
        $packets = $body['packets'] ?? [];
        if (!is_array($packets)) {
            $packets = [];
        }
        $s = $sessions[$id];
        $sent = 0;
        $bytesSent = 0;
        drain_udp($id);
        foreach ($packets as $b64) {
            if (!is_string($b64) || $b64 === '') {
                continue;
            }
            $bin = base64_decode($b64, true);
            if ($bin === false || $bin === '') {
                continue;
            }
            $n = udp_send($s, $bin);
            if ($n > 0) {
                $sent++;
                $bytesSent += $n;
            }
        }
        drain_udp($id);
        if (circuit_pending_recv_count($sessions[$id]) === 0) {
            wait_for_udp($id, $timeout);
        }
        drain_circuit_http($id);
        $meta = circuit_exchange_meta($sessions[$id]);
        if (circuit_pending_recv_count($sessions[$id]) > 0) {
            $payload = circuit_take_recv_payload($sessions[$id]);
            $received = $payload['packets'] ?? [];
            return json_response_data(200, array_merge([
                'packets' => $received,
                'sent' => $sent,
                'recv' => count($received),
                'bytesSent' => $bytesSent,
            ], $payload, $meta));
        }
        return json_response_data(200, array_merge([
            'packets' => [],
            'sent' => $sent,
            'recv' => 0,
            'bytesSent' => $bytesSent,
        ], $meta));
    }
    if ($method === 'GET') {
        if ($path === '/' || $path === '/index.html') {
            $resp = serve_static_file('/index.html');
            if ($resp !== null) {
                return $resp;
            }
        }
        if ($path === '/favicon.ico') {
            $resp = serve_static_file('/favicon.ico');
            if ($resp !== null) {
                return $resp;
            }
        }
        if (preg_match('#^/(js|css)/#', $path) === 1) {
            $resp = serve_static_file($path);
            if ($resp !== null) {
                return $resp;
            }
        }
    }
    return json_response_data(404, ['error' => 'Not found']);
}

function emit_http(HttpResponse $resp): string
{
    $statusText = match ($resp->status) {
        204 => 'No Content', 404 => 'Not Found', 400 => 'Bad Request',
        502 => 'Bad Gateway', 500 => 'Internal Server Error', default => 'OK',
    };
    $out = 'HTTP/1.1 ' . $resp->status . ' ' . $statusText . "\r\nConnection: close\r\n";
    foreach ($resp->headers as $k => $v) {
        $out .= $k . ': ' . $v . "\r\n";
    }
    $out .= 'Content-Length: ' . strlen($resp->body) . "\r\n\r\n" . $resp->body;
    return $out;
}

class BridgeClient
{
    /** @var resource */
    public $stream;
    public string $buffer = '';
    public ?HttpResponse $response = null;
    public string $responseBytes = '';
    public int $responseOffset = 0;

    /** @param resource $stream */
    public function __construct($stream)
    {
        $this->stream = $stream;
    }
}

/** @return array{method:string,path:string,query:array<string,mixed>,rawBody:string}|null */
function parse_bridge_http_request(string $req): ?array
{
    if ($req === '') {
        return null;
    }
    $lines = explode("\r\n", $req);
    $parts = explode(' ', $lines[0] ?? 'GET /');
    $method = strtoupper($parts[0] ?? 'GET');
    $uri = $parts[1] ?? '/';
    $qpos = strpos($uri, '?');
    $path = $qpos === false ? $uri : substr($uri, 0, $qpos);
    $query = [];
    if ($qpos !== false) {
        parse_str(substr($uri, $qpos + 1), $query);
    }
    $hdrEnd = strpos($req, "\r\n\r\n");
    $rawBody = $hdrEnd !== false ? substr($req, $hdrEnd + 4) : '';
    return [
        'method' => $method,
        'path' => $path,
        'query' => $query,
        'rawBody' => $rawBody,
    ];
}

function bridge_request_complete(string $buffer): bool
{
    if ($buffer === '') {
        return false;
    }
    $hdrEnd = strpos($buffer, "\r\n\r\n");
    if ($hdrEnd === false) {
        return strlen($buffer) > 1048576;
    }
    if (!preg_match('/Content-Length:\s*(\d+)/i', substr($buffer, 0, $hdrEnd), $m)) {
        return true;
    }
    return (strlen($buffer) - $hdrEnd - 4) >= (int)$m[1];
}

function bridge_apply_request_context(array $parsed): void
{
    $_GET = is_array($parsed['query']) ? $parsed['query'] : [];
    $GLOBALS['BRIDGE_RAW_BODY'] = (string)($parsed['rawBody'] ?? '');
}

/** @return array<string, mixed> */
/** @var array<string, list<array{client:BridgeClient,params:array<string,mixed>}>> $eqPollWaitQueues */
$eqPollWaitQueues = [];

/** @var array<string, true> $eqPollLanesBusy */
$eqPollLanesBusy = [];

function bridge_proxy_is_eventqueue_poll(string $payload): bool
{
    return stripos($payload, '<key>done</key>') !== false;
}

function bridge_eq_poll_lane_key(string $url, string $agentSessionId): string
{
    return hash('sha256', normalize_seed_url($url) . '|' . $agentSessionId);
}

/**
 * @param array<string, mixed> $params
 */
function bridge_enqueue_eq_poll_waiter(
    string $laneKey,
    BridgeClient $client,
    array $params
): bool {
    global $eqPollWaitQueues;
    if (!isset($eqPollWaitQueues[$laneKey])) {
        $eqPollWaitQueues[$laneKey] = [];
    }
    $eqPollWaitQueues[$laneKey][] = ['client' => $client, 'params' => $params];
    return true;
}

/**
 * @param array<int, array<string, mixed>> $curlJobs
 * @param \CurlMultiHandle $curlMulti
 */
function bridge_drain_eq_poll_waiters(string $laneKey, array &$curlJobs, $curlMulti): void
{
    global $eqPollWaitQueues, $eqPollLanesBusy;
    unset($eqPollLanesBusy[$laneKey]);
    $queue = $eqPollWaitQueues[$laneKey] ?? [];
    if (!$queue) {
        unset($eqPollWaitQueues[$laneKey]);
        return;
    }
    $next = array_shift($queue);
    if ($queue) {
        $eqPollWaitQueues[$laneKey] = $queue;
    } else {
        unset($eqPollWaitQueues[$laneKey]);
    }
    if (!$next || !($next['client'] instanceof BridgeClient)) {
        return;
    }
    $client = $next['client'];
    if ($client->response !== null) {
        bridge_drain_eq_poll_waiters($laneKey, $curlJobs, $curlMulti);
        return;
    }
    bridge_start_eq_poll_proxy_job($client, $next['params'], $curlJobs, $curlMulti);
}

/**
 * @param array<string, mixed> $params
 * @param array<int, array<string, mixed>> $curlJobs
 * @param \CurlMultiHandle $multi
 */
function bridge_start_eq_poll_proxy_job(
    BridgeClient $client,
    array $params,
    array &$curlJobs,
    $multi
): void {
    global $eqPollLanesBusy;
    $url = normalize_seed_url((string)($params['url'] ?? ''));
    if ($url === '') {
        $client->response = json_response_data(400, ['error' => 'url required']);
        return;
    }
    $laneKey = bridge_eq_poll_lane_key($url, (string)($params['agentSessionId'] ?? ''));
    if (!empty($eqPollLanesBusy[$laneKey])) {
        bridge_enqueue_eq_poll_waiter($laneKey, $client, $params);
        return;
    }
    $eqPollLanesBusy[$laneKey] = true;

    $headers = [
        'Accept: application/llsd+xml, application/xml',
        'User-Agent: ' . minibee_user_agent(),
    ];
    if ($params['agentSessionId'] !== '') {
        $headers[] = 'X-SecondLife-Session-ID: ' . $params['agentSessionId'];
    }
    $sessionId = (string)($params['sessionId'] ?? '');
    if ($sessionId !== '') {
        refresh_session_local_port($sessionId);
    }
    proxy_sl_headers($headers, $sessionId, (int)($params['udpListenPort'] ?? 0));
    $simIp = proxy_sim_ip_for_session($sessionId, (string)($params['simIp'] ?? ''));
    $resolve = proxy_simhost_curl_opts($url, !empty($params['pinSimIp']) ? $simIp : '');
    $extraOpts = array_replace($resolve['opts'], [
        CURLOPT_TIMEOUT => (int)($params['timeoutSec'] ?? 45),
    ]);
    $method = (string)($params['method'] ?? 'POST');
    $payload = (string)($params['payload'] ?? '');
    $contentType = (string)($params['contentType'] ?? 'application/llsd+xml');
    $ch = bridge_create_proxy_curl_handle($method, $url, $payload, $contentType, $headers, $extraOpts);
    if ($ch === false) {
        unset($eqPollLanesBusy[$laneKey]);
        $client->response = json_response_data(502, ['error' => 'curl_init failed']);
        bridge_drain_eq_poll_waiters($laneKey, $curlJobs, $multi);
        return;
    }
    drain_all_udp_sessions();
    curl_multi_add_handle($multi, $ch);
    $curlJobs[] = [
        'client' => $client,
        'curl' => $ch,
        'multi' => $multi,
        'method' => $method,
        'url' => $url,
        'payload' => $payload,
        'contentType' => $contentType,
        'headers' => $headers,
        'extraOpts' => $extraOpts,
        'redirectCount' => 0,
        'sessionId' => $sessionId,
        'udpListenPort' => (int)($params['udpListenPort'] ?? 0),
        'requestBytes' => (int)($params['requestBytes'] ?? 0),
        'resolve' => $resolve,
        'isEventQueue' => true,
        'eqPollLaneKey' => $laneKey,
    ];
}

function bridge_parse_proxy_params(string $method, ?array $body): array
{
    if ($method === 'GET') {
        return [
            'method' => 'GET',
            'url' => (string)($_GET['url'] ?? ''),
            'payload' => '',
            'contentType' => 'application/llsd+xml',
            'sessionId' => (string)($_GET['sessionId'] ?? ''),
            'udpListenPort' => empty($_GET['preCircuit']) ? (int)($_GET['udpListenPort'] ?? 0) : 0,
            'simIp' => (string)($_GET['simIp'] ?? ''),
            'pinSimIp' => ($_GET['pinSimIp'] ?? '1') !== '0',
            'agentSessionId' => trim((string)($_GET['agentSessionId'] ?? ''), " \t\"'"),
            'timeoutSec' => 45,
            'requestBytes' => 0,
        ];
    }
    $payload = is_array($body) ? ($body['body'] ?? '') : '';
    $postBody = is_string($payload) ? $payload : json_encode($payload);
    return [
        'method' => 'POST',
        'url' => is_array($body) ? (string)($body['url'] ?? '') : '',
        'payload' => $postBody,
        'contentType' => is_array($body) ? (string)($body['contentType'] ?? 'application/llsd+xml') : 'application/llsd+xml',
        'sessionId' => is_array($body) ? (string)($body['sessionId'] ?? '') : '',
        'udpListenPort' => (is_array($body) && empty($body['preCircuit'])) ? (int)($body['udpListenPort'] ?? 0) : 0,
        'simIp' => is_array($body) ? (string)($body['simIp'] ?? '') : '',
        'pinSimIp' => !(is_array($body) && isset($body['pinSimIp']) && $body['pinSimIp'] === false),
        'agentSessionId' => is_array($body) ? trim((string)($body['agentSessionId'] ?? ''), " \t\"'") : '',
        'timeoutSec' => (is_array($body) && isset($body['timeoutSec']))
            ? min(95, max(10, (int)$body['timeoutSec'])) : 45,
        'requestBytes' => strlen($postBody),
    ];
}

/**
 * @param array<string, mixed> $params
 * @param array<string, string> $headers
 * @return resource|\CurlHandle|false
 */
function bridge_create_proxy_curl_handle(string $method, string $url, string $payload, string $contentType, array $headers, array $extraCurlOpts = [])
{
    $ch = curl_init($url);
    if ($ch === false) {
        return false;
    }
    $reqHeaders = $headers;
    if (strtoupper($method) === 'POST' && $contentType !== '') {
        $hasContentType = false;
        foreach ($reqHeaders as $hdr) {
            if (stripos($hdr, 'Content-Type:') === 0) {
                $hasContentType = true;
                break;
            }
        }
        if (!$hasContentType) {
            $reqHeaders[] = 'Content-Type: ' . $contentType;
        }
    }
    $opts = array_replace([
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 45,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADER => true,
        CURLOPT_HTTPHEADER => $reqHeaders,
    ], curl_common_options(), $extraCurlOpts);
    if (strtoupper($method) === 'POST') {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = $payload;
    } else {
        $opts[CURLOPT_HTTPGET] = true;
    }
    curl_setopt_array($ch, $opts);
    return $ch;
}

/** @param array<string, mixed> $job */
function bridge_finish_proxy_job(array &$job): ?HttpResponse
{
    $ch = $job['curl'];
    $raw = curl_multi_getcontent($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $effectiveUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $err = curl_error($ch);
    curl_multi_remove_handle($job['multi'], $ch);
    curl_close($ch);
    $laneKey = (string)($job['eqPollLaneKey'] ?? '');
    $client = $job['client'] ?? null;
    $detached = !empty($job['detached']) || !($client instanceof BridgeClient);

    if ($raw === false) {
        if ($laneKey !== '' && $detached) {
            return null;
        }
        return json_response_data(502, ['error' => 'Proxy HTTP error: ' . $err . curl_ssl_hint()]);
    }

    $rawHeaders = substr($raw, 0, $headerSize);
    $body = substr($raw, $headerSize);
    $redirectCount = (int)($job['redirectCount'] ?? 0);
    $maxRedirects = 6;

    if ($code >= 300 && $code < 400 && $redirectCount < $maxRedirects) {
        $location = '';
        foreach (preg_split("/\r\n|\n|\r/", $rawHeaders) as $line) {
            if (stripos($line, 'Location:') === 0) {
                $location = trim(substr($line, 9));
                break;
            }
        }
        if ($location !== '') {
            $url = (string)($job['url'] ?? '');
            $origHost = parse_url($url, PHP_URL_HOST) ?: '';
            $nextHost = parse_url($location, PHP_URL_HOST) ?: '';
            if ($origHost !== '' && $nextHost !== '' &&
                strcasecmp($origHost, $nextHost) !== 0 &&
                !preg_match('/^simhost-/i', $nextHost)) {
                return json_response_data(502, [
                    'error' => 'Seed cap redirect left simhost (' . $origHost . ' -> ' . $nextHost . ')',
                ]);
            }
            if (!preg_match('#^[a-z][a-z0-9+.-]*:#i', $location)) {
                $parts = parse_url($url);
                $scheme = $parts['scheme'] ?? 'http';
                $host = $parts['host'] ?? '';
                $port = isset($parts['port']) ? (':' . $parts['port']) : '';
                $prefix = $scheme . '://' . $host . $port;
                if (str_starts_with($location, '/')) {
                    $location = $prefix . $location;
                } else {
                    $dir = $parts['path'] ?? '/';
                    $dir = preg_replace('#/[^/]*$#', '/', $dir) ?? '/';
                    $location = $prefix . $dir . $location;
                }
            }
            $job['url'] = $location;
            $job['redirectCount'] = $redirectCount + 1;
            $newCh = bridge_create_proxy_curl_handle(
                (string)($job['method'] ?? 'POST'),
                $location,
                (string)($job['payload'] ?? ''),
                (string)($job['contentType'] ?? 'application/llsd+xml'),
                $job['headers'] ?? [],
                $job['extraOpts'] ?? []
            );
            if ($newCh === false) {
                return json_response_data(502, ['error' => 'Proxy redirect curl_init failed']);
            }
            $job['curl'] = $newCh;
            curl_multi_add_handle($job['multi'], $newCh);
            return null;
        }
    }

    $sessionId = (string)($job['sessionId'] ?? '');
    $udpListenPort = (int)($job['udpListenPort'] ?? 0);
    $resolve = $job['resolve'] ?? ['opts' => [], 'pinnedIp' => ''];
    return json_response_data(200, [
        'status' => $code,
        'contentType' => $ctype,
        'body' => $body,
        'effectiveUrl' => $effectiveUrl !== '' ? $effectiveUrl : (string)($job['url'] ?? ''),
        'redirectCount' => $redirectCount,
        'requestBytes' => (int)($job['requestBytes'] ?? 0),
        'responseBytes' => strlen($body),
        'udpListenPort' => circuit_udp_listen_port($sessionId, $udpListenPort),
        'simPinnedIp' => $resolve['pinnedIp'] ?? '',
    ]);
}

/**
 * @param array<int, array<string, mixed>> $jobs
 * @param \CurlMultiHandle $multi
 */
function bridge_process_curl_jobs(array &$jobs, $multi): void
{
    if (!$jobs) {
        return;
    }
    do {
        $status = curl_multi_exec($multi, $active);
        drain_all_udp_sessions();
        if ($active) {
            curl_multi_select($multi, 0.05);
            drain_all_udp_sessions();
        }
    } while ($status === CURLM_CALL_MULTI_PERFORM);

    while ($info = curl_multi_info_read($multi)) {
        if ($info['msg'] !== CURLMSG_DONE) {
            continue;
        }
        $handle = $info['handle'];
        foreach ($jobs as $idx => &$job) {
            if (($job['curl'] ?? null) !== $handle) {
                continue;
            }
            $laneKey = (string)($job['eqPollLaneKey'] ?? '');
            $client = $job['client'] ?? null;
            $detached = !empty($job['detached']) || !($client instanceof BridgeClient);
            $response = bridge_finish_proxy_job($job);
            if ($response !== null) {
                if ($client instanceof BridgeClient) {
                    $client->response = $response;
                }
                unset($jobs[$idx]);
                if ($laneKey !== '') {
                    bridge_drain_eq_poll_waiters($laneKey, $jobs, $multi);
                }
            } elseif ($laneKey !== '' && $detached) {
                unset($jobs[$idx]);
                bridge_drain_eq_poll_waiters($laneKey, $jobs, $multi);
            }
            break;
        }
        unset($job);
    }
    $jobs = array_values($jobs);
}

/** @param list<array{client:BridgeClient,sessionId:string,deadline:float}> $waiters */
function bridge_resolve_poll_waiters(array &$waiters): void
{
    global $sessions;
    foreach ($waiters as $idx => $waiter) {
        $sid = $waiter['sessionId'];
        if (!isset($sessions[$sid])) {
            $waiter['client']->response = json_response_data(404, ['error' => 'Unknown session']);
            unset($waiters[$idx]);
            continue;
        }
        if (circuit_pending_recv_count($sessions[$sid]) > 0) {
            $payload = circuit_take_recv_payload($sessions[$sid]);
            $waiter['client']->response = json_response_data(200, $payload);
            unset($waiters[$idx]);
            continue;
        }
        if (microtime(true) >= $waiter['deadline']) {
            $waiter['client']->response = json_response_data(200, ['packets' => []]);
            unset($waiters[$idx]);
        }
    }
    $waiters = array_values($waiters);
}

/**
 * @param list<array{
 *   client:BridgeClient,
 *   sessionId:string,
 *   deadline:float,
 *   sent:int,
 *   bytesSent:int
 * }> $waiters
 */
function bridge_resolve_exchange_waiters(array &$waiters): void
{
    global $sessions;
    foreach ($waiters as $idx => $waiter) {
        $sid = $waiter['sessionId'];
        if (!isset($sessions[$sid])) {
            $waiter['client']->response = json_response_data(404, ['error' => 'Unknown session']);
            unset($waiters[$idx]);
            continue;
        }
        if (circuit_pending_recv_count($sessions[$sid]) > 0) {
            $payload = circuit_take_recv_payload($sessions[$sid]);
            $received = $payload['packets'] ?? [];
            $meta = circuit_exchange_meta($sessions[$sid]);
            $waiter['client']->response = json_response_data(200, array_merge([
                'packets' => $received,
                'sent' => $waiter['sent'],
                'recv' => count($received),
                'bytesSent' => $waiter['bytesSent'],
            ], $payload, $meta));
            unset($waiters[$idx]);
            continue;
        }
        if (microtime(true) >= $waiter['deadline']) {
            $meta = circuit_exchange_meta($sessions[$sid]);
            $waiter['client']->response = json_response_data(200, array_merge([
                'packets' => [],
                'sent' => $waiter['sent'],
                'recv' => 0,
                'bytesSent' => $waiter['bytesSent'],
            ], $meta));
            unset($waiters[$idx]);
        }
    }
    $waiters = array_values($waiters);
}

/**
 * @param list<BridgeClient> $clients
 * @param list<array{client:BridgeClient,sessionId:string,deadline:float}> $pollWaiters
 * @param list<array{client:BridgeClient,sessionId:string,deadline:float,sent:int,bytesSent:int}> $exchangeWaiters
 * @param array<int, array<string, mixed>> $curlJobs
 */
function bridge_dispatch_client(
    BridgeClient $client,
    string $method,
    string $path,
    array &$pollWaiters,
    array &$exchangeWaiters,
    array &$curlJobs,
    $curlMulti
): void {
    global $sessions;

    if (bridge_is_circuit_path($path) && !bridge_is_poll_role()) {
        $client->response = json_response_data(404, [
            'error' => 'Circuit routes are served by the poll bridge at ' . bridge_poll_base_url(),
        ]);
        return;
    }

    if ($path === '/circuit/poll' && $method === 'GET') {
        $id = (string)($_GET['sessionId'] ?? '');
        $timeout = min(60, max(0.1, (float)($_GET['timeout'] ?? 25)));
        if (!isset($sessions[$id])) {
            $client->response = json_response_data(404, ['error' => 'Unknown session']);
            return;
        }
        drain_udp($id);
        drain_circuit_http($id);
        if (circuit_pending_recv_count($sessions[$id]) > 0) {
            $payload = circuit_take_recv_payload($sessions[$id]);
            $client->response = json_response_data(200, $payload);
            return;
        }
        $pollWaiters[] = [
            'client' => $client,
            'sessionId' => $id,
            'deadline' => microtime(true) + $timeout,
        ];
        return;
    }

    if ($path === '/circuit/exchange' && $method === 'POST') {
        $body = read_body();
        if ($body === null) {
            $client->response = json_response_data(400, ['error' => 'Invalid JSON']);
            return;
        }
        $id = (string)($body['sessionId'] ?? '');
        if (!isset($sessions[$id])) {
            $client->response = json_response_data(404, ['error' => 'Unknown session']);
            return;
        }
        $timeout = min(60, max(0.05, (float)($body['timeout'] ?? 5)));
        $packets = $body['packets'] ?? [];
        if (!is_array($packets)) {
            $packets = [];
        }
        $s = $sessions[$id];
        $sent = 0;
        $bytesSent = 0;
        drain_udp($id);
        foreach ($packets as $b64) {
            if (!is_string($b64) || $b64 === '') {
                continue;
            }
            $bin = base64_decode($b64, true);
            if ($bin === false || $bin === '') {
                continue;
            }
            $n = udp_send($s, $bin);
            if ($n > 0) {
                $sent++;
                $bytesSent += $n;
            }
        }
        drain_udp($id);
        drain_circuit_http($id);
        if (circuit_pending_recv_count($sessions[$id]) > 0) {
            $payload = circuit_take_recv_payload($sessions[$id]);
            $received = $payload['packets'] ?? [];
            $meta = circuit_exchange_meta($sessions[$id]);
            $client->response = json_response_data(200, array_merge([
                'packets' => $received,
                'sent' => $sent,
                'recv' => count($received),
                'bytesSent' => $bytesSent,
            ], $payload, $meta));
            return;
        }
        $exchangeWaiters[] = [
            'client' => $client,
            'sessionId' => $id,
            'deadline' => microtime(true) + $timeout,
            'sent' => $sent,
            'bytesSent' => $bytesSent,
        ];
        return;
    }

    if ($path === '/proxy' && ($method === 'POST' || $method === 'GET')) {
        if (!bridge_is_caps_role()) {
            $client->response = json_response_data(404, ['error' => 'Proxy routes are served by the caps bridge']);
            return;
        }
        $body = read_body();
        if ($method === 'POST' && ($body === null || empty($body['url']))) {
            $client->response = json_response_data(400, ['error' => 'url required']);
            return;
        }
        $params = bridge_parse_proxy_params($method, is_array($body) ? $body : null);
        if ($params['url'] === '') {
            $client->response = json_response_data(400, ['error' => 'url required']);
            return;
        }
        if (!function_exists('curl_init')) {
            $client->response = json_response_data(502, ['error' => 'curl required']);
            return;
        }
        $params['method'] = $method;
        if (bridge_proxy_is_eventqueue_poll((string)$params['payload'])) {
            bridge_start_eq_poll_proxy_job($client, $params, $curlJobs, $curlMulti);
            return;
        }
        $url = normalize_seed_url((string)$params['url']);
        $headers = [
            'Accept: application/llsd+xml, application/xml',
            'User-Agent: ' . minibee_user_agent(),
        ];
        if ($params['agentSessionId'] !== '') {
            $headers[] = 'X-SecondLife-Session-ID: ' . $params['agentSessionId'];
        }
        $sessionId = (string)$params['sessionId'];
        if ($sessionId !== '') {
            refresh_session_local_port($sessionId);
        }
        proxy_sl_headers($headers, $sessionId, (int)$params['udpListenPort']);
        $simIp = proxy_sim_ip_for_session($sessionId, (string)$params['simIp']);
        $resolve = proxy_simhost_curl_opts($url, $params['pinSimIp'] ? $simIp : '');
        $extraOpts = array_replace($resolve['opts'], [CURLOPT_TIMEOUT => (int)$params['timeoutSec']]);
        $ch = bridge_create_proxy_curl_handle(
            $method,
            $url,
            (string)$params['payload'],
            (string)$params['contentType'],
            $headers,
            $extraOpts
        );
        if ($ch === false) {
            $client->response = json_response_data(502, ['error' => 'curl_init failed']);
            return;
        }
        drain_all_udp_sessions();
        curl_multi_add_handle($curlMulti, $ch);
        $curlJobs[] = [
            'client' => $client,
            'curl' => $ch,
            'multi' => $curlMulti,
            'method' => $method,
            'url' => $url,
            'payload' => (string)$params['payload'],
            'contentType' => (string)$params['contentType'],
            'headers' => $headers,
            'extraOpts' => $extraOpts,
            'redirectCount' => 0,
            'sessionId' => $sessionId,
            'udpListenPort' => (int)$params['udpListenPort'],
            'requestBytes' => (int)$params['requestBytes'],
            'resolve' => $resolve,
        ];
        return;
    }

    if (bridge_role() === 'poll' && !bridge_is_circuit_path($path) && $path !== '/health') {
        $client->response = json_response_data(404, ['error' => 'Not found']);
        return;
    }

    if (bridge_role() === 'caps' && bridge_is_circuit_path($path)) {
        $client->response = json_response_data(404, [
            'error' => 'Circuit routes are served by the poll bridge at ' . bridge_poll_base_url(),
        ]);
        return;
    }

    try {
        $client->response = handle_request($method, $path);
    } catch (Throwable $e) {
        $client->response = json_response_data(500, ['error' => $e->getMessage()]);
    }
}

/** @param list<array{client:BridgeClient,sessionId:string,deadline:float}> $waiters */
function bridge_drop_client_eq_waiters(BridgeClient $client): void
{
    global $eqPollWaitQueues;
    foreach ($eqPollWaitQueues as $laneKey => $queue) {
        $eqPollWaitQueues[$laneKey] = array_values(array_filter(
            $queue,
            static fn(array $row): bool => ($row['client'] ?? null) !== $client
        ));
        if (!$eqPollWaitQueues[$laneKey]) {
            unset($eqPollWaitQueues[$laneKey]);
        }
    }
}

function bridge_drop_client_waiters(BridgeClient $client, array &$pollWaiters, array &$exchangeWaiters): void
{
    bridge_drop_client_eq_waiters($client);
    $pollWaiters = array_values(array_filter(
        $pollWaiters,
        static fn(array $w): bool => $w['client'] !== $client
    ));
    $exchangeWaiters = array_values(array_filter(
        $exchangeWaiters,
        static fn(array $w): bool => $w['client'] !== $client
    ));
}

/**
 * @param array<int, array<string, mixed>> $jobs
 * @param \CurlMultiHandle $multi
 */
function bridge_drop_client_curl_jobs(BridgeClient $client, array &$jobs, $multi): void
{
    foreach ($jobs as $idx => &$job) {
        if (($job['client'] ?? null) !== $client) {
            continue;
        }
        if (!empty($job['isEventQueue'])) {
            $job['client'] = null;
            $job['detached'] = true;
            continue;
        }
        $ch = $job['curl'] ?? null;
        if ($ch) {
            curl_multi_remove_handle($multi, $ch);
            curl_close($ch);
        }
        unset($jobs[$idx]);
    }
    unset($job);
    $jobs = array_values($jobs);
}

/**
 * @param array<int, array<string, mixed>> $jobs
 * @param \CurlMultiHandle $multi
 */
function bridge_cancel_client_curl_jobs(BridgeClient $client, array &$jobs, $multi): void
{
    bridge_drop_client_curl_jobs($client, $jobs, $multi);
}

/** @param resource $server */
function bridge_run_concurrent_server($server): void
{
    global $sessions;

    stream_set_blocking($server, false);
    /** @var list<BridgeClient> $clients */
    $clients = [];
    /** @var list<array{client:BridgeClient,sessionId:string,deadline:float}> $pollWaiters */
    $pollWaiters = [];
    /** @var list<array{client:BridgeClient,sessionId:string,deadline:float,sent:int,bytesSent:int}> $exchangeWaiters */
    /** @var array<int, array<string, mixed>> $curlJobs */
    $curlJobs = [];
    $exchangeWaiters = [];
    $enableProxy = bridge_is_caps_role();
    $curlMulti = $enableProxy ? curl_multi_init() : false;
    if ($enableProxy && $curlMulti === false) {
        throw new RuntimeException('curl_multi_init failed');
    }

    while (true) {
        drain_all_udp_sessions();
        drain_all_circuit_http();
        bridge_resolve_poll_waiters($pollWaiters);
        bridge_resolve_exchange_waiters($exchangeWaiters);
        if ($enableProxy && $curlMulti !== false) {
            bridge_process_curl_jobs($curlJobs, $curlMulti);
        }

        $read = [$server];
        foreach (circuit_http_servers() as $httpServer) {
            $read[] = $httpServer;
        }
        foreach ($clients as $client) {
            if ($client->response === null) {
                $read[] = $client->stream;
            }
        }

        $tvSec = 0;
        $tvUsec = POLL_MS * 1000;
        $writable = [];
        $except = [];
        @stream_select($read, $writable, $except, $tvSec, $tvUsec);

        if (in_array($server, $read, true)) {
            $accepted = @stream_socket_accept($server, 0);
            if ($accepted !== false) {
                stream_set_blocking($accepted, false);
                stream_set_timeout($accepted, 120);
                $clients[] = new BridgeClient($accepted);
            }
        }

        foreach ($clients as $idx => $client) {
            if ($client->response !== null) {
                continue;
            }
            $chunk = @fread($client->stream, 8192);
            if ($chunk === false) {
                bridge_drop_client_waiters($client, $pollWaiters, $exchangeWaiters);
                if ($enableProxy && $curlMulti !== false) {
                    bridge_cancel_client_curl_jobs($client, $curlJobs, $curlMulti);
                }
                fclose($client->stream);
                unset($clients[$idx]);
                continue;
            }
            if ($chunk !== '') {
                $client->buffer .= $chunk;
                if (strlen($client->buffer) > 1048576) {
                    bridge_drop_client_waiters($client, $pollWaiters, $exchangeWaiters);
                    if ($enableProxy && $curlMulti !== false) {
                        bridge_cancel_client_curl_jobs($client, $curlJobs, $curlMulti);
                    }
                    fclose($client->stream);
                    unset($clients[$idx]);
                    continue;
                }
            } elseif (feof($client->stream)) {
                bridge_drop_client_waiters($client, $pollWaiters, $exchangeWaiters);
                if ($enableProxy && $curlMulti !== false) {
                    bridge_cancel_client_curl_jobs($client, $curlJobs, $curlMulti);
                }
                fclose($client->stream);
                unset($clients[$idx]);
                continue;
            }

            if (!bridge_request_complete($client->buffer)) {
                continue;
            }

            $parsed = parse_bridge_http_request($client->buffer);
            if ($parsed === null) {
                $client->response = json_response_data(400, ['error' => 'Invalid HTTP request']);
            } else {
                bridge_apply_request_context($parsed);
                bridge_dispatch_client(
                    $client,
                    $parsed['method'],
                    $parsed['path'],
                    $pollWaiters,
                    $exchangeWaiters,
                    $curlJobs,
                    $curlMulti
                );
            }
        }
        $clients = array_values($clients);

        foreach ($clients as $idx => $client) {
            if ($client->response === null) {
                continue;
            }
            if ($client->responseBytes === '') {
                $client->responseBytes = emit_http($client->response);
                $client->responseOffset = 0;
            }
            $remaining = substr($client->responseBytes, $client->responseOffset);
            if ($remaining === '') {
                fclose($client->stream);
                unset($clients[$idx]);
                continue;
            }
            $written = @fwrite($client->stream, $remaining);
            if ($written === false) {
                bridge_drop_client_waiters($client, $pollWaiters, $exchangeWaiters);
                if ($enableProxy && $curlMulti !== false) {
                    bridge_cancel_client_curl_jobs($client, $curlJobs, $curlMulti);
                }
                fclose($client->stream);
                unset($clients[$idx]);
                continue;
            }
            $client->responseOffset += $written;
            if ($client->responseOffset >= strlen($client->responseBytes)) {
                fclose($client->stream);
                unset($clients[$idx]);
            }
        }
        $clients = array_values($clients);
    }
}

function minibee_bridge_main(): void
{
    if (!function_exists('socket_create')) {
        fwrite(STDERR, "PHP sockets extension required.\n");
        fwrite(STDERR, "Enable extension=sockets in php.ini, or use start-minibee.bat on Windows.\n");
        exit(1);
    }

    $port = bridge_listen_port();
    $server = stream_socket_server('tcp://' . HOST . ':' . $port);
    if ($server === false) {
        fwrite(STDERR, 'Failed to bind ' . HOST . ':' . $port . "\n");
        exit(1);
    }
    minibee_print_bridge_banner();
    if (bridge_is_caps_role()) {
        $caBoot = ensure_ca_bundle();
        if ($caBoot['ok'] && isset($caBoot['path'])) {
            fwrite(STDOUT, 'CA bundle: ' . $caBoot['path'] . "\n");
        } else {
            fwrite(STDERR, 'CA bundle: not available yet (viewer can download on connect).' . "\n");
        }
        minibee_print_stop_notice();
    }
    bridge_run_concurrent_server($server);
}

if (php_sapi_name() !== 'cli') {
    exit("Run via CLI: php bridge/poll.php and php bridge/caps.php\n");
}

if (isset($argv[1]) && $argv[1] === '--check-ca') {
    $result = ensure_ca_bundle();
    if ($result['ok'] && isset($result['path'])) {
        fwrite(STDOUT, 'CA bundle: ' . $result['path'] . "\n");
        exit(0);
    }
    fwrite(STDERR, 'No CA bundle available.' . curl_ssl_hint() . "\n");
    fwrite(STDERR, "Run: php bridge/daemon.php --fetch-ca\n");
    exit(1);
}

if (isset($argv[1]) && $argv[1] === '--fetch-ca') {
    $result = download_ca_bundle();
    if ($result['ok']) {
        $msg = isset($result['unchanged']) && $result['unchanged']
            ? 'CA bundle unchanged: '
            : 'CA bundle saved: ';
        fwrite(STDOUT, $msg . ($result['path'] ?? ca_bundle_local_path()) . "\n");
        exit(0);
    }
    fwrite(STDERR, ($result['error'] ?? 'Download failed') . "\n");
    exit(1);
}

$entry = bridge_entry_script();
if ($entry === 'daemon.php' && !defined('MINIBEE_BRIDGE_ENTRY')) {
    $utility = isset($argv[1]) && in_array($argv[1], ['--check-ca', '--fetch-ca'], true);
    if (!$utility) {
        fwrite(STDERR, "daemon.php is internal — do not run it directly.\n");
        fwrite(STDERR, "Use start-minibee.bat (Windows) or run both:\n");
        fwrite(STDERR, "  php bridge/poll.php\n");
        fwrite(STDERR, "  php bridge/caps.php\n");
        exit(1);
    }
}
