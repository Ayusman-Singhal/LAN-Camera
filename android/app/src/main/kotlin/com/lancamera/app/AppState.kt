package com.lancamera.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** Colour of the status dot on the app screen. */
enum class StatusKind { STOPPED, CONNECTING, IDLE, STREAMING, ERROR }

/** What the screen shows. Written by [CameraService], read by [MainActivity]. */
data class UiState(
    val running: Boolean = false,
    val kind: StatusKind = StatusKind.STOPPED,
    val status: String = "Stopped",
    val detail: String = "Tap Start to stream to your PC.",
)

object AppState {
    private val state = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = state

    fun set(transform: (UiState) -> UiState) = state.update(transform)
}
