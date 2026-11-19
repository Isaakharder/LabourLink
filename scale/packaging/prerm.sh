#!/bin/sh
# Stops the service on removal. Weighing data in /var/lib/labourlink-scale and
# config in /etc/labourlink-scale are left in place on purpose.
set -e
if [ -d /run/systemd/system ]; then
  systemctl stop labourlink-scaled.service || true
  if [ "$1" = "remove" ]; then
    systemctl disable labourlink-scaled.service || true
  fi
fi
exit 0
