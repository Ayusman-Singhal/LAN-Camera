package com.lancamera.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import org.json.JSONObject

/**
 * Foreground service that owns the camera, microphone and PC connection.
 *
 * Started from the app screen (Android requires that for camera access), it
 * then keeps running with the phone locked and the screen off. A notification
 * shows while it runs, with a Stop button.
 *
 * The PC decides everything: when to stream (viewer open or recording),
 * camera, resolution, quality, mic and torch.
 */
class CameraService : LifecycleService(), ServerConnection.Listener, VideoStreamer.Listener {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var video: VideoStreamer
    private val audio = AudioStreamer { packet, config -> sendMedia(packet, key = true, config = config) }

    private var pairing: Pairing? = null
    private var conn: ServerConnection? = null
    private var settings = StreamSettings()
    private var streaming = false
    private var cameraOpen = false
    private var cameraError: String? = null
    private var torchAvailable = false
    private var streamInfo: Triple<Int, Int, Int>? = null
    private var retryDelayMs = 2000L
    private var stopping = false
    private var started = false
    private var notifWanted = false // PC switch for phone notifications

    // Written from encoder threads.
    @Volatile private var needKey = false
    @Volatile private var lastKeyRequest = 0L

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        settings = StreamSettings.load(this)
        video = VideoStreamer(this, this, this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) {
            shutdown("Stopped")
        } else {
            begin()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (!stopping) shutdown("Stopped")
        video.release()
        super.onDestroy()
    }

    // ------------------------------------------------------------ lifecycle

    private fun begin() {
        if (started) return
        val p = PairingStore.load(this)
        if (p == null) {
            AppState.set { it.copy(running = false, kind = StatusKind.ERROR, status = "Not paired", detail = "Scan the QR code on the PC first.") }
            stopSelf()
            return
        }
        started = true
        pairing = p
        goForeground("Connecting to PC…")
        acquireLocks()
        setUi(StatusKind.CONNECTING, "Connecting…", "Looking for your PC at ${p.label}.")
        connect()
        main.postDelayed(statusTick, STATUS_INTERVAL_MS)
    }

    private fun shutdown(reason: String) {
        stopping = true
        main.removeCallbacksAndMessages(null)
        NotificationHub.setSink(null)
        conn?.close()
        conn = null
        setStreaming(false)
        releaseLocks()
        val normal = reason == "Stopped"
        AppState.set {
            it.copy(
                running = false,
                kind = if (normal) StatusKind.STOPPED else StatusKind.ERROR,
                status = "Stopped",
                detail = if (normal) "Tap Start to stream to your PC." else reason,
            )
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun connect() {
        val p = pairing ?: return
        conn = ServerConnection(p, this).also { it.connect() }
    }

    private val statusTick = object : Runnable {
        override fun run() {
            sendStatus()
            main.postDelayed(this, STATUS_INTERVAL_MS)
        }
    }

    // --------------------------------------------------- connection events

    override fun onAuthed(newKey: String?, caFingerprint: String?) {
        main.post {
            val p = pairing ?: return@post
            retryDelayMs = 2000L
            // After a typed code the PC gives us the long key and its CA
            // fingerprint: keep them for reconnects.
            val updated = p.copy(
                method = if (newKey != null) "key" else p.method,
                secret = newKey ?: p.secret,
                caFingerprint = p.caFingerprint ?: caFingerprint?.lowercase()?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) },
            )
            if (updated != p) {
                pairing = updated
                PairingStore.save(this, updated)
            }
            if (streaming) setUi(StatusKind.STREAMING, "Streaming", STREAMING_DETAIL)
            else setUi(StatusKind.IDLE, "Connected", IDLE_DETAIL)
            sendStatus()
            if (streaming) {
                video.resendConfig()
                audio.resendConfig()
                video.requestKeyframe()
            }
        }
    }

    override fun onServerMessage(msg: JSONObject) {
        main.post {
            when (msg.optString("type")) {
                "stream" -> setStreaming(msg.optBoolean("value"))
                "keyframe" -> video.requestKeyframe()
                "notifications" -> {
                    notifWanted = msg.optBoolean("value")
                    updateNotifSink()
                }
                "settings" -> msg.optJSONObject("data")?.let { applySettings(it) }
            }
        }
    }

    override fun onDisconnected(reason: String, retry: Boolean, forgetPairing: Boolean) {
        main.post {
            NotificationHub.setSink(null)
            conn?.close()
            conn = null
            setStreaming(false)
            if (forgetPairing) PairingStore.clear(this)
            if (stopping) return@post
            if (retry) {
                setUi(StatusKind.CONNECTING, "Looking for PC…", "$reason Retrying.")
                updateNotification("Waiting for PC…")
                main.postDelayed({ if (!stopping && conn == null) connect() }, retryDelayMs)
                retryDelayMs = (retryDelayMs * 2).coerceAtMost(15_000L)
            } else {
                shutdown(reason)
            }
        }
    }

    /** Send phone notifications to the PC while connected and the PC wants them. */
    private fun updateNotifSink() {
        if (notifWanted && conn?.authed == true) {
            NotificationHub.setSink { json -> conn?.sendText(json) }
        } else {
            NotificationHub.setSink(null)
        }
    }

    // ------------------------------------------------------------- media

    private fun setStreaming(on: Boolean) {
        if (on == streaming) return
        streaming = on
        if (on) {
            needKey = false
            cameraError = null
            video.start(settings)
            if (settings.audio && micGranted()) audio.start()
            setUi(StatusKind.STREAMING, "Streaming", STREAMING_DETAIL)
            updateNotification("Streaming to PC")
        } else {
            video.stop()
            audio.stop()
            cameraOpen = false
            if (conn?.authed == true) {
                setUi(StatusKind.IDLE, "Connected", IDLE_DETAIL)
                updateNotification("Connected, camera idle")
            }
        }
        sendStatus()
    }

    private fun applySettings(j: JSONObject) {
        val old = settings
        val s = old.merge(j)
        if (s == old) return
        settings = s
        StreamSettings.save(this, s)
        if (streaming) {
            if (s.facing != old.facing || s.res != old.res || s.fps != old.fps || s.orientation != old.orientation) {
                video.restart(s)
            } else {
                if (s.bitrate != old.bitrate) video.setBitrate(s.bitrate)
                if (s.torch != old.torch) video.setTorch(s.torch)
            }
            if (s.audio != old.audio) {
                if (s.audio && micGranted()) audio.start() else audio.stop()
                sendStreamInfo()
            }
        }
        sendStatus()
    }

    /** Called from encoder threads. Drops frames when Wi-Fi cannot keep up. */
    private fun sendMedia(packet: ByteArray, key: Boolean, config: Boolean) {
        val c = conn ?: return
        val isVideo = Packets.isVideo(packet)
        if (!config) {
            if (c.queuedBytes() > MAX_QUEUE_BYTES) {
                if (isVideo) {
                    needKey = true
                    maybeRequestKey()
                }
                return
            }
            if (isVideo && needKey) {
                if (!key) {
                    maybeRequestKey()
                    return
                }
                needKey = false
            }
        }
        c.sendBinary(packet)
    }

    private fun maybeRequestKey() {
        val now = System.currentTimeMillis()
        if (now - lastKeyRequest > 500) {
            lastKeyRequest = now
            video.requestKeyframe()
        }
    }

    override fun onVideoPacket(packet: ByteArray, key: Boolean, config: Boolean) = sendMedia(packet, key, config)

    override fun onStreamInfo(width: Int, height: Int, rotation: Int) {
        main.post {
            streamInfo = Triple(width, height, rotation)
            sendStreamInfo()
        }
    }

    override fun onCameraState(open: Boolean, error: String?) {
        main.post {
            cameraOpen = open
            cameraError = error
            if (error != null) setUi(StatusKind.ERROR, "Camera problem", error)
            else if (open && streaming) setUi(StatusKind.STREAMING, "Streaming", STREAMING_DETAIL)
            sendStatus()
        }
    }

    override fun onTorchAvailable(available: Boolean) {
        main.post {
            torchAvailable = available
            sendStatus()
        }
    }

    private fun sendStreamInfo() {
        val (w, h, r) = streamInfo ?: return
        conn?.sendText(
            JSONObject()
                .put("type", "stream-info")
                .put("width", w)
                .put("height", h)
                .put("rotation", r)
                .put("fps", settings.fps)
                .put("audio", settings.audio && micGranted())
        )
    }

    private fun sendStatus() {
        val c = conn ?: return
        val state = when {
            !streaming -> "idle"
            cameraError != null -> "paused"
            else -> "live"
        }
        val msg = JSONObject()
            .put("type", "status")
            .put("state", state)
            .put("caps", JSONObject().put("torch", torchAvailable))
            .put("notifAccess", NotificationHub.hasAccess(this))
            .put("settings", settings.toJson().put("audio", settings.audio && micGranted()))
        battery()?.let { (level, charging) -> msg.put("battery", level).put("charging", charging) }
        c.sendText(msg)
    }

    private fun battery(): Pair<Int, Boolean>? {
        val i = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return (level * 100 / scale) to charging
    }

    private fun micGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    // ---------------------------------------------------------- system bits

    private fun setUi(kind: StatusKind, status: String, detail: String) {
        AppState.set { it.copy(running = true, kind = kind, status = status, detail = detail) }
    }

    /** Keep CPU and Wi-Fi awake while the screen is off. */
    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LanCamera:stream").apply {
            setReferenceCounted(false)
            acquire()
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "LanCamera:wifi").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    private fun goForeground(text: String) {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (micGranted()) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(text), type)
    }

    private fun updateNotification(text: String) {
        if (stopping) return
        val nm = NotificationManagerCompat.from(this)
        if (nm.areNotificationsEnabled()) {
            try {
                nm.notify(NOTIFICATION_ID, buildNotification(text))
            } catch (_: SecurityException) {
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, CameraService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("LAN Camera")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Camera streaming", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the camera is streaming to your PC"
            }
        )
    }

    companion object {
        private const val ACTION_START = "com.lancamera.app.START"
        private const val ACTION_STOP = "com.lancamera.app.STOP"
        private const val CHANNEL_ID = "stream"
        private const val NOTIFICATION_ID = 1
        private const val STATUS_INTERVAL_MS = 30_000L
        private const val MAX_QUEUE_BYTES = 3L * 1024 * 1024
        private const val STREAMING_DETAIL = "Camera is on and sending to your PC."
        private const val IDLE_DETAIL = "Camera is off. It turns on when the PC viewer is open or recording."


        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, CameraService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, CameraService::class.java).setAction(ACTION_STOP))
        }
    }
}
