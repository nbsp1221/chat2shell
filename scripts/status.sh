#!/usr/bin/env bash
set -euo pipefail

state_dir="${CHAT2SHELL_STATE_DIR:-/home/retn0/.chat2shell/state}"
pid_file="$state_dir/runtime.pid"

if [[ ! -f "$pid_file" ]]; then
  printf 'stopped\n'
  exit 1
fi

runtime_pid="$(tr -d '\r\n' < "$pid_file")"
if [[ ! "$runtime_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$runtime_pid" 2>/dev/null; then
  printf 'stale PID file\n' >&2
  exit 1
fi

printf 'runtime PID: %s\n' "$runtime_pid"
if [[ -f "$state_dir/health.url" ]]; then
  health_url="$(tr -d '\r\n' < "$state_dir/health.url")"
  printf 'health: '
  curl --fail --silent --show-error "$health_url/healthz"
  printf '\nready: '
  curl --fail --silent --show-error "$health_url/readyz"
  printf '\nadmin UI: %s/ui\n' "$health_url"
else
  printf 'tunnel: disabled\n'
fi
