package com.lancamera.app

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/**
 * Scans the pairing QR code shown on the PC viewer.
 * Uses ZXing: decoding runs fully on the phone, no network, no Google services.
 */
class ScanActivity : ComponentActivity() {

    private lateinit var previewView: PreviewView
    private val executor = Executors.newSingleThreadExecutor()
    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            )
        )
    }
    @Volatile private var done = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        previewView = PreviewView(this)
        val dp = resources.displayMetrics.density
        val hint = TextView(this).apply {
            text = getString(R.string.scan_hint)
            setTextColor(Color.WHITE)
            textSize = 17f
            gravity = Gravity.CENTER
        }
        val cancel = MaterialButton(this).apply {
            text = getString(R.string.cancel)
            setOnClickListener { finish() }
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xB3000000.toInt())
            setPadding((24 * dp).toInt(), (20 * dp).toInt(), (24 * dp).toInt(), (40 * dp).toInt())
            addView(hint)
            addView(cancel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (14 * dp).toInt()
            })
        }
        // Square guide in the middle of the preview.
        val guide = View(this).apply {
            background = GradientDrawable().apply {
                setStroke((3 * dp).toInt(), Color.WHITE)
                cornerRadius = 24 * dp
            }
        }
        val size = (240 * dp).toInt()
        val root = FrameLayout(this).apply {
            addView(previewView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(guide, FrameLayout.LayoutParams(size, size, Gravity.CENTER))
            addView(panel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        setContentView(root)
        startCamera()
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor, ::analyze)
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    /** Decodes the brightness (Y) plane of each camera frame. */
    private fun analyze(proxy: ImageProxy) {
        try {
            if (done) return
            val plane = proxy.planes[0]
            val stride = plane.rowStride
            val width = proxy.width
            val height = proxy.height
            val buf = plane.buffer
            // The last row may be shorter than the stride: pad to a full block.
            val data = ByteArray(stride * height)
            buf.get(data, 0, minOf(buf.remaining(), data.size))
            val source = PlanarYUVLuminanceSource(data, stride, height, 0, 0, width, height, false)
            val text = try {
                reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
            } catch (_: Exception) {
                null // no QR code in this frame
            } finally {
                reader.reset()
            }
            if (text != null && parsePairingQr(text) != null) {
                done = true
                runOnUiThread {
                    setResult(RESULT_OK, Intent().putExtra(EXTRA_RESULT, text))
                    finish()
                }
            }
        } finally {
            proxy.close()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdown()
    }

    companion object {
        const val EXTRA_RESULT = "qr"
    }
}
