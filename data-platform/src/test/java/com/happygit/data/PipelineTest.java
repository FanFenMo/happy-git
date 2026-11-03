package com.happygit.data;

import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class PipelineTest {
    @TempDir java.nio.file.Path directory;
    @Test void fullFrozenPipelineDeduplicatesEventsBuildsProfilesAndRecall()throws Exception{
        long now=1700000000000L;List<ObjectNode> rows=new ArrayList<>();
        for(int i=1;i<=3;i++){
            ObjectNode repo=Json.object().put("kind","repository").put("repoId",Integer.toString(i)).put("name","storage engine "+i)
                    .put("fullName","example/project"+i).put("description","distributed storage database engine").put("readmeText","storage database documentation")
                    .put("primaryLanguage","Java").put("visibility","public").put("observedAt",now-1000).put("isArchived",false).put("starCount",100*i).put("pushedAt",now-2000);
            repo.putArray("topics").add("database");rows.add(repo);
        }
        rows.add(Json.object().put("kind","subject").put("subjectId","A"));
        rows.add(Json.object().put("kind","subject").put("subjectId","empty"));
        ObjectNode event=Json.object().put("kind","event").put("eventId","event-1").put("subjectId","A").put("repoId","1").put("occurredAt",now-5000).put("source","browse");
        rows.add(event);rows.add(event.deepCopy());
        StringBuilder content=new StringBuilder();for(ObjectNode row:rows)content.append(row).append('\n');
        java.nio.file.Path file=directory.resolve("source.jsonl");Files.writeString(file,content.toString(),StandardCharsets.UTF_8);
        ObjectNode manifest=Json.object().put("referenceTime",now).put("namespace","integration").put("datasetKind","synthetic");
        manifest.putArray("files").addObject().put("path",file.toUri().toString()).put("sha256",Json.sha256(content.toString().getBytes(StandardCharsets.UTF_8)));
        Configuration conf=new Configuration();conf.set("fs.defaultFS","file:///");conf.set("mapreduce.framework.name","local");conf.setInt("hg.reducers",2);
        ObjectNode result=new Pipeline(conf).run(manifest,directory.resolve("run").toUri().toString());
        ObjectNode run=HdfsFiles.readJsonLines(conf,new Path(result.path("path").asText())).get(0);
        assertEquals(12,run.path("stages").size());assertEquals(3,run.path("repositoryCount").asInt());assertEquals(2,run.path("profileCount").asInt());
        assertEquals(1,run.path("stages").get(1).path("duplicates").asInt());
        List<ObjectNode> profiles=HdfsFiles.readJsonLines(conf,new Path(run.path("outputs").path("profiles").asText()));
        ObjectNode a=profiles.stream().filter(p->p.path("subjectId").asText().equals("A")).findFirst().orElseThrow();
        assertEquals(1,a.path("browseEventCount").asInt());assertEquals(1,a.path("evidenceCount").asInt());assertFalse(a.path("vector").path("indices").isEmpty());
        List<ObjectNode> candidates=HdfsFiles.readJsonLines(conf,new Path(run.path("outputs").path("candidates").asText()));
        assertEquals(3,candidates.stream().filter(p->p.path("subjectId").asText().equals("A")).findFirst().orElseThrow().path("items").size());
        Files.writeString(file,"{}\n");assertThrows(java.io.IOException.class,()->new Pipeline(conf).run(manifest,directory.resolve("tampered").toUri().toString()));
    }
}
