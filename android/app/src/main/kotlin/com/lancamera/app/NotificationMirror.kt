package com.lancamera.app

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Reads the phone's notifications so the PC viewer can show them.
 *
 * Android only runs this after you grant "Notification access" to LAN Camera
 * in system settings. Notifications are only sent while the app is started
 * and connected to your PC, and only if the PC switch is on.
 */
class NotificationMirror : NotificationListenerService() {
    override fun onListenerConnected() = NotificationHub.attach(this)
    override fun onListenerDisconnected() = NotificationHub.detach(this)
    override fun onNotificationPosted(sbn: StatusBarNotification) = NotificationHub.posted(this, sbn)
    override fun onNotificationRemoved(sbn: StatusBarNotification) = NotificationHub.removed(sbn)

    fun current(): Array<StatusBarNotification> = runCatching { activeNotifications }.getOrNull() ?: emptyArray()
}

/** Glue between [NotificationMirror] (started by Android) and [CameraService] (the PC connection). */
object NotificationHub {
    private const val MAX_ITEMS = 200
    private val main = Handler(Looper.getMainLooper())

    // Main thread only.
    private var listener: NotificationMirror? = null
    private var sink: ((JSONObject) -> Unit)? = null
    private val lastSent = HashMap<String, Int>() // key -> content hash: skip repeats
    private val iconsSent = HashSet<String>()

    fun hasAccess(ctx: Context) = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)

    fun component(ctx: Context) = ComponentName(ctx, NotificationMirror::class.java)

    fun attach(l: NotificationMirror) {
        main.post {
            listener = l
            if (sink != null) sendSnapshot()
        }
    }

    fun detach(l: NotificationMirror) {
        main.post {
            if (listener === l) listener = null
        }
    }

    /** CameraService: start sending to the PC ([s] != null) or stop (null). */
    fun setSink(s: ((JSONObject) -> Unit)?) {
        main.post {
            sink = s
            lastSent.clear()
            iconsSent.clear()
            if (s != null) sendSnapshot()
        }
    }

    fun posted(ctx: Context, sbn: StatusBarNotification) {
        main.post {
            val s = sink ?: return@post
            val json = toJson(ctx, sbn) ?: return@post
            val hash = json.toString().hashCode()
            if (lastSent[sbn.key] == hash) return@post // e.g. progress bar ticking
            lastSent[sbn.key] = hash
            sendIcon(ctx, sbn, s)
            s(JSONObject().put("type", "notif-posted").put("n", json))
        }
    }

    fun removed(sbn: StatusBarNotification) {
        main.post {
            val s = sink ?: return@post
            if (lastSent.remove(sbn.key) != null) s(JSONObject().put("type", "notif-removed").put("key", sbn.key))
        }
    }

    private fun sendSnapshot() {
        val s = sink ?: return
        val l = listener
        val items = JSONArray()
        if (l != null) {
            for (sbn in l.current().sortedByDescending { it.postTime }) {
                if (items.length() >= MAX_ITEMS) break
                val json = toJson(l, sbn) ?: continue
                lastSent[sbn.key] = json.toString().hashCode()
                sendIcon(l, sbn, s)
                items.put(json)
            }
        }
        s(JSONObject().put("type", "notif-list").put("items", items))
    }

    private fun appInfo(ctx: Context, sbn: StatusBarNotification): ApplicationInfo? {
        // Android puts the posting app's info into the notification itself.
        val fromExtras = if (Build.VERSION.SDK_INT >= 33) {
            sbn.notification.extras.getParcelable("android.appInfo", ApplicationInfo::class.java)
        } else {
            @Suppress("DEPRECATION")
            sbn.notification.extras.getParcelable("android.appInfo")
        }
        return fromExtras ?: runCatching { ctx.packageManager.getApplicationInfo(sbn.packageName, 0) }.getOrNull()
    }

    private fun toJson(ctx: Context, sbn: StatusBarNotification): JSONObject? {
        if (sbn.packageName == ctx.packageName) return null // our own "streaming" notice
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null // "3 new messages" duplicates
        val e = n.extras
        val title = (e.getCharSequence(Notification.EXTRA_TITLE_BIG) ?: e.getCharSequence(Notification.EXTRA_TITLE))
            ?.toString()?.trim().orEmpty()
        var text = (e.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: e.getCharSequence(Notification.EXTRA_TEXT))
            ?.toString()?.trim().orEmpty()
        e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.takeIf { it.isNotEmpty() }?.let { lines ->
            text = lines.joinToString("\n") { it.toString() }
        }
        // Chat apps: show the last few messages with sender names.
        runCatching { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n) }.getOrNull()
            ?.messages?.takeIf { it.isNotEmpty() }?.let { msgs ->
                text = msgs.takeLast(6).joinToString("\n") { m ->
                    listOfNotNull(m.person?.name?.toString(), m.text?.toString()).joinToString(": ")
                }
            }
        if (title.isEmpty() && text.isEmpty()) return null
        val info = appInfo(ctx, sbn)
        val label = info?.let { runCatching { ctx.packageManager.getApplicationLabel(it).toString() }.getOrNull() }
        return JSONObject()
            .put("key", sbn.key)
            .put("pkg", sbn.packageName)
            .put("app", label ?: sbn.packageName)
            .put("title", title.take(300))
            .put("text", text.take(3000))
            .put("sub", e.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.take(200) ?: "")
            .put("time", sbn.postTime)
            .put("ongoing", sbn.isOngoing)
    }

    /** App icon as a small PNG, once per app per connection. */
    private fun sendIcon(ctx: Context, sbn: StatusBarNotification, s: (JSONObject) -> Unit) {
        val pkg = sbn.packageName
        if (!iconsSent.add(pkg)) return
        val info = appInfo(ctx, sbn) ?: return
        val png = runCatching {
            val drawable = ctx.packageManager.getApplicationIcon(info)
            val size = 64
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            drawable.setBounds(0, 0, size, size)
            drawable.draw(Canvas(bmp))
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }.getOrNull() ?: return
        s(JSONObject().put("type", "notif-icon").put("pkg", pkg).put("png", png))
    }
}
