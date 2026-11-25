#!/bin/bash
# Removes the user LaunchAgent installed by install.sh (AGE-1669, task Г). Idempotent: running it when
# nothing is installed succeeds. Keeps the status file, the launchd log and every backup copy.
set -eu

LABEL="com.clickmoji.db-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || {
    printf 'uninstall: launchctl bootout не выполнен; агент остаётся загруженным\n' >&2
    exit 1
  }
fi
rm -f "$PLIST"
printf 'uninstall: агент %s удалён; статус и копии не тронуты\n' "$LABEL"
