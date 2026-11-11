package com.lancamera.app

import android.content.Context
import org.json.JSONObject

/** Camera settings. Changed from the PC viewer; remembered on the phone. */
data class StreamSettings(
    val facing: String = "environment",
    val res: String = "1280x720",
    val fps: Int = 30,
    val bitrate: Int = 4_000_000,
    val torch: Boolean = false,
    val audio: Boolean = true,
    val orientation: String = "portrait",
) {
    val width get() = res.substringBefore('x').toInt()
    val height get() = res.substringAfter('x').toInt()

    fun toJson(): JSONObject = JSONObject()
        .put("facing", facing)
        .put("res", res)
        .put("fps", fps)
        .put("bitrate", bitrate)
        .put("torch", torch)
        .put("audio", audio)
        .put("orientation", orientation)

    /** Applies a request from the PC. Unknown or invalid values are ignored. */
    fun merge(j: JSONObject): StreamSettings {
        var s = this
        if (j.has("facing")) j.optString("facing").takeIf { it in FACING }?.let { s = s.copy(facing = it, torch = false) }
        if (j.has("res")) j.optString("res").takeIf { it in RES }?.let { s = s.copy(res = it) }
        if (j.has("fps")) j.optInt("fps").takeIf { it in FPS }?.let { s = s.copy(fps = it) }
        if (j.has("bitrate")) j.optInt("bitrate").takeIf { it in BITRATES }?.let { s = s.copy(bitrate = it) }
        if (j.has("torch")) s = s.copy(torch = j.optBoolean("torch"))
        if (j.has("audio")) s = s.copy(audio = j.optBoolean("audio"))
        if (j.has("orientation")) j.optString("orientation").takeIf { it in ORIENTATIONS }?.let { s = s.copy(orientation = it) }
        return s
    }

    companion object {
        val FACING = listOf("user", "environment")
        val RES = listOf("640x480", "1280x720", "1920x1080")
        val FPS = listOf(15, 24, 30, 60)
        val BITRATES = listOf(1_500_000, 4_000_000, 8_000_000)
        val ORIENTATIONS = listOf("portrait", "landscape")
        private const val PREFS = "settings"

        fun load(ctx: Context): StreamSettings {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val d = StreamSettings()
            return StreamSettings(
                facing = p.getString("facing", d.facing).takeIf { it in FACING } ?: d.facing,
                res = p.getString("res", d.res).takeIf { it in RES } ?: d.res,
                fps = p.getInt("fps", d.fps).takeIf { it in FPS } ?: d.fps,
                bitrate = p.getInt("bitrate", d.bitrate).takeIf { it in BITRATES } ?: d.bitrate,
                torch = false,
                audio = p.getBoolean("audio", d.audio),
                orientation = p.getString("orientation", d.orientation).takeIf { it in ORIENTATIONS } ?: d.orientation,
            )
        }

        fun save(ctx: Context, s: StreamSettings) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("facing", s.facing)
                .putString("res", s.res)
                .putInt("fps", s.fps)
                .putInt("bitrate", s.bitrate)
                .putBoolean("audio", s.audio)
                .putString("orientation", s.orientation)
                .apply()
        }
    }
}
