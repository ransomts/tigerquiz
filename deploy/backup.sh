#!/bin/sh
# Back up the tigerquiz report database.
#
#   deploy/backup.sh /srv/tigerquiz/data /srv/backups
#
# The database runs in WAL mode, so at any moment some committed reports live in
# tigerquiz.db-wal and not yet in tigerquiz.db. Copying the .db file alone can
# therefore lose the most recent games, and copying the three files separately
# can catch them mid-checkpoint and produce a backup that will not open.
# "VACUUM INTO" takes a consistent snapshot of a live database in one file, and
# does not block the running server.
#
# Cron it daily:
#   17 3 * * *  /srv/tigerquiz/deploy/backup.sh /srv/tigerquiz/data /srv/backups
set -eu

DATA_DIR="${1:?usage: backup.sh <data-dir> <backup-dir> [keep-days]}"
BACKUP_DIR="${2:?usage: backup.sh <data-dir> <backup-dir> [keep-days]}"
KEEP_DAYS="${3:-30}"

SRC="$DATA_DIR/tigerquiz.db"
DEST="$BACKUP_DIR/tigerquiz-$(date +%Y-%m-%d).db"

[ -f "$SRC" ] || { echo "no database at $SRC" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

sqlite3 "$SRC" "VACUUM INTO '$DEST'"

# Fail loudly rather than keeping a backup that will not open.
sqlite3 "$DEST" "PRAGMA integrity_check;" | grep -qx ok || {
  echo "integrity check failed for $DEST" >&2
  exit 1
}

# Reports carry student names and identifiers.
chmod 600 "$DEST"

find "$BACKUP_DIR" -name 'tigerquiz-*.db' -type f -mtime "+$KEEP_DAYS" -delete

echo "backed up to $DEST ($(du -h "$DEST" | cut -f1))"
