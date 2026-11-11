package com.lancamera.app

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLException
import java.security.cert.CertificateException

/**
 * Secure WebSocket to the PC server.
 *
 * Login: the server sends a random nonce; we answer HMAC-SHA256(secret, nonce).
 * The secret itself is never sent.
 *
 * Callbacks arrive on OkHttp threads.
 */
class ServerConnection(private val pairing: Pairing, private val listener: Listener) {

    interface Listener {
        /** Logged in. [newKey]: long key to use from now on (after a typed code). */
        fun onAuthed(newKey: String?, caFingerprint: String?)
        fun onServerMessage(msg: JSONObject)
        /** [retry]: try again later. [forgetPairing]: key no longer valid. */
        fun onDisconnected(reason: String, retry: Boolean, forgetPairing: Boolean)
    }

    private val client: OkHttpClient
    @Volatile private var ws: WebSocket? = null
    @Volatile var authed = false
        private set
    @Volatile private var finished = false

    init {
        val (factory, trust) = Tls.build(pairing.caFingerprint)
        client = OkHttpClient.Builder()
            .sslSocketFactory(factory, trust)
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS) // server pings every 5 s; OkHttp answers
            .build()
    }

    fun connect() {
        val request = Request.Builder()
            .url(pairing.wsUrl)
            .header("Origin", pairing.origin) // server checks Origin
            .build()
        ws = client.newWebSocket(request, SocketListener())
    }

    fun sendText(json: JSONObject): Boolean = authed && ws?.send(json.toString()) == true

    fun sendBinary(bytes: ByteArray): Boolean = authed && ws?.send(bytes.toByteString()) == true

    /** Bytes waiting to be sent. Large value = Wi-Fi too slow. */
    fun queuedBytes(): Long = ws?.queueSize() ?: 0L

    fun close() {
        finished = true
        authed = false
        ws?.close(1000, "bye")
        ws = null
        client.dispatcher.executorService.shutdown()
    }

    private fun end(reason: String, retry: Boolean, forget: Boolean) {
        if (finished) return
        finished = true
        authed = false
        listener.onDisconnected(reason, retry, forget)
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== ws) return
            val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (msg.optString("type")) {
                "challenge" -> {
                    val mac = hmacHex(pairing.secret, msg.optString("nonce"))
                    webSocket.send(
                        JSONObject()
                            .put("type", "auth")
                            .put("method", pairing.method)
                            .put("mac", mac)
                            .put("client", "app")
                            .toString()
                    )
                }
                "auth-ok" -> {
                    authed = true
                    listener.onAuthed(
                        msg.optString("key").takeIf { it.isNotEmpty() },
                        msg.optString("caFp").takeIf { it.isNotEmpty() },
                    )
                }
                "auth-fail" -> {
                    val reason = msg.optString("reason")
                    end(FAIL_TEXT[reason] ?: "Rejected by PC.", retry = false, forget = reason == "bad-key")
                    webSocket.close(1000, null)
                }
                "kicked" -> {
                    val keyChanged = msg.optString("reason") == "pairing key changed"
                    end(if (keyChanged) "PC changed the key. Scan the new QR code." else "Disconnected by PC.", retry = false, forget = keyChanged)
                }
                "replaced" -> end("Camera opened somewhere else.", retry = false, forget = false)
                else -> listener.onServerMessage(msg)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {}

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket === ws) end("PC closed the connection.", retry = true, forget = false)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket !== ws) return
            val text = when {
                t is SSLException && t.cause is CertificateException -> t.cause?.message ?: "PC certificate not trusted."
                t is SSLException -> "Secure connection failed. Is the LAN Camera certificate installed?"
                else -> "PC not reachable (${t.javaClass.simpleName})."
            }
            end(text, retry = true, forget = false)
        }
    }

    companion object {
        private val FAIL_TEXT = mapOf(
            "bad-key" to "Wrong or expired key. Scan the QR code on the PC again.",
            "busy" to "Another phone is already connected to the PC.",
            "locked" to "Pairing is locked on the PC.",
            "blocked" to "Too many wrong attempts. Wait 10 minutes.",
        )

        fun hmacHex(secret: String, message: String): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            return mac.doFinal(message.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        }
    }
}
