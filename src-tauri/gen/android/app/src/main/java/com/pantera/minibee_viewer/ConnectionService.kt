package com.pantera.minibee_viewer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

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
 *
 * Microphone: since Android 11 a backgrounded app may keep capturing audio
 * only through a foreground service of type microphone, so voice would go
 * silent the moment the viewer left the screen. The type is not declared
 * statically on every promotion, though: it would need RECORD_AUDIO to be
 * granted at each startForeground() (a SecurityException otherwise), and on
 * API 34+ a microphone-type promotion made while the app is in the background
 * throws ForegroundServiceStartNotAllowedException (while-in-use rule). So
 * promote() adds the type only when voice is connected, RECORD_AUDIO is
 * granted, and either the app is in the foreground or the service is already
 * running with the type (keeping it is always allowed); refresh() re-promotes
 * when the page's voice state flips that decision, and any refusal falls back
 * to the previous type set instead of crashing.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        running = true
        instance = this
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
        if (instance === this) instance = null
        promotedTypes = 0
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // No per-call types before API 29 (the manifest attribute is
            // ignored there too).
            startForeground(NOTIFICATION_ID, notification)
            return
        }
        // dataSync keeps the SL circuit alive; mediaPlayback lets voice and
        // parcel music keep sounding while backgrounded. Explicit on every
        // API 29+ call, so the manifest's microphone entry never gets pulled
        // in implicitly (the two-argument form would use the whole declared set).
        val types = if (wantMicrophoneType()) BASE_TYPES or MICROPHONE_TYPE else BASE_TYPES
        try {
            startForeground(NOTIFICATION_ID, notification, types)
            promotedTypes = types
        } catch (e: Exception) {
            // A refused microphone type (SecurityException, or the API 34
            // ForegroundServiceStartNotAllowedException for a background
            // while-in-use promotion) must never take the whole service down:
            // fall back to the set held before, minus anything this call was
            // dropping. Only a failure of the base set itself reaches the
            // caller, which stops the service as before.
            val fallback = if (promotedTypes != 0) promotedTypes and types else BASE_TYPES
            if (fallback == types) throw e
            startForeground(NOTIFICATION_ID, notification, fallback)
            promotedTypes = fallback
        }
    }

    // Whether this promotion may carry the microphone type. Main thread only
    // (reads the process lifecycle).
    private fun wantMicrophoneType(): Boolean {
        // The constant itself exists from API 30.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        if (!voiceConnected) return false
        val granted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) return false
        // Already promoted with it: keeping a while-in-use type through the
        // background is allowed, only adding one is not.
        if (promotedTypes and MICROPHONE_TYPE != 0) return true
        // Adding it needs the app in the foreground (a started activity); API
        // 34 throws otherwise, and API 30-33 would grant the type but deny the
        // capture. Left out for now, the next promote() from onResume ->
        // startKeepAlive -> onStartCommand picks it up.
        return ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    }

    // The page's voice state changed: add or drop the microphone type when the
    // decision flips (startForeground repaints too), otherwise just repaint
    // the notification - directly, not through refresh(), which would post
    // back here for as long as voice is on without the type (permission not
    // granted, app in the background). Main thread.
    private fun syncTypes() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && promotedTypes != 0) {
            val types = if (wantMicrophoneType()) BASE_TYPES or MICROPHONE_TYPE else BASE_TYPES
            if (types != promotedTypes) {
                try {
                    promote()
                } catch (_: Exception) {
                    // The earlier promotion still stands; nothing to undo.
                }
                return
            }
        }
        repaint(this)
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

        private const val BASE_TYPES =
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        // Compile-time constant (inlined), so naming it below API 30 is safe;
        // wantMicrophoneType() never lets it through there.
        private const val MICROPHONE_TYPE = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE

        @Volatile private var running = false
        // The live service, for refresh() to re-promote through. Cleared in
        // onDestroy so a dead instance is never called.
        @Volatile private var instance: ConnectionService? = null
        // The type set of the last successful startForeground() on API 29+
        // (0 before the first one): tells whether the microphone type is
        // currently held, and is the fallback when a re-promotion is refused.
        @Volatile private var promotedTypes = 0

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
            // Voice came or went relative to the promoted types: the service
            // decides about the microphone type on the main thread (this runs
            // on a WebView worker thread) and repaints from there.
            val svc = instance
            if (svc != null && promotedTypes != 0 &&
                voiceConnected != (promotedTypes and MICROPHONE_TYPE != 0)
            ) {
                Handler(Looper.getMainLooper()).post { if (running) svc.syncTypes() }
                return
            }
            repaint(context)
        }

        private fun repaint(context: Context) {
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
