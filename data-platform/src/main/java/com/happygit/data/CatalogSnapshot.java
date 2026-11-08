package com.happygit.data;

import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

/** Freezes real public records with README and the committed source descriptors. */
final class CatalogSnapshot {
    private final TaskStore store;private final Configuration conf;
    CatalogSnapshot(TaskStore store,Configuration conf){this.store=store;this.conf=conf;}
    ObjectNode freeze(String namespace)throws Exception {
        Map<String,ObjectNode> latest=new TreeMap<>();ArrayNode sources=Json.MAPPER.createArrayNode();
        for(ObjectNode task:store.committed(namespace))if(task.path("type").asText().equals("repository")){
            for(ObjectNode row:HdfsFiles.readJsonLines(conf,new Path(task.path("result").path("path").asText()))){
                String id=row.path("repoId").asText();ObjectNode old=latest.get(id);
                if(old==null||row.path("observedAt").asLong()>old.path("observedAt").asLong())latest.put(id,row);
            }
            ObjectNode source=Json.object().put("taskId",task.path("id").asText()).put("target",task.path("target").asText());source.set("archive",task.path("result"));source.set("input",task.path("input"));sources.add(source);
        }
        latest.values().removeIf(row->!row.path("visibility").asText().equals("public"));
        ObjectNode result=Json.object().put("sourceKind","github_public").put("namespace",namespace).put("frozenAt",System.currentTimeMillis()).put("repositoryCount",latest.size());
        result.set("sources",sources);result.set("records",Json.MAPPER.valueToTree(latest.values()));return result;
    }
    ObjectNode export(String namespace,java.nio.file.Path output)throws Exception {
        ObjectNode frozen=freeze(namespace);StringBuilder data=new StringBuilder();for(com.fasterxml.jackson.databind.JsonNode row:frozen.path("records"))data.append(row).append('\n');
        byte[] bytes=data.toString().getBytes(StandardCharsets.UTF_8);String digest=Json.sha256(bytes);
        frozen.remove("records");frozen.put("sha256",digest).put("bytes",bytes.length).put("catalogSnapshotId",digest);
        java.nio.file.Path manifest=output.resolveSibling(output.getFileName()+".manifest.json");
        if(Files.exists(output)||Files.exists(manifest))throw new IllegalArgumentException("Catalog output or manifest already exists");
        if(output.toAbsolutePath().getParent()!=null)Files.createDirectories(output.toAbsolutePath().getParent());
        Files.write(output,bytes,java.nio.file.StandardOpenOption.CREATE_NEW);
        Files.writeString(manifest,frozen.toPrettyString()+"\n",StandardCharsets.UTF_8,java.nio.file.StandardOpenOption.CREATE_NEW);
        return frozen;
    }
}
