#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${CHAT2SHELL_STATE_DIR:-/home/retn0/.chat2shell/state}"
pid_file="$state_dir/runtime.pid"

if [[ ! -f "$pid_file" ]]; then
  printf 'chat2shell is not running.\n'
  exit 0
fi

runtime_pid="$(tr -d '\r\n' < "$pid_file")"
if [[ ! "$runtime_pid" =~ ^[0-9]+$ ]]; then
  printf 'Invalid runtime PID file.\n' >&2
  exit 1
fi

cmdline="$(tr '\0' ' ' < "/proc/$runtime_pid/cmdline" 2>/dev/null || true)"
process_cwd="$(readlink -f "/proc/$runtime_pid/cwd" 2>/dev/null || true)"
if [[ "$process_cwd" != "$project_root" ]] || [[ "$cmdline" != *"scripts/run.sh"* ]]; then
  printf 'PID %s is not this chat2shell runtime; refusing to stop it.\n' "$runtime_pid" >&2
  exit 1
fi

kill -TERM "$runtime_pid"
for _ in {1..100}; do
  if ! kill -0 "$runtime_pid" 2>/dev/null; then
    printf 'chat2shell stopped.\n'
    exit 0
  fi
  sleep 0.1
done

printf 'chat2shell did not stop within 10 seconds.\n' >&2
exit 1
