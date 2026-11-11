package com.lancamera.app

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.util.Log
import kotlin.math.abs
import kotlin.math.max

/**
 * Microphone -> AAC-LC 48 kHz mono, 96 kbit/s -> packets.
 * Timestamps use System.nanoTime, the same clock as [VideoStreamer].
 */
class AudioStreamer(private val onPacket: (packet: ByteArray, config: Boolean) -> Unit) {

    @Volatile private var running = false
    private var thread: Thread? = null
    @Volatile private var lastConfig: ByteArray? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread(::loop, "audio-encoder").apply { start() }
    }

    fun stop() {
        running = false
        thread?.join(1500)
        thread = null
    }

    fun resendConfig() {
        lastConfig?.let { onPacket(Packets.make(Packets.AUDIO, Packets.FLAG_CONFIG, 0, it), true) }
    }

    @SuppressLint("MissingPermission") // checked by CameraService before start()
    private fun loop() {
        var rec: AudioRecord? = null
        var codec: MediaCodec? = null
        try {
            val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val bufSize = max(minBuf, READ_BYTES * 4)
            // CAMCORDER source is tuned for video recording; fall back to plain MIC.
            for (source in intArrayOf(MediaRecorder.AudioSource.CAMCORDER, MediaRecorder.AudioSource.MIC)) {
                val r = AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize)
                if (r.state == AudioRecord.STATE_INITIALIZED) {
                    rec = r
                    break
                }
                r.release()
            }
            val recorder = rec ?: throw IllegalStateException("Microphone not available")

            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 96_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, READ_BYTES * 2)
            }
            val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
            codec = enc
            enc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            enc.start()
            recorder.startRecording()

            val info = MediaCodec.BufferInfo()
            var baseUs = -1L
            var samples = 0L
            val bufferLatencyUs = bufSize / 2 * 1_000_000L / SAMPLE_RATE / 2

            while (running) {
                val inIndex = enc.dequeueInputBuffer(10_000)
                if (inIndex >= 0) {
                    val input = enc.getInputBuffer(inIndex)!!
                    input.clear()
                    val n = recorder.read(input, minOf(input.capacity(), READ_BYTES))
                    if (n > 0) {
                        val nowUs = System.nanoTime() / 1000 - bufferLatencyUs
                        if (baseUs < 0) baseUs = nowUs
                        var pts = baseUs + samples * 1_000_000L / SAMPLE_RATE
                        // Keep the sample clock locked to the system clock (long sessions).
                        if (abs(pts - nowUs) > 200_000) {
                            baseUs = nowUs - samples * 1_000_000L / SAMPLE_RATE
                            pts = nowUs
                        }
                        samples += n / 2
                        enc.queueInputBuffer(inIndex, 0, n, pts, 0)
                    } else {
                        enc.queueInputBuffer(inIndex, 0, 0, 0, 0)
                    }
                }
                drain(enc, info)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Audio stopped", e)
        } finally {
            runCatching { rec?.stop() }
            runCatching { rec?.release() }
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
        }
    }

    private fun drain(enc: MediaCodec, info: MediaCodec.BufferInfo) {
        while (true) {
            val index = enc.dequeueOutputBuffer(info, 0)
            when {
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    enc.outputFormat.getByteBuffer("csd-0")?.let { csd ->
                        val asc = ByteArray(csd.remaining()).also { csd.get(it) }
                        sendConfig(asc)
                    }
                }
                index >= 0 -> {
                    val buf = enc.getOutputBuffer(index)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val data = ByteArray(info.size).also { buf.get(it) }
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            sendConfig(data)
                        } else {
                            onPacket(Packets.make(Packets.AUDIO, Packets.FLAG_KEY, info.presentationTimeUs, data), false)
                        }
                    }
                    enc.releaseOutputBuffer(index, false)
                }
                else -> return // INFO_TRY_AGAIN_LATER
            }
        }
    }

    private fun sendConfig(asc: ByteArray) {
        lastConfig = asc
        onPacket(Packets.make(Packets.AUDIO, Packets.FLAG_CONFIG, 0, asc), true)
    }

    companion object {
        private const val TAG = "AudioStreamer"
        private const val SAMPLE_RATE = 48_000
        private const val READ_BYTES = 2048 // 1024 samples = one AAC frame
    }
}
