<?php
/**
 * Start poll + caps in one terminal (single window).
 * Poll runs as a background child; caps runs in the foreground.
 * Ctrl+C or caps exit stops both.
 *
 * Usage: php bridge/run.php
 *        start-minibee.bat (Windows; sets MINIBEE_OPEN_BROWSER=1)
 */
declare(strict_types=1);

function bridge_php_binary(): string
{
    return defined('PHP_BINARY') ? PHP_BINARY : 'php';
}

function bridge_kill_port_listeners(int $port): void
{
    if (PHP_OS_FAMILY !== 'Windows') {
        return;
    }
    $out = [];
    @exec('netstat -ano | findstr /R /C:":' . $port . ' .*LISTENING"', $out);
    foreach ($out as $line) {
        if (!preg_match('/\s(\d+)\s*$/', trim($line), $m)) {
            continue;
        }
        @exec('taskkill /F /PID ' . $m[1] . ' 2>NUL');
    }
}

function bridge_null_device(): string
{
    return PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
}

function bridge_caps_port(): int
{
    $fromEnv = getenv('FS_BRIDGE_CAPS_PORT');
    if ($fromEnv !== false && $fromEnv !== '') {
        return (int)$fromEnv;
    }
    return 8794;
}

function bridge_poll_port(): int
{
    $fromEnv = getenv('FS_BRIDGE_POLL_PORT');
    if ($fromEnv !== false && $fromEnv !== '') {
        return (int)$fromEnv;
    }
    return 8795;
}

/** Open the viewer URL once the caps bridge responds (start-minibee.bat sets MINIBEE_OPEN_BROWSER=1). */
function bridge_open_browser_when_ready(int $port): void
{
    if (getenv('MINIBEE_OPEN_BROWSER') !== '1') {
        return;
    }
    $url = 'http://127.0.0.1:' . $port . '/';
    $null = bridge_null_device();
    $spec = [
        0 => ['file', $null, 'r'],
        1 => ['file', $null, 'w'],
        2 => ['file', $null, 'w'],
    ];
    $opts = PHP_OS_FAMILY === 'Windows' ? ['bypass_shell' => true] : [];

    if (PHP_OS_FAMILY === 'Windows') {
        $ps = '$u=\'' . $url . '\';'
            . 'for($i=0;$i -lt 120;$i++){'
            . 'try{$r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1;'
            . 'if($r.StatusCode -eq 200){Start-Process $u;exit 0}}catch{};'
            . 'Start-Sleep -Milliseconds 500}';
        proc_open(['powershell', '-NoProfile', '-Command', $ps], $spec, $pipes, null, null, $opts);
        return;
    }
    if (PHP_OS_FAMILY === 'Darwin') {
        proc_open('sh -c ' . escapeshellarg('sleep 2; open ' . $url), $spec, $pipes, null, null, $opts);
        return;
    }
    proc_open('sh -c ' . escapeshellarg('sleep 2; xdg-open ' . $url . ' 2>/dev/null'), $spec, $pipes, null, null, $opts);
}

/** @param resource|object|false $process */
function bridge_process_active($process): bool
{
    if ($process === false) {
        return false;
    }
    return is_resource($process) || is_object($process);
}

/** @param resource|object $process */
function bridge_process_stop($process): void
{
    if (!bridge_process_active($process)) {
        return;
    }
    proc_terminate($process, 15);
    proc_close($process);
}

$bridgeDir = __DIR__;
$php = bridge_php_binary();

$capsPort = bridge_caps_port();
$pollPort = bridge_poll_port();
bridge_kill_port_listeners($capsPort);
bridge_kill_port_listeners($pollPort);

$null = bridge_null_device();
$pollSpec = [
    0 => ['file', $null, 'r'],
    1 => ['file', $null, 'w'],
    2 => ['file', $null, 'w'],
];
$pollOpts = PHP_OS_FAMILY === 'Windows' ? ['bypass_shell' => true] : [];
$poll = proc_open([$php, $bridgeDir . '/poll.php'], $pollSpec, $pollPipes, $bridgeDir, null, $pollOpts);

if (!bridge_process_active($poll)) {
    fwrite(STDERR, "Failed to start poll bridge.\n");
    exit(1);
}

$stopPoll = static function () use (&$poll): void {
    if (!bridge_process_active($poll)) {
        return;
    }
    bridge_process_stop($poll);
    $poll = null;
};

register_shutdown_function(static function () use ($stopPoll): void {
    $stopPoll();
});

if (function_exists('pcntl_async_signals') && function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGINT, static function () use ($stopPoll): void {
        $stopPoll();
        exit(130);
    });
    pcntl_signal(SIGTERM, static function () use ($stopPoll): void {
        $stopPoll();
        exit(143);
    });
}

usleep(600000);

bridge_open_browser_when_ready($capsPort);

fwrite(STDOUT, "Poll bridge: http://127.0.0.1:{$pollPort} (background)\n");
fwrite(STDOUT, "Caps bridge: http://127.0.0.1:{$capsPort} (foreground)\n\n");

$capsCode = 0;
passthru(escapeshellarg($php) . ' ' . escapeshellarg($bridgeDir . '/caps.php'), $capsCode);

$stopPoll();
bridge_kill_port_listeners($pollPort);

exit($capsCode);
