package com.pantera.minibee_viewer

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // The window insets as a CSS-variable assignment, kept so a late-loading
  // page can still receive them (see the retries in onWebViewCreate).
  private var safeAreaJs: String = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestNotificationPermission()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Parcel music streams are nearly always plain http:// Shoutcast/Icecast,
    // while the app itself is served over https - mixed content to Android.
    //
    // COMPATIBILITY_MODE is not enough: current WebView auto-upgrades mixed
    // audio to https and blocks it when the stream host has no TLS, which is
    // the norm for Shoutcast. ALWAYS_ALLOW is what actually lets it play. The
    // exposure stays small because the page itself is bundled - the audio
    // element is the only remote subresource the UI ever loads.
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

    // Edge-to-edge puts the page under the status and gesture bars, and
    // Android's WebView never fills CSS env(safe-area-inset-*). Hand the real
    // window insets to the page's --safe-* variables so the top bar clears
    // the clock and the bottom nav clears the gesture strip.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val d = resources.displayMetrics.density
      safeAreaJs = "var s=document.documentElement.style;" +
        "s.setProperty('--safe-top','${bars.top / d}px');" +
        "s.setProperty('--safe-bottom','${bars.bottom / d}px');" +
        "s.setProperty('--safe-left','${bars.left / d}px');" +
        "s.setProperty('--safe-right','${bars.right / d}px');"
      applySafeArea(webView)
      insets
    }
    // The first insets can land before the page exists; a few retries around
    // startup make sure the loaded document gets them too.
    for (delay in longArrayOf(500, 1500, 4000)) {
      webView.postDelayed({ applySafeArea(webView) }, delay)
    }
  }

  private fun applySafeArea(webView: WebView) {
    if (safeAreaJs.isNotEmpty()) {
      try {
        webView.evaluateJavascript(safeAreaJs, null)
      } catch (_: Exception) {
      }
    }
  }

  override fun onPause() {
    super.onPause()
    // Leaving the foreground: keep the process (and the native SL circuit) alive
    // so a quick app switch doesn't drop the session back to the login screen.
    try {
      ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java))
    } catch (_: Exception) {
      // Some OEMs restrict starting a foreground service from the background;
      // nothing else to do - the app behaves as before on those devices.
    }
  }

  override fun onResume() {
    super.onResume()
    // Back in the foreground: the WebView is driving again, drop the keep-alive.
    try {
      stopService(Intent(this, ConnectionService::class.java))
    } catch (_: Exception) {
    }
  }

  private fun requestNotificationPermission() {
    // The foreground service needs a visible notification; Android 13+ gates it
    // behind a runtime grant. If denied, the service still runs (notification is
    // just suppressed), so this is best-effort.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val granted = ContextCompat.checkSelfPermission(
        this, android.Manifest.permission.POST_NOTIFICATIONS
      ) == PackageManager.PERMISSION_GRANTED
      if (!granted) {
        ActivityCompat.requestPermissions(
          this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1
        )
      }
    }
  }
}
