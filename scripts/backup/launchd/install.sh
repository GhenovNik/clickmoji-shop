#!/bin/bash
# Installs or refreshes the user LaunchAgent that runs scripts/backup/run-scheduled.sh (AGE-1669).
# Idempotent: running it again replaces the agent with the same settings. Run it from the main checkout
# (~/Projects/clickmoji-shop); it refuses to install a job that would point at a worktree.
#
# Settings:
#   CLICKMOJI_BACKUP_INTERVAL_SECONDS  seconds between runs (integer >= 60, default 259200 = 3 days)
# Prerequisites: Docker Desktop running in this user session, node and npm on PATH at install time,
# and the read-only role's address stored in the login Keychain (see docs/ops.md).
# Installs no packages. Writes only ~/Library/LaunchAgents/<label>.plist and ~/Library/Logs/clickmoji-backup.
set -eu
umask 077

LABEL="com.clickmoji.db-backup"
DEFAULT_INTERVAL=259200
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
WRAPPER="$REPO_ROOT/scripts/backup/run-scheduled.sh"
TEMPLATE="$SCRIPT_DIR/com.clickmoji.db-backup.plist.template"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
STATE_DIR="$HOME/Library/Logs/clickmoji-backup"
LOG_FILE="$STATE_DIR/launchd.log"
DOMAIN="gui/$(id -u)"

fail() {
  printf 'install: %s\n' "$1" >&2
  exit 1
}

MAIN_CHECKOUT="$(cd "$HOME/Projects/clickmoji-shop" 2>/dev/null && pwd -P || true)"
if [ -z "$MAIN_CHECKOUT" ] || [ "$MAIN_CHECKOUT" != "$REPO_ROOT" ]; then
  fail "запустите из основной копии ~/Projects/clickmoji-shop (сейчас: $REPO_ROOT)"
fi

INTERVAL="${CLICKMOJI_BACKUP_INTERVAL_SECONDS:-$DEFAULT_INTERVAL}"
case "$INTERVAL" in
  '' | *[!0-9]*) fail "CLICKMOJI_BACKUP_INTERVAL_SECONDS: нужно целое число секунд" ;;
esac
[ "$INTERVAL" -ge 60 ] || fail "CLICKMOJI_BACKUP_INTERVAL_SECONDS: не меньше 60"

NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"
[ -n "$NPM_BIN" ] && [ -n "$NODE_BIN" ] || fail "нужны node и npm в PATH"
[ -x "$WRAPPER" ] || fail "нет исполняемого run-scheduled.sh"

# launchd PATH: the directories of node, npm and docker as this shell sees them, then the system ones.
PATH_VALUE="$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN")"
DOCKER_BIN="$(command -v docker || true)"
if [ -n "$DOCKER_BIN" ]; then
  PATH_VALUE="$PATH_VALUE:$(dirname "$DOCKER_BIN")"
else
  printf 'install: предупреждение: docker не найден в PATH; задание не сможет снять копию до его установки\n' >&2
fi
PATH_VALUE="$PATH_VALUE:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Values go into the XML without escaping; characters that would break the plist or the sed template are refused.
for value in "$WRAPPER" "$REPO_ROOT" "$PATH_VALUE" "$LOG_FILE"; do
  case "$value" in
    *'|'* | *'&'* | *'\'* | *'<'* | *'>'* | *'"'* | *$'\n'*)
      fail "путь содержит символ, который нельзя записать в plist" ;;
  esac
done

mkdir -p "$AGENTS_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR"

TMP_PLIST="$AGENTS_DIR/.$LABEL.plist.tmp.$$"
PREV_PLIST="$AGENTS_DIR/.$LABEL.plist.prev.$$"
trap 'rm -f "$TMP_PLIST"' EXIT
sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__WRAPPER__|$WRAPPER|g" \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__PATH__|$PATH_VALUE|g" \
  -e "s|__INTERVAL__|$INTERVAL|g" \
  -e "s|__LOG__|$LOG_FILE|g" \
  "$TEMPLATE" > "$TMP_PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TMP_PLIST" >/dev/null || fail "plist не прошёл проверку plutil"
fi
# Order matters. The old job and the old plist stay untouched until bootout has succeeded. After that the
# old plist is moved aside (same bytes, same file), the new one is put in place and bootstrapped. Any
# failure from that point goes through rollback, which puts the old plist back and reloads the old job
# if it was loaded before. A job that was not loaded before is never loaded by a rollback.
was_loaded=0
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then was_loaded=1; fi
had_plist=0
if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then had_plist=1; fi
moved_old=0
placed_new=0

recovery_failed() {
  printf 'install: ВОССТАНОВЛЕНИЕ НЕ УДАЛОСЬ: %s\n' "$1" >&2
  printf 'install: агент %s может быть не загружен; проверьте %s и повторите install.sh\n' "$LABEL" "$PLIST" >&2
  if [ "$moved_old" -eq 1 ]; then
    printf 'install: прежний plist сохранён в %s\n' "$PREV_PLIST" >&2
  fi
  exit 2
}

rollback() {
  printf 'install: %s\n' "$1" >&2
  if [ "$placed_new" -eq 1 ]; then
    rm -f "$PLIST" || recovery_failed "не удалось убрать новый plist $PLIST"
    placed_new=0
  fi
  if [ "$moved_old" -eq 1 ]; then
    mv -f "$PREV_PLIST" "$PLIST" || recovery_failed "не удалось вернуть прежний plist из $PREV_PLIST"
    moved_old=0
  fi
  if [ "$was_loaded" -eq 1 ]; then
    if launchctl bootstrap "$DOMAIN" "$PLIST" && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      printf 'install: прежний агент восстановлен из прежнего plist; новая настройка не установлена\n' >&2
      exit 1
    fi
    recovery_failed "прежний агент не загрузился обратно после отката"
  fi
  printf 'install: откат выполнен; агент %s не установлен\n' "$LABEL" >&2
  exit 1
}

if [ "$had_plist" -eq 1 ]; then
  if [ "$was_loaded" -eq 1 ]; then
    launchctl bootout "$DOMAIN/$LABEL" || fail "launchctl bootout не выполнен; прежний агент и plist не тронуты"
  fi
  mv -f "$PLIST" "$PREV_PLIST" || rollback "не удалось отложить прежний plist"
  moved_old=1
elif [ "$was_loaded" -eq 1 ]; then
  fail "прежний агент загружен, но его plist отсутствует; обновление остановлено до выгрузки"
fi

mv -f "$TMP_PLIST" "$PLIST" || rollback "не удалось записать новый plist"
placed_new=1
trap - EXIT

if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  rollback "launchctl bootstrap нового агента не выполнен"
fi
if [ "$moved_old" -eq 1 ]; then
  rm -f "$PREV_PLIST"
fi

printf 'install: агент %s установлен, интервал %s с, статус: %s\n' "$LABEL" "$INTERVAL" \
  "$STATE_DIR/status.tsv"
