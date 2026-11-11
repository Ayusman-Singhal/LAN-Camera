package com.lancamera.app

import android.content.Context
import android.net.Uri

/**
 * Which PC to connect to and how to prove we are allowed.
 *
 * @param method "key" (long key from the QR code) or "code" (8-char code typed by hand)
 * @param caFingerprint SHA-256 of the PC's private CA, lowercase hex. When set,
 *   only that exact CA is trusted (pinning).
 */
data class Pairing(
    val host: String,
    val port: Int,
    val method: String,
    val secret: String,
    val caFingerprint: String?,
) {
    val origin get() = "https://$host:$port"
    val wsUrl get() = "wss://$host:$port/ws"
    val label get() = "$host:$port"
}

object PairingStore {
    private const val PREFS = "pairing"

    fun load(ctx: Context): Pairing? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val host = p.getString("host", null) ?: return null
        val secret = p.getString("secret", null) ?: return null
        return Pairing(
            host = host,
            port = p.getInt("port", 8443),
            method = p.getString("method", "key") ?: "key",
            secret = secret,
            caFingerprint = p.getString("fp", null),
        )
    }

    fun save(ctx: Context, pairing: Pairing) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("host", pairing.host)
            .putInt("port", pairing.port)
            .putString("method", pairing.method)
            .putString("secret", pairing.secret)
            .putString("fp", pairing.caFingerprint)
            .apply()
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}

private val KEY_RE = Regex("^[A-Za-z0-9_-]{16,64}$")
private val FP_RE = Regex("^[0-9a-f]{64}$")
private val IPV4_RE = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

/** Only home-network addresses: 10.x, 172.16-31.x, 192.168.x. */
fun isPrivateIpv4(host: String): Boolean {
    val m = IPV4_RE.matchEntire(host) ?: return false
    val p = m.groupValues.drop(1).map { it.toInt() }
    if (p.any { it > 255 }) return false
    return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168)
}

/** Parses the QR code from the PC viewer: https://<ip>:<port>/cam#k=<key>&fp=<sha256>. */
fun parsePairingQr(text: String): Pairing? {
    val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
    if (uri.scheme != "https") return null
    val host = uri.host ?: return null
    if (!isPrivateIpv4(host)) return null
    val port = if (uri.port in 1..65535) uri.port else 8443
    val params = (uri.encodedFragment ?: return null).split('&').mapNotNull {
        val i = it.indexOf('=')
        if (i <= 0) null else it.substring(0, i) to it.substring(i + 1)
    }.toMap()
    val key = params["k"]?.takeIf { KEY_RE.matches(it) } ?: return null
    val fp = params["fp"]?.lowercase()?.takeIf { FP_RE.matches(it) }
    return Pairing(host, port, "key", key, fp)
}

/** Pairing typed by hand: PC address and the 8-character code from the viewer. */
fun manualPairing(address: String, code: String): Pairing? {
    val parts = address.trim().removePrefix("https://").substringBefore('/').split(':')
    val host = parts[0]
    if (!isPrivateIpv4(host)) return null
    val port = parts.getOrNull(1)?.toIntOrNull()?.takeIf { it in 1..65535 } ?: 8443
    val clean = code.uppercase().filter { it.isLetterOrDigit() }
    if (clean.length != 8) return null
    return Pairing(host, port, "code", clean, null)
}
