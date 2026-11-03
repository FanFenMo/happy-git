package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class PublicVisibilityTest {
    @Test void privateObservationDoesNotArchivePrivateMetadata(){
        ObjectNode upstream=Json.object().put("id",42).put("private",true).put("name","secret")
                .put("description","private description").put("readmeText","private content");
        ObjectNode row=GitHubCollector.visibilityTombstone(upstream);
        assertEquals("42",row.path("repoId").asText());
        assertEquals("private",row.path("visibility").asText());
        assertFalse(row.has("name"));assertFalse(row.has("description"));assertFalse(row.has("readmeText"));
    }
    @Test void newerPrivateStateCannotBeResurrectedByOldPublicArchive(){
        ObjectNode old=Json.object().put("repoId","42").put("visibility","public").put("observedAt",100).put("readmeText","large body");
        ObjectNode newer=Json.object().put("repoId","42").put("visibility","private").put("observedAt",200);
        for(List<ObjectNode> observations:Arrays.asList(Arrays.asList(old,newer),Arrays.asList(newer,old))){
            Map<String,ObjectNode> latest=new TreeMap<>();
            for(ObjectNode row:observations)ConsoleServer.observeRepository(latest,row);
            latest.values().removeIf(row->!row.path("visibility").asText().equals("public"));
            assertTrue(latest.isEmpty());
        }
        assertTrue(old.has("readmeText"));
    }
}
