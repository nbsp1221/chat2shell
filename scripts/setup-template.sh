#!/usr/bin/env bash
set -euo pipefail

template="chat2shell-codexpro:0.30.0"

if sbx template ls --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const requested = process.argv[1].replace(/^docker\.io\/library\//, "");
  const found = JSON.parse(input).images.some((image) => `${image.repository}:${image.tag}`.replace(/^docker\.io\/library\//, "") === requested);
  process.exit(found ? 0 : 1);
});
' "$template"; then
  printf 'Sandbox template already exists: %s\n' "$template"
  exit 0
fi

bootstrap_dir="$(mktemp -d /tmp/chat2shell-template.XXXXXX)"
bootstrap_name="c2s-template-$(date +%s)"
cleanup() {
  sbx rm --force "$bootstrap_name" >/dev/null 2>&1 || true
  gio trash "$bootstrap_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sbx create --quiet --name "$bootstrap_name" --cpus 1 --memory 2g shell "$bootstrap_dir"
sbx exec -u root "$bootstrap_name" npm install --global --omit=dev "codexpro@0.30.0"
sbx stop "$bootstrap_name"
sbx template save "$bootstrap_name" "$template"
printf 'Created sandbox template: %s\n' "$template"
