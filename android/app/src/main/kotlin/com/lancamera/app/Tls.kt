package com.lancamera.app

import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * TLS setup for the connection to the PC.
 *
 * Paired by QR code: the QR carries the SHA-256 of the PC's private CA. Only a
 * server certificate signed by exactly that CA is accepted, even if other CAs
 * are installed on the phone.
 *
 * Paired by typed code: falls back to the phone's trust store, which includes
 * the LAN Camera CA you installed (see network_security_config.xml).
 */
object Tls {
    fun build(caFingerprint: String?): Pair<SSLSocketFactory, X509TrustManager> {
        val tm = if (caFingerprint != null) PinnedTrustManager(caFingerprint) else defaultTrustManager()
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return ctx.socketFactory to tm
    }

    private fun defaultTrustManager(): X509TrustManager {
        val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        f.init(null as KeyStore?)
        return f.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

private class PinnedTrustManager(private val fingerprint: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) throw CertificateException("Empty certificate chain")
        // The server sends [leaf, CA]. Find the pinned CA in the chain.
        val ca = chain.firstOrNull { Tls.sha256Hex(it.encoded) == fingerprint }
            ?: throw CertificateException("PC certificate does not match the paired PC. Scan the QR code again.")
        val leaf = chain[0]
        if (leaf === ca) throw CertificateException("Server sent only the CA certificate")
        leaf.checkValidity()
        leaf.verify(ca.publicKey) // throws if not signed by the pinned CA
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not used")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
