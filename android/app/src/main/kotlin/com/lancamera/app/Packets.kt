package com.lancamera.app

import java.nio.ByteBuffer

/**
 * Binary media packet sent to the PC (same layout as lib/media.js):
 *   byte 0     type   1 = video (H.264 Annex-B), 2 = audio (AAC)
 *   byte 1     flags  bit 0 = key frame, bit 1 = codec config
 *   bytes 2-9  presentation time in microseconds (System.nanoTime clock), big-endian
 *   bytes 10.. payload
 */
object Packets {
    const val VIDEO = 1
    const val AUDIO = 2
    const val FLAG_KEY = 1
    const val FLAG_CONFIG = 2
    private const val HEADER = 10

    fun make(type: Int, flags: Int, ptsUs: Long, data: ByteArray): ByteArray {
        val out = ByteArray(HEADER + data.size)
        out[0] = type.toByte()
        out[1] = flags.toByte()
        ByteBuffer.wrap(out).putLong(2, ptsUs)
        System.arraycopy(data, 0, out, HEADER, data.size)
        return out
    }

    fun isVideo(packet: ByteArray) = packet[0].toInt() == VIDEO
}
