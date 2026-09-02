#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user_home="${HOME:?HOME must be set}"
state_dir="${CHAT2SHELL_STATE_DIR:-$user_home/.chat2shell/state}"
secret_dir="${CHAT2SHELL_SECRET_DIR:-$user_home/.secrets/tunnel-client}"
tunnel_client="${CHAT2SHELL_TUNNEL_CLIENT:-$user_home/.local/bin/tunnel-client}"
listen_host="${CHAT2SHELL_HOST:-127.0.0.1}"
gateway_port="${CHAT2SHELL_PORT:-18788}"
enable_tunnel="${CHAT2SHELL_ENABLE_TUNNEL:-1}"
pid_file="$state_dir/runtime.pid"

mkdir -p "$state_dir"
chmod 700 "$state_dir"

if [[ ! -f "$project_root/dist/src/mcp/main.js" ]]; then
  printf 'Build output is missing. Run pnpm install && pnpm build first.\n' >&2
  exit 1
fi

if [[ -f "$pid_file" ]]; then
  existing_pid="$(tr -d '\r\n' < "$pid_file")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    printf 'chat2shell is already running with PID %s.\n' "$existing_pid" >&2
    exit 1
  fi
fi

if [[ "$enable_tunnel" == "1" ]]; then
  for required_file in "$secret_dir/key" "$secret_dir/tunnel-id" "$tunnel_client"; do
    if [[ ! -e "$required_file" ]]; then
      printf 'Missing required runtime dependency: %s\n' "$required_file" >&2
      exit 1
    fi
  done
fi

gateway_pid=""
tunnel_pid=""
cleanup() {
  for child_pid in "$tunnel_pid" "$gateway_pid"; do
    if [[ -n "$child_pid" ]]; then
      kill -TERM "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
  done
  unlink "$pid_file" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf '%s\n' "$$" > "$pid_file"
chmod 600 "$pid_file"
unlink "$state_dir/health.url" 2>/dev/null || true

CHAT2SHELL_HOST="$listen_host" CHAT2SHELL_PORT="$gateway_port" \
  node "$project_root/dist/src/mcp/main.js" >"$state_dir/gateway.log" 2>&1 &
gateway_pid="$!"

gateway_ready="0"
for _ in {1..300}; do
  if curl --fail --silent "http://${listen_host}:${gateway_port}/healthz" >/dev/null 2>&1; then
    gateway_ready="1"
    break
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    printf 'chat2shell exited during startup. See %s/gateway.log\n' "$state_dir" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$gateway_ready" != "1" ]]; then
  printf 'chat2shell did not become healthy within 30 seconds. See %s/gateway.log\n' "$state_dir" >&2
  exit 1
fi

printf 'chat2shell ready: http://%s:%s/mcp\n' "$listen_host" "$gateway_port"
if [[ "$enable_tunnel" != "1" ]]; then
  printf 'Tunnel disabled; local runtime is ready.\n'
  wait "$gateway_pid"
  exit 0
fi

tunnel_id="$(tr -d '\r\n' < "$secret_dir/tunnel-id")"
if [[ -z "$tunnel_id" ]]; then
  printf 'Tunnel ID file is empty.\n' >&2
  exit 1
fi

"$tunnel_client" run \
  --mcp.server-url "http://${listen_host}:${gateway_port}/mcp" \
  --control-plane.api-key "file:${secret_dir}/key" \
  --control-plane.tunnel-id "$tunnel_id" \
  --health.listen-addr 127.0.0.1:0 \
  --health.url-file "$state_dir/health.url" \
  --log.file "$state_dir/tunnel-client.log" &
tunnel_pid="$!"
wait "$tunnel_pid"
