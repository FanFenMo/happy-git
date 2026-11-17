package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PortraitsTest {
    private ObjectNode vector(int coordinate){ObjectNode result=Json.object().put("dimension",8192);result.putArray("indices").add(coordinate);result.putArray("values").add(1);return result;}
    @Test void directionsNeverInventPersonalEvidenceAndEmptyUsersStayEmpty() {
        ObjectNode artifact=Json.object();artifact.putObject("config").put("directionBlend",.25);
        ObjectNode center=artifact.putArray("centers").addObject().put("centerId","direction-01").put("members",2);center.set("vector",vector(0));
        center.putObject("topics").put("database",1);center.putObject("languages").put("Java",1);center.putArray("keywords").add("storage");
        // A center representative must not become a user's citation.
        center.putArray("representativeRepositories").add("not-visited");
        ObjectNode user=Json.object().put("subjectId","subject");user.set("vector",vector(0));user.putObject("languages").put("Java",1);user.putObject("topics").put("database",1);
        user.putArray("topInterests").addObject().put("tag","database").putArray("evidenceRepos").add("visited");user.putArray("hiddenRepoIds").add("hidden");user.putArray("ownedRepoIds").add("owned");
        ObjectNode inferred=Portraits.infer(user,artifact);
        assertEquals("visited",inferred.path("directions").get(0).path("evidenceRepos").get(0).asText());assertFalse(inferred.toString().contains("not-visited"));
        ObjectNode plan=Portraits.searchPlan(inferred);assertTrue(plan.path("queries").size()<=4);assertEquals(8,plan.path("maxPages").asInt());
        assertTrue(plan.path("queries").get(0).path("exclude").path("repoIds").toString().contains("owned"));
        ObjectNode empty=Json.object().put("subjectId","empty");ObjectNode zero=empty.putObject("vector").put("dimension",8192);zero.putArray("indices");zero.putArray("values");
        ObjectNode result=Portraits.infer(empty,artifact);assertEquals("no_evidence",result.path("evidenceState").asText());assertTrue(result.path("directions").isEmpty());assertTrue(Portraits.searchPlan(result).path("queries").isEmpty());
        assertEquals(user.path("vector"),inferred.path("baselineVector"));
    }
}
