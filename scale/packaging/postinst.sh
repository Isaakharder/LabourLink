#!/bin/sh
# LabourLink Scale post-install. A fresh install always starts in SIMULATION
# mode; switching to live is a deliberate manual step (docs/SETUP.md).
set -e

mkdir -p /etc/labourlink-scale
chmod 0755 /etc/labourlink-scale
if [ ! -f /etc/labourlink-scale/config.json ]; then
  install -m 0644 /usr/share/labourlink-scale/config.simulation.json /etc/labourlink-scale/config.json
fi
# LoadCredential needs the file to exist; an empty token just keeps live
# uploads queued until a real one is installed.
if [ ! -f /etc/labourlink-scale/station-token ]; then
  install -m 0600 /dev/null /etc/labourlink-scale/station-token
fi

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=tty || true
fi

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable labourlink-scaled.service
  systemctl restart labourlink-scaled.service
fi
exit 0
