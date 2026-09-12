package com.pantera.minibee_viewer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder

/**
 * Holds the process - and with it the native Second Life circuit - together
 * for the whole time the viewer is open, with a persistent notification.
 * Android freezes or kills a backgrounded process, and the sim disconnects an
 * idle circuit after ~a minute of no AgentUpdate/ping; a foreground service is
 * the one sanctioned way to opt out of that.
 *
 * The notification is also the viewer's face while backgrounded: it shows the
 * unread-IM count (and the newest message when expanded) and carries buttons
 * for parcel music and the microphone. The page reports that state through the
 * MinibeeAndroid interface (see MainActivity); button taps land back in the
 * page as BeeAndroidBridge.action(...) calls.
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
        running = true
        try {
            promote()
        } catch (_: Exception) {
            // Some OEMs or policies refuse the promotion; better to run as a
            // plain process than to crash.
            stopSelf()
        }
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_MUSIC -> MainActivity.runJs(
                "window.BeeAndroidBridge && BeeAndroidBridge.action('music');"
            )
            ACTION_VOICE -> MainActivity.runJs(
                "window.BeeAndroidBridge && BeeAndroidBridge.action('voice');"
            )
        }
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
        val notification = build(this)
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

    companion object {
        private const val CHANNEL_ID = "minibee_connection"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_MUSIC = "com.pantera.minibee_viewer.MUSIC_TOGGLE"
        private const val ACTION_VOICE = "com.pantera.minibee_viewer.VOICE_TOGGLE"

        @Volatile private var running = false

        // What the page last reported (through MinibeeAndroid.updateState);
        // this is display state only, drawn into the notification.
        @Volatile var musicAvailable = false
        @Volatile var musicPlaying = false
        @Volatile var voiceConnected = false
        @Volatile var voiceMuted = true
        @Volatile var unreadIms = 0
        @Volatile var lastMessage = ""

        // Repaint the notification with the current state. A no-op unless the
        // service is up - notify() on a dead foreground service would plant a
        // stray, unowned notification.
        fun refresh(context: Context) {
            if (!running) return
            try {
                val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                mgr.notify(NOTIFICATION_ID, build(context))
            } catch (_: Exception) {
            }
        }

        private fun servicePending(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, ConnectionService::class.java).setAction(action)
            return PendingIntent.getService(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        private fun build(context: Context): Notification {
            val tap = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE
            )
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val text = when {
                unreadIms == 1 -> "1 unread IM"
                unreadIms > 1 -> "$unreadIms unread IMs"
                else -> "Staying connected to Second Life"
            }
            builder
                .setContentTitle("Minibee-Viewer")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
            if (unreadIms > 0 && lastMessage.isNotEmpty()) {
                builder.setStyle(Notification.BigTextStyle().bigText(lastMessage))
            }
            if (musicAvailable) {
                builder.addAction(
                    Notification.Action.Builder(
                        Icon.createWithResource(
                            context,
                            if (musicPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
                        ),
                        if (musicPlaying) "Stop music" else "Play music",
                        servicePending(context, ACTION_MUSIC, 1)
                    ).build()
                )
            }
            if (voiceConnected) {
                builder.addAction(
                    Notification.Action.Builder(
                        Icon.createWithResource(context, android.R.drawable.ic_btn_speak_now),
                        if (voiceMuted) "Unmute mic" else "Mute mic",
                        servicePending(context, ACTION_VOICE, 2)
                    ).build()
                )
            }
            return builder.build()
        }
    }
}
