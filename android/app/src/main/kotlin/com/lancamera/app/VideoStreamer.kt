package com.lancamera.app

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LiveData
import java.util.concurrent.Executors

/**
 * Camera -> hardware H.264 encoder -> packets.
 *
 * CameraX draws frames straight into the encoder's input surface, so no
 * frame is ever copied by the CPU. Runs inside the foreground service, so it
 * keeps working with the screen off.
 */
class VideoStreamer(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val listener: Listener,
) {
    interface Listener {
        /** Called on the encoder thread. */
        fun onVideoPacket(packet: ByteArray, key: Boolean, config: Boolean)
        fun onStreamInfo(width: Int, height: Int, rotation: Int)
        fun onCameraState(open: Boolean, error: String?)
        fun onTorchAvailable(available: Boolean)
    }

    private val mainExecutor = ContextCompat.getMainExecutor(context)
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val encoderThread = HandlerThread("video-encoder").apply { start() }
    private val encoderHandler = Handler(encoderThread.looper)

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var cameraState: LiveData<CameraState>? = null
    private var running = false
    @Volatile private var encoder: Encoder? = null
    @Volatile private var lastConfig: ByteArray? = null
    @Volatile private var lastInfo: Triple<Int, Int, Int>? = null

    /** Main thread. */
    fun start(settings: StreamSettings) {
        running = true
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!running) return@addListener
            provider = future.get()
            bind(settings)
        }, mainExecutor)
    }

    /** Main thread. Re-opens the camera with new size / fps / camera / orientation. */
    fun restart(settings: StreamSettings) {
        if (running && provider != null) bind(settings)
    }

    /** Main thread. */
    fun stop() {
        running = false
        cameraState?.removeObservers(owner)
        cameraState = null
        provider?.unbindAll() // encoder is released when CameraX lets go of its surface
        camera = null
    }

    fun release() {
        stop()
        cameraExecutor.shutdown()
        encoderThread.quitSafely()
    }

    fun requestKeyframe() {
        encoder?.setParam(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
    }

    fun setBitrate(bps: Int) {
        encoder?.setParam(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps)
    }

    fun setTorch(on: Boolean) {
        camera?.let { if (it.cameraInfo.hasFlashUnit()) it.cameraControl.enableTorch(on) }
    }

    /** After a reconnect the PC needs the codec config (SPS/PPS) again. */
    fun resendConfig() {
        lastInfo?.let { (w, h, r) -> listener.onStreamInfo(w, h, r) }
        lastConfig?.let { listener.onVideoPacket(Packets.make(Packets.VIDEO, Packets.FLAG_CONFIG, 0, it), false, true) }
    }

    private fun bind(s: StreamSettings) {
        val p = provider ?: return
        cameraState?.removeObservers(owner)
        p.unbindAll()
        camera = null

        // Sizes are given in sensor (landscape) terms: 1280x720, not 720x1280.
        val aspect = if (s.width * 3 == s.height * 4) {
            AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
        } else {
            AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
        }
        val resolution = ResolutionSelector.Builder()
            .setAspectRatioStrategy(aspect)
            .setResolutionStrategy(ResolutionStrategy(Size(s.width, s.height), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
            .build()
        // No screen in the service: rotation is relative to the phone held
        // upright (portrait) or turned left (landscape).
        val targetRotation = if (s.orientation == "landscape") Surface.ROTATION_90 else Surface.ROTATION_0
        val selector = if (s.facing == "user") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

        // Try the requested frame rate first; some phones refuse e.g. 60 fps.
        for (fps in listOf<Int?>(s.fps, null)) {
            try {
                val builder = Preview.Builder().setResolutionSelector(resolution).setTargetRotation(targetRotation)
                if (fps != null) builder.setTargetFrameRate(Range(fps, fps))
                val preview = builder.build()
                preview.setSurfaceProvider(cameraExecutor) { request -> onSurfaceRequest(request, s) }
                camera = p.bindToLifecycle(owner, selector, preview)
                break
            } catch (e: Exception) {
                Log.w(TAG, "Camera bind failed (fps=$fps)", e)
                p.unbindAll()
            }
        }

        val cam = camera
        if (cam == null) {
            listener.onCameraState(false, "Camera not available")
            return
        }
        val hasFlash = cam.cameraInfo.hasFlashUnit()
        listener.onTorchAvailable(hasFlash)
        if (s.torch && hasFlash) cam.cameraControl.enableTorch(true)
        cameraState = cam.cameraInfo.cameraState.also { live ->
            live.observe(owner) { st ->
                listener.onCameraState(st.type == CameraState.Type.OPEN, st.error?.let { errorText(it.code) })
            }
        }
    }

    private fun onSurfaceRequest(request: SurfaceRequest, s: StreamSettings) {
        val size = request.resolution
        val enc = try {
            Encoder.create(size.width, size.height, s.fps, s.bitrate, encoderHandler) { e, data, key, config, pts ->
                if (e !== encoder) return@create // old encoder still draining
                if (config) lastConfig = data
                val flags = (if (key) Packets.FLAG_KEY else 0) or (if (config) Packets.FLAG_CONFIG else 0)
                listener.onVideoPacket(Packets.make(Packets.VIDEO, flags, pts, data), key, config)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Encoder failed", e)
            request.willNotProvideSurface()
            listener.onCameraState(false, "Video encoder failed: ${e.message}")
            return
        }
        encoder = enc
        request.setTransformationInfoListener(cameraExecutor) { info ->
            lastInfo = Triple(size.width, size.height, info.rotationDegrees)
            listener.onStreamInfo(size.width, size.height, info.rotationDegrees)
        }
        request.provideSurface(enc.surface, cameraExecutor) {
            if (encoder === enc) encoder = null
            enc.release()
        }
    }

    private fun errorText(code: Int) = when (code) {
        CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> "Camera in use by another app"
        CameraState.ERROR_CAMERA_DISABLED -> "Camera disabled by the system"
        CameraState.ERROR_DO_NOT_DISTURB_MODE_ENABLED -> "Do Not Disturb blocks the camera"
        else -> "Camera error ($code)"
    }

    /** One MediaCodec H.264 encoder with a Surface input. */
    private class Encoder(val codec: MediaCodec, val surface: Surface) {
        @Volatile var released = false
        var ptsOffsetUs = Long.MIN_VALUE

        fun setParam(key: String, value: Int) {
            if (released) return
            runCatching { codec.setParameters(Bundle().apply { putInt(key, value) }) }
        }

        fun release() {
            if (released) return
            released = true
            runCatching { codec.stop() }
            runCatching { codec.release() }
            surface.release()
        }

        companion object {
            fun create(
                width: Int,
                height: Int,
                fps: Int,
                bitrate: Int,
                handler: Handler,
                out: (Encoder, ByteArray, Boolean, Boolean, Long) -> Unit,
            ): Encoder {
                val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                lateinit var enc: Encoder
                val callback = object : MediaCodec.Callback() {
                    override fun onInputBufferAvailable(c: MediaCodec, index: Int) {}

                    override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                        if (enc.released) return
                        try {
                            val buf = c.getOutputBuffer(index)
                            if (buf != null && info.size > 0) {
                                buf.position(info.offset)
                                buf.limit(info.offset + info.size)
                                val data = ByteArray(info.size)
                                buf.get(data)
                                val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                                val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                                var pts = 0L
                                if (!config) {
                                    // Camera timestamps may use a different clock than the
                                    // microphone. Map them onto System.nanoTime once.
                                    if (enc.ptsOffsetUs == Long.MIN_VALUE) {
                                        enc.ptsOffsetUs = System.nanoTime() / 1000 - info.presentationTimeUs
                                    }
                                    pts = info.presentationTimeUs + enc.ptsOffsetUs
                                }
                                out(enc, data, key, config, pts)
                            }
                            c.releaseOutputBuffer(index, false)
                        } catch (e: IllegalStateException) {
                            // Codec stopped while we were reading: ignore.
                        }
                    }

                    override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
                        Log.e(TAG, "Video encoder error", e)
                    }

                    override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
                        // Some encoders report SPS/PPS here instead of a config buffer.
                        val sps = format.getByteBuffer("csd-0") ?: return
                        val pps = format.getByteBuffer("csd-1") ?: return
                        val data = ByteArray(sps.remaining() + pps.remaining())
                        val spsLen = sps.remaining()
                        sps.get(data, 0, spsLen)
                        pps.get(data, spsLen, pps.remaining())
                        if (!enc.released) out(enc, data, false, true, 0)
                    }
                }
                codec.setCallback(callback, handler)

                val base = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                    setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                }
                val tuned = MediaFormat(base).apply {
                    setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                    setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
                }
                try {
                    codec.configure(tuned, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                } catch (e: Exception) {
                    Log.w(TAG, "Encoder rejected tuned format, using basic one", e)
                    codec.reset() // also clears the callback
                    codec.setCallback(callback, handler)
                    codec.configure(base, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                }
                val surface = codec.createInputSurface()
                enc = Encoder(codec, surface)
                codec.start()
                return enc
            }
        }
    }

    companion object {
        private const val TAG = "VideoStreamer"
    }
}
