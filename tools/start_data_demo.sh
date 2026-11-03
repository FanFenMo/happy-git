#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${HG_RUNTIME_ROOT:-/tmp/happygit-runtime/v2}"
java_home="$(find "$runtime_root" -mindepth 1 -maxdepth 1 -type d -name 'jdk-*' | sort | head -n 1)"
demo_root="${1:-/tmp/happygit-demo-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$demo_root"
classpath="$(cat "$repo_dir/data-platform/target/classpath.txt")"
nohup "$java_home/bin/java" -Xmx768m -cp "$repo_dir/data-platform/target/test-classes:$repo_dir/data-platform/target/classes:$classpath" com.happygit.data.LocalDemo "$demo_root" > "$demo_root/console.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$demo_root/pid"
printf '%s\n' "$demo_root"
