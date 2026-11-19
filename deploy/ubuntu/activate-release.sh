#!/usr/bin/env bash
# Switch only the current code link; use the same command for rollback. No service restart.
set -euo pipefail
[[ "$EUID" -eq 0 && "$#" -eq 3 ]] || { printf '%s\n' 'Usage: sudo activate-release.sh INSTALL_ROOT RELEASE_ID NODE'; exit 1; }
install_root="$(realpath "$1")"; release_id="$2"; node="$3"
[[ "$install_root" == /opt/* && "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$ && "$node" =~ ^[a-z][a-z0-9-]{0,62}$ ]]
target="$install_root/releases/$release_id"
python3 "$target/tools/server_release.py" verify --release "$target"
config="$target/nodes/$node"
python3 - "$config/roles.json" "$install_root" <<'PY'
import json,sys
config=json.load(open(sys.argv[1]))
if config['installRoot'] != sys.argv[2]: raise SystemExit('Release install root differs from the selected root')
PY
[[ ! -e "$install_root/current" || -L "$install_root/current" ]]
previous="$(readlink "$install_root/current" || true)"
python3 - "$target/release-manifest.json" "$config/roles.json" "$install_root/conf/release.env" <<'PY'
import hashlib,json,pathlib,sys
release=json.load(open(sys.argv[1])); config=pathlib.Path(sys.argv[2])
value='HG_RELEASE_ID='+release['releaseId']+'\nHG_SOURCE_COMMIT='+release['sourceCommit']+'\nHG_NODE_CONFIG_SHA256='+hashlib.sha256(config.read_bytes()).hexdigest()+'\n'
pathlib.Path(sys.argv[3]).write_text(value)
PY
backup="$install_root/configuration-backups/$release_id-$$"
install -d -m 0750 "$backup"
for file in core-site.xml hdfs-site.xml yarn-site.xml mapred-site.xml capacity-scheduler.xml hadoop-env.sh zoo.cfg; do
    [[ ! -e "$install_root/conf/$file" ]] || cp -a "$install_root/conf/$file" "$backup/$file"
    install -m 0644 "$config/$file" "$install_root/conf/$file"
done
shopt -s nullglob
for unit in "$config"/happygit-*.service "$config"/happygit-*.timer; do install -m 0644 "$unit" /etc/systemd/system/; done
next="$install_root/.current-$release_id-$$"
ln -s "$target" "$next"
mv -Tf "$next" "$install_root/current"
systemctl daemon-reload
install -d -m 0750 "$install_root/release-events"
python3 - "$install_root/release-events" "$release_id" "$previous" "$node" "$backup" <<'PY'
import datetime,json,pathlib,sys,uuid
record={'releaseId':sys.argv[2],'previousTarget':sys.argv[3],'node':sys.argv[4],'configurationBackup':sys.argv[5],'changedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'servicesRestarted':False}
(pathlib.Path(sys.argv[1])/(uuid.uuid4().hex+'.json')).write_text(json.dumps(record,indent=2)+'\n')
PY
printf '%s\n' "Current code now points to $release_id. Restart only the intended services when ready."
