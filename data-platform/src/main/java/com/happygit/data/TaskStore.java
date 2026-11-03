package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.zookeeper.*;
import org.apache.zookeeper.data.ACL;
import org.apache.zookeeper.data.Stat;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Version-fenced tasks; ephemeral leases are owned by a ZooKeeper session. */
public final class TaskStore implements AutoCloseable {
    private final ZooKeeper zk;
    private final String root;
    private final List<ACL> acl;
    private volatile boolean expired;

    public TaskStore(String connect, String root, int timeoutMs, String digestAuth) throws Exception {
        if (!root.matches("/[A-Za-z0-9/_-]+") || root.endsWith("/")) throw new IllegalArgumentException("Invalid ZK root");
        this.root = root;
        CountDownLatch ready = new CountDownLatch(1);
        zk = new ZooKeeper(connect, timeoutMs, event -> {
            if (event.getState() == Watcher.Event.KeeperState.SyncConnected) ready.countDown();
            if (event.getState() == Watcher.Event.KeeperState.Expired) expired = true;
        });
        if (!ready.await(timeoutMs * 2L, TimeUnit.MILLISECONDS)) { zk.close(); throw new IllegalStateException("ZooKeeper unavailable"); }
        if (digestAuth != null && !digestAuth.isBlank()) {
            zk.addAuthInfo("digest", digestAuth.getBytes(StandardCharsets.UTF_8));
            acl = ZooDefs.Ids.CREATOR_ALL_ACL;
        } else acl = ZooDefs.Ids.OPEN_ACL_UNSAFE; // local development only; production sets HG_ZK_AUTH
        String current = "";
        for (String segment : root.substring(1).split("/")) { current += "/" + segment; ensure(current); }
        for (String name : Arrays.asList("tasks", "commits", "workers", "publications")) ensure(root + "/" + name);
    }
    private void ensure(String path) throws Exception {
        try { zk.create(path, new byte[0], acl, CreateMode.PERSISTENT); }
        catch (KeeperException.NodeExistsException exists) { /* idempotent namespace initialization */ }
    }
    public boolean expired() { return expired; }
    public String enqueue(String type, String namespace, String target, ObjectNode input, String requestId) throws Exception {
        Json.requireId(namespace);
        String id = Json.sha256((namespace + "\n" + type + "\n" + target + "\n" + requestId).getBytes(StandardCharsets.UTF_8));
        ObjectNode task = Json.object().put("id", id).put("type", type).put("namespace", namespace)
                .put("target", target).put("state", "queued").put("attempt", 0)
                .put("createdAt", System.currentTimeMillis()).put("retryAt", 0L);
        task.set("input", input);
        try { zk.create(root + "/tasks/" + id, Json.bytes(task), acl, CreateMode.PERSISTENT); }
        catch (KeeperException.NodeExistsException exists) {
            ObjectNode old = get(id);
            if (!old.path("input").equals(input)) throw new IllegalArgumentException("Request identity reused with different input");
        }
        return id;
    }
    public ObjectNode get(String id) throws Exception {
        return Json.parse(new String(zk.getData(root + "/tasks/" + Json.requireId(id), false, null), StandardCharsets.UTF_8));
    }
    public List<ObjectNode> list() throws Exception {
        List<ObjectNode> result = new ArrayList<>();
        for (String id : zk.getChildren(root + "/tasks", false)) result.add(get(id));
        result.sort(Comparator.comparingLong(a -> a.path("createdAt").asLong()));
        return result;
    }
    public void registerWorker(String workerId, ObjectNode metadata) throws Exception {
        zk.create(root + "/workers/" + Json.requireId(workerId), Json.bytes(metadata), acl, CreateMode.EPHEMERAL);
    }
    public List<ObjectNode> workers() throws Exception {
        List<ObjectNode> result = new ArrayList<>();
        for (String child : zk.getChildren(root + "/workers", false)) {
            try { result.add(Json.parse(new String(zk.getData(root + "/workers/" + child, false, null), StandardCharsets.UTF_8))); }
            catch (KeeperException.NoNodeException gone) { /* worker left during inventory */ }
        }
        return result;
    }
    public ObjectNode claim(String id, String workerId) throws Exception {
        String path = root + "/tasks/" + Json.requireId(id);
        Stat stat = new Stat();
        ObjectNode task = Json.parse(new String(zk.getData(path, false, stat), StandardCharsets.UTF_8));
        if (Arrays.asList("succeeded", "failed", "cancelled").contains(task.path("state").asText()))
            return null;
        if (task.path("retryAt").asLong() > System.currentTimeMillis() || zk.exists(path + "/lease", false) != null) return null;
        String token = UUID.randomUUID().toString();
        task.put("owner", workerId).put("token", token).put("state", "running")
                .put("attempt", task.path("attempt").asInt() + 1).put("startedAt", System.currentTimeMillis());
        try {
            zk.multi(Arrays.asList(Op.check(path, stat.getVersion()),
                    Op.create(path + "/lease", token.getBytes(StandardCharsets.UTF_8), acl, CreateMode.EPHEMERAL),
                    Op.setData(path, Json.bytes(task), stat.getVersion())));
            return task;
        } catch (KeeperException.BadVersionException | KeeperException.NodeExistsException raced) { return null; }
    }
    private Stat owned(ObjectNode claim, String path) throws Exception {
        Stat stat = new Stat();
        ObjectNode current = Json.parse(new String(zk.getData(path, false, stat), StandardCharsets.UTF_8));
        byte[] lease = zk.getData(path + "/lease", false, null);
        if (!current.path("token").equals(claim.path("token")) ||
                !new String(lease, StandardCharsets.UTF_8).equals(claim.path("token").asText()))
            throw new IllegalStateException("Task ownership changed");
        return stat;
    }
    public void finish(ObjectNode claim, ObjectNode result) throws Exception {
        String path = root + "/tasks/" + claim.path("id").asText();
        Stat stat = owned(claim, path);
        ObjectNode completed = claim.deepCopy().put("state", "succeeded").put("finishedAt", System.currentTimeMillis());
        completed.set("result", result);
        List<Op> ops = new ArrayList<>();
        ops.add(Op.check(path, stat.getVersion()));
        ops.add(Op.check(path + "/lease", 0));
        ops.add(Op.create(root + "/commits/" + claim.path("id").asText(), Json.bytes(completed), acl, CreateMode.PERSISTENT));
        if (claim.path("type").asText().equals("process")) {
            String publication = root + "/publications/" + claim.path("namespace").asText();
            Stat previous = new Stat();
            ObjectNode pointer = Json.object().put("createdAt", claim.path("createdAt").asLong());
            pointer.set("result", result);
            try {
                ObjectNode old = Json.parse(new String(zk.getData(publication, false, previous), StandardCharsets.UTF_8));
                if (old.path("result").path("referenceTime").asLong() <= result.path("referenceTime").asLong()
                        && old.path("createdAt").asLong() <= claim.path("createdAt").asLong())
                    ops.add(Op.setData(publication, Json.bytes(pointer), previous.getVersion()));
            } catch (KeeperException.NoNodeException first) {
                ops.add(Op.create(publication, Json.bytes(pointer), acl, CreateMode.PERSISTENT));
            }
        }
        ops.add(Op.setData(path, Json.bytes(completed), stat.getVersion()));
        ops.add(Op.delete(path + "/lease", 0));
        zk.multi(ops); // task fence prevents an expired owner from publishing after a takeover
    }
    public void retry(ObjectNode claim, String reason, long retryAt, boolean permanent) throws Exception {
        String path = root + "/tasks/" + claim.path("id").asText();
        Stat stat = owned(claim, path);
        ObjectNode next = claim.deepCopy().put("state", permanent || claim.path("attempt").asInt() >= 8 ? "failed" : "queued")
                .put("error", reason).put("retryAt", retryAt);
        zk.multi(Arrays.asList(Op.check(path, stat.getVersion()), Op.setData(path, Json.bytes(next), stat.getVersion()), Op.delete(path + "/lease", 0)));
    }
    public List<ObjectNode> committed(String namespace) throws Exception {
        List<ObjectNode> results = new ArrayList<>();
        for (String id : zk.getChildren(root + "/commits", false)) {
            ObjectNode item = Json.parse(new String(zk.getData(root + "/commits/" + id, false, null), StandardCharsets.UTF_8));
            if (item.path("namespace").asText().equals(namespace)) results.add(item);
        }
        results.sort(Comparator.comparing(a -> a.path("id").asText()));
        return results;
    }
    @Override public void close() throws InterruptedException { zk.close(); }
}
