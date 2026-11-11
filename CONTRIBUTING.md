# Contributing to LAN Camera

Thanks for considering a contribution! This project aims to be a small,
private, local-network-only camera feed — contributions that keep it that way
are especially welcome.

## Ways to help

- **Bug reports** — open an issue with your OS, Android version, phone brand,
  Node version, and what you expected vs. what happened.
- **Feature ideas** — open an issue first and let's discuss before you build
  something large.
- **Code / docs** — pull requests are welcome against `main`.

## Ground rules

- **Privacy is the point.** No feature may send anything to the internet. No
  cloud services, no telemetry, no analytics, no third-party trackers, no
  Google Play Services APIs. Everything must keep working on an offline LAN.
- **No new heavyweight dependencies.** The PC side is intentionally small
  (three npm deps). The Android app avoids Firebase/ML Kit etc.
- **Security first.** Anything touching auth, TLS, pairing or the media path
  should keep the existing guarantees: loopback-only viewer, HMAC-based
  pairing, private-IP-only listeners, certificate pinning. Explain your
  changes in the PR description.

## Development setup

PC server:

```
git clone https://github.com/Ayusman-Singhal/LAN-Camera
cd lan-camera
npm install
npm run check   # syntax-checks all server-side JS
npm start       # http://127.0.0.1:8440
```

Android app:

```
cd android
gradlew assembleDebug   # needs the Android SDK and a JDK 17
```

The Android APK is installed manually (side-loaded), never published to a
store — keep it that way.

## Pull requests

- Keep PRs focused: one feature or fix per PR.
- Match the existing code style (plain CommonJS JavaScript on the PC side,
  Kotlin on Android; comments explain *why*).
- Test on a real phone + real PC on the same Wi-Fi before submitting.
- Update the README if you change behavior.
