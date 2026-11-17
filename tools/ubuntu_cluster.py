"""Render per-host Ubuntu Hadoop configuration. This command never changes remote hosts."""
import argparse
import json
from pathlib import Path
import re
import shlex
import xml.etree.ElementTree as ET


def write_text(path, value):
    with path.open("w", encoding="utf-8", newline="\n") as output:
        output.write(value)


def xml(properties):
    root = ET.Element("configuration")
    for name, value in properties.items():
        prop = ET.SubElement(root, "property")
        ET.SubElement(prop, "name").text = name
        ET.SubElement(prop, "value").text = str(value).lower() if isinstance(value, bool) else str(value)
    if hasattr(ET, "indent"):
        ET.indent(root, space="  ")
    return '<?xml version="1.0"?>\n' + ET.tostring(root, encoding="unicode") + '\n'


def render(inventory, destination):
    nodes = inventory["nodes"]
    if not 2 <= len(nodes) <= 4:
        raise ValueError("Provide 2 to 4 Ubuntu hosts")
    names = [node["name"] for node in nodes]
    if len(set(names)) != len(names) or any(not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name) for name in names):
        raise ValueError("Hostnames must be unique DNS labels")
    for node in nodes:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]+", node["address"]):
            raise ValueError("Invalid host address")
        if not 1024 <= node.get("yarnMemoryMb", 2048) <= 262144 or not 1 <= node.get("vcores", 2) <= 128:
            raise ValueError("Invalid YARN resource budget")
    install, data, user = inventory.get("installRoot", "/opt/happygit"), inventory.get("dataRoot", "/var/lib/happygit"), inventory.get("serviceUser", "happygit")
    if any(not re.fullmatch(r"/[A-Za-z0-9/_-]+", path) or path in ("/", "/opt", "/var", "/var/lib") for path in (install, data)):
        raise ValueError("Use dedicated absolute install and data directories")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", user):
        raise ValueError("Invalid service user")
    ha = len(nodes) >= 3
    mode = "ha-quorum" if ha else "two-host-limited"
    witnesses = names[:3] if ha else names[:1]
    quorum = ",".join(name + ":2181" for name in witnesses)
    hadoop = install + "/runtime/hadoop"
    java = install + "/runtime/java"
    common = {"fs.defaultFS": "hdfs://happygit" if ha else "hdfs://" + names[0] + ":8020",
              "hadoop.tmp.dir": data + "/tmp", "ha.zookeeper.quorum": quorum}
    hdfs = {"dfs.replication": min(3, len(nodes)), "dfs.namenode.name.dir": "file://" + data + "/namenode",
            "dfs.datanode.data.dir": "file://" + data + "/datanode", "dfs.namenode.datanode.registration.ip-hostname-check": False,
            "dfs.namenode.rpc-bind-host": "0.0.0.0", "dfs.namenode.http-bind-host": "0.0.0.0",
            "dfs.client.use.datanode.hostname": True, "dfs.datanode.use.datanode.hostname": True}
    if ha:
        fencing = inventory.get("fencingMethods", "")
        if not fencing or "/bin/true" in fencing or "shell(true)" in fencing:
            raise ValueError("HA requires an actual fencing method; no unconditional-success fencer")
        hdfs.update({"dfs.nameservices": "happygit", "dfs.ha.namenodes.happygit": "nn1,nn2",
                     "dfs.namenode.shared.edits.dir": "qjournal://" + ";".join(h + ":8485" for h in witnesses) + "/happygit",
                     "dfs.journalnode.edits.dir": data + "/journal", "dfs.ha.automatic-failover.enabled": True,
                     "dfs.client.failover.proxy.provider.happygit": "org.apache.hadoop.hdfs.server.namenode.ha.ConfiguredFailoverProxyProvider",
                     "dfs.ha.fencing.methods": fencing, "dfs.ha.fencing.ssh.private-key-files": data + "/.ssh/id_ed25519",
                     "dfs.ha.fencing.ssh.connect-timeout": 10000})
        for number, host in enumerate(names[:2], 1):
            hdfs[f"dfs.namenode.rpc-address.happygit.nn{number}"] = host + ":8020"
            hdfs[f"dfs.namenode.http-address.happygit.nn{number}"] = host + ":9870"
    yarn = {"yarn.nodemanager.aux-services": "mapreduce_shuffle", "yarn.resourcemanager.recovery.enabled": True,
            "yarn.resourcemanager.bind-host": "0.0.0.0", "yarn.nodemanager.bind-host": "0.0.0.0",
            "yarn.application.classpath": ",".join([install + "/conf"] + [hadoop + "/share/hadoop/" + part for part in ("common/*", "common/lib/*", "hdfs/*", "hdfs/lib/*", "yarn/*", "yarn/lib/*")]),
            "yarn.nodemanager.local-dirs": data + "/yarn/local", "yarn.nodemanager.log-dirs": data + "/yarn/logs",
            "yarn.nodemanager.vmem-check-enabled": False,
            "yarn.resourcemanager.work-preserving-recovery.enabled": True, "yarn.resourcemanager.store.class": "org.apache.hadoop.yarn.server.resourcemanager.recovery.ZKRMStateStore",
            "hadoop.zk.address": quorum, "yarn.resourcemanager.zk-address": quorum,
            "yarn.log-aggregation-enable": True, "yarn.nodemanager.remote-app-log-dir": "/happygit/yarn-logs",
            "yarn.scheduler.minimum-allocation-mb": 512, "yarn.scheduler.maximum-allocation-mb": min(n.get("yarnMemoryMb", 2048) for n in nodes),
            "yarn.resourcemanager.am.max-attempts": 4}
    if ha:
        yarn.update({"yarn.resourcemanager.ha.enabled": True, "yarn.resourcemanager.cluster-id": "happygit", "yarn.resourcemanager.ha.rm-ids": "rm1,rm2",
                     "yarn.resourcemanager.ha.automatic-failover.enabled": True, "yarn.resourcemanager.ha.automatic-failover.embedded": True})
        for number, host in enumerate(names[:2], 1):
            yarn[f"yarn.resourcemanager.hostname.rm{number}"] = host
    else:
        yarn["yarn.resourcemanager.hostname"] = names[0]
        for service, port in (("address", 8032), ("scheduler.address", 8030), ("resource-tracker.address", 8031), ("admin.address", 8033), ("webapp.address", 8088)):
            yarn["yarn.resourcemanager." + service] = names[0] + ":" + str(port)
    container_env = f"JAVA_HOME={java},HADOOP_HOME={hadoop},HADOOP_MAPRED_HOME={hadoop}"
    mapred = {"mapreduce.framework.name": "yarn", "mapreduce.application.classpath": hadoop + "/share/hadoop/mapreduce/*," + hadoop + "/share/hadoop/mapreduce/lib/*",
              "yarn.app.mapreduce.am.env": container_env,
              "mapreduce.map.env": container_env, "mapreduce.reduce.env": container_env,
              "mapreduce.map.memory.mb": 512, "mapreduce.reduce.memory.mb": 512,
              "mapreduce.map.java.opts": "-Xmx384m", "mapreduce.reduce.java.opts": "-Xmx384m",
              "yarn.app.mapreduce.am.resource.mb": 512, "yarn.app.mapreduce.am.command-opts": "-Xmx384m",
              "mapreduce.map.maxattempts": 4, "mapreduce.reduce.maxattempts": 4,
              "mapreduce.am.max-attempts": 4, "mapreduce.map.speculative": False, "mapreduce.reduce.speculative": False,
              "mapreduce.jobhistory.address": names[0] + ":10020", "mapreduce.jobhistory.webapp.address": names[0] + ":19888",
              "mapreduce.jobhistory.bind-host": "0.0.0.0", "mapreduce.shuffle.port": 13562,
              "yarn.app.mapreduce.am.job.client.port-range": "51000-51099", "yarn.app.mapreduce.am.webapp.port-range": "51100-51199"}
    capacity = {"yarn.scheduler.capacity.root.queues": "default", "yarn.scheduler.capacity.root.default.capacity": 100,
                "yarn.scheduler.capacity.root.default.maximum-capacity": 100, "yarn.scheduler.capacity.maximum-am-resource-percent": 0.5}
    for index, node in enumerate(nodes):
        folder = destination / node["name"]
        folder.mkdir(parents=True, exist_ok=True)
        node_yarn = dict(yarn, **{"yarn.nodemanager.hostname": node["name"], "yarn.nodemanager.address": node["name"] + ":8041",
                               "yarn.nodemanager.localizer.address": node["name"] + ":8040", "yarn.nodemanager.webapp.address": node["name"] + ":8042",
                               "yarn.nodemanager.resource.memory-mb": node.get("yarnMemoryMb", 2048), "yarn.nodemanager.resource.cpu-vcores": node.get("vcores", 2)})
        if ha and index < 2:
            node_yarn["yarn.resourcemanager.ha.id"] = f"rm{index + 1}"
        node_hdfs = dict(hdfs, **{"dfs.datanode.hostname": node["name"]})
        for filename, props in (("core-site.xml", common), ("hdfs-site.xml", node_hdfs), ("yarn-site.xml", node_yarn), ("mapred-site.xml", mapred), ("capacity-scheduler.xml", capacity)):
            write_text(folder / filename, xml(props))
        write_text(folder / "hadoop-env.sh", f'export JAVA_HOME={shlex.quote(java)}\nexport HADOOP_HEAPSIZE_MAX=384\nexport HADOOP_LOG_DIR={shlex.quote(data + "/logs")}\n')
        roles = ["datanode", "nodemanager", "collector", "console"]
        if (ha and index < 2) or (not ha and index == 0):
            roles += ["namenode", "resourcemanager"]
            if ha:
                roles += ["zkfc"]
        if node["name"] in witnesses:
            roles += ["zookeeper"]
            if ha:
                roles += ["journalnode"]
        if index == 0:
            roles += ["historyserver"]
        write_text(folder / "roles.json", json.dumps({"mode": mode, "roles": roles, "node": node}, indent=2))
        zk = ["tickTime=2000", f"dataDir={data}/zookeeper", "clientPort=2181", "admin.enableServer=false", "initLimit=10", "syncLimit=5", "autopurge.snapRetainCount=3", "autopurge.purgeInterval=1", "4lw.commands.whitelist=ruok,srvr,mntr"]
        if ha:
            zk += [f"server.{i+1}={host}:2888:3888" for i, host in enumerate(witnesses)]
        write_text(folder / "zoo.cfg", "\n".join(zk) + "\n")
        write_text(folder / "myid", str(index + 1) + "\n")
        env = f'JAVA_HOME={java}\nHADOOP_HOME={hadoop}\nHADOOP_CONF_DIR={install}/conf\nHG_DATA_ROOT=/happygit/data\nHG_ZK_CONNECT={quorum}\nHG_CLUSTER_MODE={mode}\nHG_CLUSTER_NODE_COUNT={len(nodes)}\n'
        write_text(folder / "platform.env.example", env + "# Copy to platform.env (0600), then set shared HG_ZK_AUTH=user:password\n# HG_ADMIN_TOKEN=<random string, at least 24 chars>\n# GITHUB_TOKEN=<this operator's GitHub token>\n# HG_GITHUB_RATE_SCOPE=<GitHub login; same account must use the same scope>\n")
        for role in roles:
            if role == "collector":
                command = f"{install}/bin/data-platform worker --id {node['name']}"
            elif role == "console":
                command = f"{install}/bin/data-platform serve --bind 127.0.0.1 --port 8090"
            elif role == "zookeeper":
                command = f"{install}/bin/data-platform-zookeeper"
            else:
                executable = "hdfs" if role in ("namenode", "datanode", "journalnode", "zkfc") else "mapred" if role == "historyserver" else "yarn"
                command = f"{hadoop}/bin/{executable} {role}"
            restart = "always" if role == "collector" else "on-failure"
            unit = f"[Unit]\nDescription=HappyGit {role}\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser={user}\nEnvironmentFile={install}/conf/platform.env\nWorkingDirectory={data}\nExecStart={command}\nRestart={restart}\nRestartSec=5\nLimitNOFILE=65536\n[Install]\nWantedBy=multi-user.target\n"
            write_text(folder / f"happygit-{role}.service", unit)
    write_text(destination / "hosts.entries", "".join(f"{node['address']} {node['name']}\n" for node in nodes))
    summary = {"clusterName": inventory.get("clusterName", "happygit"), "mode": mode, "nodes": nodes,
               "quorumHosts": witnesses, "controlPlaneAutomaticFailover": ha, "replication": min(3, len(nodes)),
               "requirements": ["majority of quorum hosts online", "reachable data replicas", "remaining YARN capacity", "working NameNode fencing", "resolvable hostnames and synchronized clocks"]}
    write_text(destination / "cluster-plan.json", json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    render(json.loads(Path(args.inventory).read_text(encoding="utf-8")), destination)


if __name__ == "__main__":
    main()
