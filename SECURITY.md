# Security Policy

LAN Camera is built around privacy: everything stays on your local network,
and the only server you talk to is the one running on your own PC. If you
found a way to break that, please tell us.

## Supported versions

Only the latest release / `main` branch is supported.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Instead, open a private security advisory via GitHub:
"Security" tab → "Report a vulnerability" on this repository, or contact the
maintainer directly (see the repository profile for a contact address).

Please include:

- What you found and how to reproduce it.
- Which component (PC server, viewer page, phone page, Android app).
- Whether it needs to be on the local network or could be remote.

## Scope notes

- The design intentionally exposes port 8443 to the **local network only**
  (private/loopback IPv4 clients are checked before TLS). Reports that assume
  internet exposure are still useful but out of scope.
- The viewer server is bound to `127.0.0.1` by design; no remote access is
  intended.
- The generated CA (`data/ca.key`) is deliberately restricted by Name
  Constraints to private IP ranges, so even a leak cannot fake public
  websites. Reports about weakening that constraint are in scope.

## What we promise

- Acknowledgement within 7 days.
- A fix or mitigation for accepted reports, and public credit if you want it.
