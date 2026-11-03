#!/usr/bin/env bash
# Explicit installation on the intended Ubuntu host; does not format/start services.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then printf '%s\n' 'Run with sudo on the intended host.' >&2; exit 1; fi
if [[ "$#" -ne 4 ]]; then printf '%s\n' 'Usage: install-node.sh NODE_CONFIG_DIR PLATFORM_JAR HADOOP_DIR JAVA_DIR' >&2; exit 1; fi
source /etc/os-release
if [[ "$ID" != ubuntu ]]; then printf '%s\n' 'This installer targets Ubuntu.' >&2; exit 1; fi
node_config="$(realpath "$1")"
platform_jar="$(realpath "$2")"
hadoop_runtime="$(realpath "$3")"
java_runtime="$(realpath "$4")"
[[ -f "$node_config/roles.json" && -f "$platform_jar" && -x "$hadoop_runtime/bin/hadoop" && -x "$java_runtime/bin/java" ]]
readarray -t settings < <(python3 - "$node_config/platform.env.example" <<'PY'
import sys
values = dict(line.strip().split('=', 1) for line in open(sys.argv[1]) if '=' in line and not line.startswith('#'))
print(values['HADOOP_CONF_DIR'].rsplit('/conf', 1)[0])
PY
)
install_root="${settings[0]}"
service_user="$(sed -n 's/^User=//p' "$node_config/happygit-collector.service")"
data_root="$(sed -n 's/^WorkingDirectory=//p' "$node_config/happygit-collector.service")"
[[ "$install_root" == /opt/* && "$data_root" == /var/lib/* && "$service_user" =~ ^[a-z][a-z0-9_-]*$ ]]
id "$service_user" >/dev/null 2>&1 || useradd --system --home-dir "$data_root" --shell /bin/bash "$service_user"
install -d -m 0755 "$install_root" "$install_root/bin" "$install_root/conf" "$install_root/runtime"
install -d -o "$service_user" -g "$service_user" -m 0750 "$data_root"
for child in namenode datanode journal zookeeper tmp logs; do install -d -o "$service_user" -g "$service_user" -m 0750 "$data_root/$child"; done
install -m 0644 "$platform_jar" "$install_root/happygit-data-platform.jar"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install -m 0755 "$repo_root/data-platform/bin/data-platform" "$repo_root/data-platform/bin/data-platform-zookeeper" "$install_root/bin/"
for file in core-site.xml hdfs-site.xml yarn-site.xml mapred-site.xml hadoop-env.sh zoo.cfg; do install -m 0644 "$node_config/$file" "$install_root/conf/$file"; done
if [[ ! -e "$install_root/runtime/hadoop" ]]; then ln -s "$hadoop_runtime" "$install_root/runtime/hadoop"; fi
if [[ ! -e "$install_root/runtime/java" ]]; then ln -s "$java_runtime" "$install_root/runtime/java"; fi
if [[ ! -e "$install_root/conf/platform.env" ]]; then install -m 0640 -g "$service_user" "$node_config/platform.env.example" "$install_root/conf/platform.env"; fi
install -o "$service_user" -g "$service_user" -m 0640 "$node_config/myid" "$data_root/zookeeper/myid"
for unit in "$node_config"/happygit-*.service; do install -m 0644 "$unit" /etc/systemd/system/; done
systemctl daemon-reload
printf '%s\n' 'Installed. Configure private DNS/hosts, shared credentials, and working fencing before initializing and starting the roles.'
