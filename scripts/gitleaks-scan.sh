#!/bin/sh
# The one place the secret scanner's arguments are written down.
#
# Continuous integration runs it over the tree and over the history; the tree scanner's
# self-test runs it over a directory of deliberately matching strings. Sharing this file
# is what stops the two from drifting apart — a self-test that proved a different command
# would prove nothing about the one that actually runs.
#
# Usage: sh scripts/gitleaks-scan.sh dir|git <path>
# Exit codes: 0 nothing found, 1 findings, 2 wrong usage, 127 scanner not installed.
set -eu

mode="${1:-}"
path="${2:-}"
case "$mode" in
  dir | git) ;;
  *)
    echo "usage: gitleaks-scan.sh dir|git <path>" >&2
    exit 2
    ;;
esac
if [ -z "$path" ]; then
  echo "usage: gitleaks-scan.sh dir|git <path>" >&2
  exit 2
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed" >&2
  exit 127
fi

# --redact=100 so a finding never reprints the secret into a public log.
exec gitleaks "$mode" "$path" --redact=100 --no-banner --exit-code 1
