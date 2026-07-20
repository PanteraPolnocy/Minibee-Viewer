<?php
/**
 * Minibee caps bridge - viewer UI, login, proxy, map (no UDP).
 * Default: http://127.0.0.1:8794
 */
declare(strict_types=1);

define('MINIBEE_BRIDGE_ENTRY', true);
define('MINIBEE_BRIDGE_ROLE', 'caps');
if (!defined('MINIBEE_BRIDGE_PORT')) {
    define('MINIBEE_BRIDGE_PORT', (int)(getenv('FS_BRIDGE_CAPS_PORT') ?: 8794));
}

require __DIR__ . '/daemon.php';

minibee_bridge_main();
