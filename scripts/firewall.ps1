# LAN Camera - Windows Firewall rules.
# Run once in an elevated PowerShell (Run as administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1
#
# Allows inbound TCP 8443 (phone page) and 8080 (one-time certificate setup)
# for node.exe, ONLY on "Private" networks and ONLY from the local subnet.
# On "Public" networks (cafes, hotels) the ports stay closed.
# Video itself is WebRTC (UDP) started from the PC browser, so it needs no
# inbound rule.

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Run this script as administrator.'
}

$node = (Get-Command node).Source
$name = 'LAN Camera'

Get-NetFirewallRule -DisplayName "$name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName "$name (phone page 8443)" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 8443 -Program $node -Profile Private -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName "$name (cert setup 8080)" -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 8080 -Program $node -Profile Private -RemoteAddress LocalSubnet | Out-Null

Write-Host "Firewall rules added for $node (Private networks, local subnet only)."
Write-Host ''
Write-Host 'Your current network profiles:'
Get-NetConnectionProfile | Format-Table Name, InterfaceAlias, NetworkCategory -AutoSize
Write-Host 'Your home Wi-Fi (and later the phone hotspot) must be "Private". To change:'
Write-Host '  Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private'
