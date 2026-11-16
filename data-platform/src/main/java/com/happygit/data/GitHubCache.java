package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Only publicly visible GitHub payloads may be persisted in this HTTP cache. */
final class GitHubCache {
    private final TaskStore store;private final Configuration conf;private final HdfsFiles files;
    GitHubCache(TaskStore store,Configuration conf,String root){this.store=store;this.conf=conf;this.files=new HdfsFiles(conf,root);}
    ObjectNode read(String route)throws Exception {
        ObjectNode pointer=store.observation("http-"+Json.sha256(route.getBytes(StandardCharsets.UTF_8)));
        if(pointer==null)return null;return HdfsFiles.readJsonLines(conf,new Path(pointer.path("path").asText())).get(0);
    }
    void write(String route,ObjectNode value)throws Exception {
        String key="http-"+Json.sha256(route.getBytes(StandardCharsets.UTF_8));
        store.observe(key,files.write("http-cache",key,UUID.randomUUID().toString(),Collections.singletonList(value)));
    }
}
