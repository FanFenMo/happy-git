#!/usr/bin/env bash
# Stage one explicit node release; preserve data and private settings; do not start services.
set -euo pipefail
[[ "$EUID" -eq 0 && "$#" -ge 4 && "$#" -le 5 ]] || { printf '%s\n' 'Usage: sudo install-release.sh RELEASE_DIR NODE HADOOP_DIR JAVA11_DIR [JAVA17_DIR]'; exit 1; }
release="$(realpath "$1")"; node="$2"; hadoop="$(realpath "$3")"; java11="$(realpath "$4")"
python3 "$release/tools/server_release.py" verify --release "$release"
config="$release/nodes/$node"
readarray -t settings < <(python3 - "$config/roles.json" "$release/release-manifest.json" <<'PY'
import json,sys
node=json.load(open(sys.argv[1])); release=json.load(open(sys.argv[2]))
for value in (node['installRoot'],node['dataRoot'],node['serviceUser'],release['releaseId'],(node.get('api') or {}).get('envFile','/etc/happygit/cloud.env'),bool(node.get('api'))): print(value)
PY
)
install_root="${settings[0]}"; data_root="${settings[1]}"; service_user="${settings[2]}"; release_id="${settings[3]}"
[[ "$install_root" == /opt/* && "$data_root" == /var/lib/* && -x "$hadoop/bin/hadoop" && -x "$java11/bin/java" ]]
if [[ "${settings[5]}" == True ]]; then [[ "$#" -eq 5 && -x "$5/bin/java" ]]; fi
id "$service_user" >/dev/null 2>&1 || useradd --system --home-dir "$data_root" --shell /bin/bash "$service_user"
install -d -m 0755 "$install_root" "$install_root/releases" "$install_root/bin" "$install_root/conf" "$install_root/runtime"
install -d -o "$service_user" -g "$service_user" -m 0750 "$data_root"
for child in namenode datanode journal zookeeper tmp logs yarn operations; do install -d -o "$service_user" -g "$service_user" -m 0750 "$data_root/$child"; done
target="$install_root/releases/$release_id"
if [[ -e "$target" ]]; then python3 "$target/tools/server_release.py" verify --release "$target"; cmp "$release/release-manifest.json" "$target/release-manifest.json"; else cp -a "$release" "$target"; fi
install -m 0755 "$target/data-platform/bin/data-platform" "$target/data-platform/bin/data-platform-zookeeper" "$install_root/bin/"
for file in core-site.xml hdfs-site.xml yarn-site.xml mapred-site.xml capacity-scheduler.xml hadoop-env.sh zoo.cfg; do [[ -e "$install_root/conf/$file" ]] || install -m 0644 "$config/$file" "$install_root/conf/$file"; done
[[ -e "$install_root/runtime/hadoop" ]] || ln -s "$hadoop" "$install_root/runtime/hadoop"
[[ -e "$install_root/runtime/java" ]] || ln -s "$java11" "$install_root/runtime/java"
if [[ "$#" -eq 5 ]]; then [[ -e "$install_root/runtime/java17" ]] || ln -s "$(realpath "$5")" "$install_root/runtime/java17"; fi
[[ -e "$install_root/conf/platform.env" ]] || install -m 0640 -g "$service_user" "$config/platform.env.example" "$install_root/conf/platform.env"
[[ -e "$data_root/zookeeper/myid" ]] || install -o "$service_user" -g "$service_user" -m 0640 "$config/myid" "$data_root/zookeeper/myid"
if [[ -f "$config/learning-batch.example.json" && ! -e "$install_root/conf/learning-batch.json" ]]; then install -m 0640 -g "$service_user" "$config/learning-batch.example.json" "$install_root/conf/learning-batch.json"; fi
if [[ "${settings[5]}" == True && ! -e "${settings[4]}" ]]; then install -d -m 0750 -g "$service_user" "$(dirname "${settings[4]}")"; install -m 0640 -g "$service_user" "$config/cloud.env.example" "${settings[4]}"; fi
printf '%s\n' "Staged $release_id for $node. Existing data/private settings are preserved. Select the release explicitly, then start only the intended units."
