package com.pantera.minibee_viewer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Holds the process - and with it the native Second Life circuit - together
 * for the whole time the viewer is open, with a persistent notification.
 * Android freezes or kills a backgrounded process, and the sim disconnects an
 * idle circuit after ~a minute of no AgentUpdate/ping; a foreground service is
 * the one sanctioned way to opt out of that.
 *
 * Started from MainActivity.onCreate and re-asserted on resume/pause; stopped
 * when the activity actually finishes or the task is swiped away.
 *
 * startForeground() runs here in onCreate(), not only in onStartCommand():
 * onCreate always runs when the service comes up, so the promise made by
 * startForegroundService() is honored immediately. Promoting later left a
 * window where a quick stopService() (or a freeze of the just-backgrounded
 * process) beat it, and the system killed the app with
 * ForegroundServiceDidNotStartInTimeException.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        try {
            promote()
        } catch (_: Exception) {
            // Some OEMs or policies refuse the promotion; better to run as a
            // plain process than to crash.
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every startForegroundService() call must be answered; re-promoting an
        // already-foreground service just refreshes the notification.
        try {
            promote()
        } catch (_: Exception) {
            stopSelf()
        }
        // If the OS kills us anyway, don't auto-recreate - MainActivity starts
        // the service again on its next lifecycle step.
        return START_NOT_STICKY
    }

    // Android 15+ allows a dataSync service 6 hours of background time, then
    // calls this; not stopping within seconds is an ANR. Stop cleanly - the
    // next time the viewer comes to the front, MainActivity starts a fresh
    // service with a fresh allowance.
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // The task was swiped away from recents: the viewer is gone, take the
    // notification down with it instead of leaving it to linger.
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun promote() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // dataSync keeps the SL circuit alive; mediaPlayback lets voice
            // and parcel music keep sounding while backgrounded.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Connection",
                    NotificationManager.IMPORTANCE_LOW
                )
                channel.description = "Keeps Minibee connected to Second Life."
                channel.setShowBadge(false)
                mgr.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(): Notification {
        val tap = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Minibee-Viewer")
            .setContentText("Staying connected to Second Life")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(tap)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "minibee_connection"
        private const val NOTIFICATION_ID = 1001
    }
}
