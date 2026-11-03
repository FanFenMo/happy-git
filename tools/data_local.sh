#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${HG_RUNTIME_ROOT:-/tmp/happygit-runtime/v2}"
export JAVA_HOME="$(find "$runtime_root" -mindepth 1 -maxdepth 1 -type d -name 'jdk-*' | sort | head -n 1)"
export PATH="$JAVA_HOME/bin:$PATH"
maven="$runtime_root/apache-maven-3.9.11/bin/mvn"
case "${1:-build}" in
  build) "$maven" -B -f "$repo_dir/data-platform/pom.xml" -DskipTests package ;;
  test) "$maven" -B -f "$repo_dir/data-platform/pom.xml" test ;;
  classpath) "$maven" -B -f "$repo_dir/data-platform/pom.xml" dependency:build-classpath -Dmdep.outputFile="$repo_dir/data-platform/target/classpath.txt" ;;
  *) printf '%s\n' 'Usage: data_local.sh build|test|classpath' >&2; exit 1 ;;
esac
