package com.pantera.minibee_viewer

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestNotificationPermission()
  }

  override fun onPause() {
    super.onPause()
    // Leaving the foreground: keep the process (and the native SL circuit) alive
    // so a quick app switch doesn't drop the session back to the login screen.
    try {
      ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java))
    } catch (_: Exception) {
      // Some OEMs restrict starting a foreground service from the background;
      // nothing else to do — the app behaves as before on those devices.
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
