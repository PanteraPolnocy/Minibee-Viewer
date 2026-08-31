// Ambient declarations for the browser globals the viewer relies on.
//
// The frontend files are scripts, not modules, so each one's `const BeeThing =
// (function () { ... })()` is already a global the checker can see - those need
// no declaration here. This file covers only what is attached to `window` from
// outside TypeScript's view: the Tauri IPC object injected by the runtime, and
// the few modules the UI reaches through `window.` to stay optional.

/**
 * The circuit/session fields a cap request carries alongside the URL, so the
 * core can pin the right simulator. Every field is optional: the shape is
 * assembled from whichever of the caller's options and the bridge's own
 * remembered context happen to be set.
 */
interface ProxyContext {
  sessionId?: string;
  udpListenPort?: number;
  simIp?: string;
  pinSimIp?: boolean;
  agentSessionId?: string;
  preCircuit?: boolean;
}

/** The IPC surface Tauri injects when `withGlobalTauri` is on. */
interface TauriGlobal {
  core?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<any>;
  };
  event?: {
    listen(event: string, handler: (e: { payload: any }) => void): Promise<() => void>;
  };
  opener?: {
    openUrl(url: string): Promise<void>;
  };
  [key: string]: any;
}

interface Window {
  /** Present only inside the Tauri webview; absent in a plain browser. */
  __TAURI__?: TauriGlobal;
  /** Set by serve-guard when loaded from file://, which the viewer refuses. */
  MINIBEE_BLOCKED?: boolean;

  // Reached through `window.` where the caller treats the module as optional
  // (load order means it may legitimately not be there yet).
  BeeApp?: typeof BeeApp;
  BeeContextMenu?: typeof BeeContextMenu;
  BeeInteract?: typeof BeeInteract;
  BeeLandmarks?: typeof BeeLandmarks;
  BeeMap?: typeof BeeMap;
  BeeNews?: typeof BeeNews;
  BeeScripts?: typeof BeeScripts;
}
