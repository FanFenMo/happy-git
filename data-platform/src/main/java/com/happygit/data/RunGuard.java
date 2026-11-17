package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.hadoop.conf.Configuration;
import java.util.concurrent.ConcurrentHashMap;

/** The worker checks its own lease while waiting and immediately before publishing. */
final class RunGuard implements AutoCloseable {
    static final class Cancelled extends Exception { Cancelled(){super("Operator requested cancellation");} }
    private static final ConcurrentHashMap<String,RunGuard> ACTIVE=new ConcurrentHashMap<>();
    private final Configuration conf;
    private final TaskStore store;
    private final ObjectNode task;
    private final String key;
    private RunGuard(Configuration conf,TaskStore store,ObjectNode task) {
        this.conf=conf;this.store=store;this.task=task;key=task.path("token").asText();
        ACTIVE.put(key,this);conf.set("hg.runGuard",key);conf.set("hg.taskId",task.path("id").asText());conf.setInt("hg.taskAttempt",task.path("attempt").asInt());
    }
    static RunGuard open(Configuration conf,TaskStore store,ObjectNode task){return new RunGuard(conf,store,task);}
    static void check(Configuration conf) throws Exception {
        String key=conf.get("hg.runGuard");if(key==null)return;
        RunGuard guard=ACTIVE.get(key);if(guard==null)throw new IllegalStateException("Worker guard is no longer active");
        guard.store.checkClaim(guard.task);
    }
    static void progress(Configuration conf,ObjectNode job) throws Exception {
        String key=conf.get("hg.runGuard");if(key==null)return;RunGuard guard=ACTIVE.get(key);
        if(guard==null)throw new IllegalStateException("Worker guard is no longer active");guard.store.progress(guard.task,"mapreduce-running",job);
    }
    public void close(){ACTIVE.remove(key);for(String field:new String[]{"hg.runGuard","hg.taskId","hg.taskAttempt"})conf.unset(field);}
}
