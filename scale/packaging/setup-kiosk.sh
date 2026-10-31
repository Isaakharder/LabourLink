#!/bin/sh
# One-off kiosk setup for the station's desktop user on Linux Mint 22 XFCE.
# Run as that user (not root) after installing the .deb:
#   sh /usr/share/labourlink-scale/setup-kiosk.sh
# Changes are XFCE per-user settings only and can be reverted in Settings.
set -e

# Never blank or power off the display.
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/blank-on-ac -n -t int -s 0
xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false 2>/dev/null || true
xfconf-query -c xfce4-screensaver -p /lock/enabled -n -t bool -s false 2>/dev/null || true

# Stop the update manager popping up over the weighing screen.
mkdir -p "$HOME/.config/autostart"
for f in mintupdate.desktop mintwelcome.desktop; do
  if [ -f "/etc/xdg/autostart/$f" ]; then
    cp "/etc/xdg/autostart/$f" "$HOME/.config/autostart/$f"
    echo "Hidden=true" >> "$HOME/.config/autostart/$f"
  fi
done

echo "Kiosk settings applied. Enable automatic login for this user in Login Window settings, then reboot."
