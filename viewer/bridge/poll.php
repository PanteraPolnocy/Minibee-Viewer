<?php
/**
 * Minibee poll bridge - UDP circuit relay only (no caps / proxy).
 * Default: http://127.0.0.1:8795
 */
declare(strict_types=1);

define('MINIBEE_BRIDGE_ENTRY', true);
define('MINIBEE_BRIDGE_ROLE', 'poll');
if (!defined('MINIBEE_BRIDGE_PORT')) {
    define('MINIBEE_BRIDGE_PORT', (int)(getenv('FS_BRIDGE_POLL_PORT') ?: 8795));
}

require __DIR__ . '/daemon.php';

minibee_bridge_main();
