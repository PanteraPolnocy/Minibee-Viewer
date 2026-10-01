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
 * A second, ordinary notification (id 1002, channel "Messages") alerts about
 * a new IM while MainActivity is not on screen - the one sound that reliably
 * reaches a phone with the screen off, where the page's own ding may not. It
 * does not depend on the service being up, fires once per alert-worthy IM
 * the page counts (imAlerts, see android-bridge.ts), and comes down when the
 * activity starts. The keep-alive notification itself never alerts.
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
 * Service types: holding a live game-server session is none of the predefined
 * foreground types, so the base type is specialUse (declared in the manifest
 * with the use case spelled out in its property; no time limit, unlike the
 * dataSync type's six hours on Android 15+). mediaPlayback rides along only
 * while parcel music or voice is actually sounding, and the microphone type
 * only while voice is on - the set held is exactly what is in use, which is
 * what the store's declaration describes.
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
 * when the page's state flips a type decision (voice, music), and any refusal
 * falls back to the previous type set instead of crashing. Adding or dropping
 * mediaPlayback is allowed from the background (it is not a while-in-use
 * type), so music started from the notification button gets it too.
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

    // None of the types held here is time-limited (specialUse, mediaPlayback,
    // microphone), so this should never fire; if a future Android version
    // does limit one, not stopping within seconds is an ANR. Stop cleanly -
    // the next time the viewer comes to the front, MainActivity starts a
    // fresh service.
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
        // Explicit on every API 29+ call, so the manifest's microphone entry
        // never gets pulled in implicitly (the two-argument form would use
        // the whole declared set).
        val types = desiredTypes()
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

    // The type set this promotion should hold: specialUse always (the live
    // session), mediaPlayback while parcel music or voice is sounding, the
    // microphone type under wantMicrophoneType()'s rules. Main thread only.
    private fun desiredTypes(): Int {
        var types = BASE_TYPES
        if (mediaWanted()) types = types or MEDIA_TYPE
        if (wantMicrophoneType()) types = types or MICROPHONE_TYPE
        return types
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

    // The page's voice or music state changed: add or drop the media and
    // microphone types when the decision flips (startForeground repaints
    // too), otherwise just repaint the notification - directly, not through
    // refresh(), which would post back here for as long as voice is on
    // without the microphone type (permission not granted, app in the
    // background). Main thread.
    private fun syncTypes() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && promotedTypes != 0) {
            val types = desiredTypes()
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
        ensureMessagesChannel(this)
    }

    companion object {
        private const val CHANNEL_ID = "minibee_connection"
        private const val NOTIFICATION_ID = 1001
        private const val MESSAGES_CHANNEL_ID = "minibee_messages"
        private const val IM_NOTIFICATION_ID = 1002
        private const val ACTION_MUSIC = "com.pantera.minibee_viewer.MUSIC_TOGGLE"
        private const val ACTION_VOICE = "com.pantera.minibee_viewer.VOICE_TOGGLE"

        // Compile-time constants (inlined), so naming them below the API
        // level that introduced them is safe. The system only checks that a
        // promotion's types are a subset of the manifest's declared set,
        // which lists all three; wantMicrophoneType() keeps the microphone
        // type out below API 30, and specialUse is just a declared bit to
        // versions before API 34.
        private const val BASE_TYPES = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        private const val MEDIA_TYPE = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        private const val MICROPHONE_TYPE = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE

        // Whether something is sounding that the media type should cover.
        // Any thread (plain volatile reads).
        private fun mediaWanted(): Boolean = musicPlaying || voiceConnected

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
        // The page's running count of IMs worth an alert and the newest one
        // as "Name: text" (android-bridge.ts); the message notification fires
        // once per step of the counter, tracked in alertedIms.
        @Volatile var imAlerts = 0
        @Volatile var imAlertText = ""
        @Volatile private var alertedIms = 0
        // Whether MainActivity is started (between onStart and onStop): the
        // page's own ding covers a visible viewer, the message notification a
        // hidden one (screen off, another app in front).
        @Volatile var activityVisible = false

        // Repaint the notification with the current state. A no-op unless the
        // service is up - notify() on a dead foreground service would plant a
        // stray, unowned notification.
        fun refresh(context: Context) {
            // The message alert does not depend on the service: a refused
            // promotion must not silence IMs.
            maybeAlertIm(context)
            if (!running) return
            // Voice or music came or went relative to the promoted types: the
            // service decides about the media and microphone types on the main
            // thread (this runs on a WebView worker thread) and repaints from
            // there.
            val svc = instance
            val held = promotedTypes
            if (svc != null && held != 0 &&
                (mediaWanted() != (held and MEDIA_TYPE != 0) ||
                    voiceConnected != (held and MICROPHONE_TYPE != 0))
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

        // A new IM the page wants a sound for (imAlerts stepped): alert through
        // the message notification while the activity is off screen - the
        // page's own ding covers a visible viewer. Once per step, so a repaint
        // for any other reason (music, voice) never re-alerts. Any thread.
        private fun maybeAlertIm(context: Context) {
            try {
                val count = imAlerts
                if (count > alertedIms) {
                    alertedIms = count
                    if (!activityVisible && imAlertText.isNotEmpty()) {
                        notifyIm(context, imAlertText)
                        return
                    }
                } else if (count < alertedIms) {
                    // The page started over (logout, reload): follow its count.
                    alertedIms = count
                }
                // Nothing alert-worthy left on the page (a reset, a fresh
                // session): a stale alert comes down with it. Catching up in
                // the viewer is covered by clearImAlert from onStart.
                if (unreadIms == 0 && imAlertText.isEmpty()) cancelIm(context)
            } catch (_: Exception) {
            }
        }

        private fun notifyIm(context: Context, text: String) {
            ensureMessagesChannel(context)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, MESSAGES_CHANNEL_ID)
            } else {
                // No channels before API 26: the sound is asked for per
                // notification instead.
                @Suppress("DEPRECATION")
                Notification.Builder(context).setDefaults(Notification.DEFAULT_SOUND)
            }
            builder
                .setContentTitle("New IM")
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(activityPending(context))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            mgr.notify(IM_NOTIFICATION_ID, builder.build())
        }

        private fun cancelIm(context: Context) {
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            mgr.cancel(IM_NOTIFICATION_ID)
        }

        // The viewer is back on screen: whatever the alert was about is in
        // front of the user now. From MainActivity.onStart.
        fun clearImAlert(context: Context) {
            try {
                cancelIm(context)
            } catch (_: Exception) {
            }
        }

        // The "Messages" channel: default importance, so the system's own
        // notification sound plays (the user can retune it in the app's
        // notification settings). Created by the service and again, cheaply,
        // before every alert, since an alert may come before or without the
        // service.
        private fun ensureMessagesChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(MESSAGES_CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                MESSAGES_CHANNEL_ID,
                "Messages",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            channel.description = "New instant messages while Minibee is not on screen."
            channel.setShowBadge(true)
            mgr.createNotificationChannel(channel)
        }

        // Tapping either notification brings the viewer to the front.
        private fun activityPending(context: Context): PendingIntent =
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE
            )

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
            val tap = activityPending(context)
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
