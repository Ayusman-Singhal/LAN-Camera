package com.lancamera.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch

/** Phone screen: pair with the PC, start/stop. Everything else is on the PC. */
class MainActivity : AppCompatActivity() {

    private lateinit var statusRing: View
    private lateinit var statusText: TextView
    private lateinit var detailText: TextView
    private lateinit var lockHint: TextView
    private lateinit var startBtn: MaterialButton
    private lateinit var pairedText: TextView
    private lateinit var pinnedText: TextView
    private lateinit var scanRow: View
    private lateinit var manualRow: View
    private lateinit var manualPanel: View
    private lateinit var forgetBtn: View
    private lateinit var forgetDivider: View
    private lateinit var batteryText: TextView
    private lateinit var batteryBtn: View
    private lateinit var batteryState: TextView
    private lateinit var notifText: TextView
    private lateinit var notifHint: TextView
    private lateinit var notifBtn: View
    private lateinit var notifState: TextView

    private var running = false
    private var afterPermissions: (() -> Unit)? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val action = afterPermissions
        afterPermissions = null
        if (granted(Manifest.permission.CAMERA)) action?.invoke()
        else toast("Camera permission is needed.")
    }

    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text = result.data?.getStringExtra(ScanActivity.EXTRA_RESULT) ?: return@registerForActivityResult
        val pairing = parsePairingQr(text)
        if (pairing == null) {
            toast("Not a LAN Camera QR code.")
        } else {
            PairingStore.save(this, pairing)
            toast("Paired with ${pairing.label}")
            refreshPairing()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        statusRing = findViewById(R.id.statusRing)
        statusText = findViewById(R.id.statusText)
        detailText = findViewById(R.id.detailText)
        lockHint = findViewById(R.id.lockHint)
        startBtn = findViewById(R.id.startBtn)
        pairedText = findViewById(R.id.pairedText)
        pinnedText = findViewById(R.id.pinnedText)
        scanRow = findViewById(R.id.scanBtn)
        manualRow = findViewById(R.id.manualBtn)
        manualPanel = findViewById(R.id.manualPanel)
        forgetBtn = findViewById(R.id.forgetBtn)
        forgetDivider = findViewById(R.id.forgetDivider)
        batteryText = findViewById(R.id.batteryText)
        batteryBtn = findViewById(R.id.batteryBtn)
        batteryState = findViewById(R.id.batteryState)
        notifText = findViewById(R.id.notifText)
        notifHint = findViewById(R.id.notifHint)
        notifBtn = findViewById(R.id.notifBtn)
        notifState = findViewById(R.id.notifState)
        notifBtn.setOnClickListener { openNotificationAccess() }

        startBtn.setOnClickListener { onStartStop() }
        scanRow.setOnClickListener {
            if (running) return@setOnClickListener toast("Stop the camera first.")
            withPermissions(listOf(Manifest.permission.CAMERA)) {
                scanLauncher.launch(Intent(this, ScanActivity::class.java))
            }
        }
        manualRow.setOnClickListener {
            if (running) return@setOnClickListener toast("Stop the camera first.")
            manualPanel.isVisible = !manualPanel.isVisible
        }
        findViewById<View>(R.id.connectManualBtn).setOnClickListener {
            val address = findViewById<TextInputEditText>(R.id.addressInput).text?.toString().orEmpty()
            val code = findViewById<TextInputEditText>(R.id.codeInput).text?.toString().orEmpty()
            val pairing = manualPairing(address, code)
            if (pairing == null) {
                toast("Enter the PC address (like 192.168.1.5) and the 8-character code.")
            } else {
                PairingStore.save(this, pairing)
                manualPanel.isVisible = false
                refreshPairing()
                toast("Saved. Tap Start camera.")
            }
        }
        forgetBtn.setOnClickListener {
            if (running) return@setOnClickListener toast("Stop the camera first.")
            PairingStore.clear(this)
            refreshPairing()
        }
        batteryBtn.setOnClickListener { openBatterySettings() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                AppState.ui.collect { render(it) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPairing()
        refreshBattery()
        refreshNotifAccess()
    }

    private fun refreshNotifAccess() {
        val ok = NotificationHub.hasAccess(this)
        notifText.text = getString(if (ok) R.string.notif_ok else R.string.notif_needed)
        notifHint.isVisible = !ok
        showState(notifState, ok)
    }

    private fun openNotificationAccess() {
        // Opens the switch for this app directly; falls back to the full list.
        val direct = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, NotificationHub.component(this).flattenToString())
        try {
            startActivity(direct)
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun onStartStop() {
        if (running) {
            CameraService.stop(this)
            return
        }
        if (PairingStore.load(this) == null) return toast("Pair with your PC first.")
        val perms = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        // Mic and notifications are optional; only the camera is required.
        withPermissions(perms) { CameraService.start(this) }
    }

    private fun render(ui: UiState) {
        running = ui.running
        statusText.text = ui.status
        detailText.text = ui.detail
        detailText.isVisible = ui.detail.isNotEmpty()
        val ringColor = color(dotColor(ui.kind))
        (statusRing.background.mutate() as GradientDrawable).setStroke((4 * resources.displayMetrics.density).toInt(), ringColor)

        startBtn.text = getString(if (ui.running) R.string.stop_short else R.string.start_short)
        startBtn.contentDescription = getString(if (ui.running) R.string.stop else R.string.start)
        startBtn.backgroundTintList = ColorStateList.valueOf(color(if (ui.running) R.color.bad else R.color.accent))
        lockHint.isVisible = ui.running && ui.kind == StatusKind.STREAMING
        refreshPairing()
    }

    private fun dotColor(kind: StatusKind) = when (kind) {
        StatusKind.STREAMING -> R.color.ok
        StatusKind.CONNECTING, StatusKind.IDLE -> R.color.warn
        StatusKind.ERROR -> R.color.bad
        StatusKind.STOPPED -> R.color.idle
    }

    private fun refreshPairing() {
        val p = PairingStore.load(this)
        if (p == null) {
            pairedText.text = getString(R.string.not_paired)
            pinnedText.text = getString(R.string.not_paired_help)
        } else {
            pairedText.text = p.label
            pinnedText.text = getString(if (p.caFingerprint != null) R.string.pinned else R.string.not_pinned)
        }
        // Pairing changes only while stopped (the camera is shared with the scanner).
        scanRow.alpha = if (running) 0.5f else 1f
        manualRow.alpha = if (running) 0.5f else 1f
        if (running) manualPanel.isVisible = false
        forgetBtn.isVisible = p != null && !running
        forgetDivider.isVisible = forgetBtn.isVisible
    }

    private fun refreshBattery() {
        val ok = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        batteryText.text = getString(if (ok) R.string.battery_ok else R.string.battery_needed)
        showState(batteryState, ok)
    }

    @SuppressLint("BatteryLife") // personal app: it must keep running in the background
    private fun openBatterySettings() {
        val pm = getSystemService(PowerManager::class.java)
        val intent = if (pm.isIgnoringBatteryOptimizations(packageName)) {
            // Samsung/Xiaomi have an extra per-app battery setting in App info.
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri())
        } else {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri())
        }
        startActivity(intent)
    }

    private fun withPermissions(perms: List<String>, action: () -> Unit) {
        val missing = perms.filterNot { granted(it) }
        if (missing.isEmpty()) {
            action()
        } else {
            afterPermissions = action
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun granted(perm: String) = ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

    private fun color(res: Int) = ContextCompat.getColor(this, res)

    private fun showState(view: TextView, on: Boolean) {
        view.text = getString(if (on) R.string.state_on else R.string.state_off)
        view.setTextColor(color(if (on) R.color.ok else R.color.warn))
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}
