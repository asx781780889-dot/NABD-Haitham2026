#!/usr/bin/env bash
# Usage: bash scripts/logs.sh [api|worker|postgres|redis]   (default: api)
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
f="$LOG_DIR/${1:-api}.log"; [ -f "$f" ] || die "No log yet: $f"
tail -n 80 -f "$f"
