package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;

/** Learned directions may expand search, while personal evidence stays attributable to the user. */
public final class Portraits {
    private Portraits() {}
    public static ObjectNode infer(ObjectNode baseline,ObjectNode artifact) {
        ObjectNode result=baseline.deepCopy();result.set("baselineVector",baseline.path("vector"));
        ArrayNode directions=result.putArray("directions");
        if(baseline.path("vector").path("indices").isEmpty())return result.put("evidenceState","no_evidence");
        List<ObjectNode> matches=new ArrayList<>();
        for(JsonNode center:artifact.path("centers")) {
            if(center.path("members").asLong()==0)continue;
            double score=Vectors.dot(baseline.path("vector"),center.path("vector"));
            if(score>0){ObjectNode match=((ObjectNode)center).deepCopy();match.put("similarity",score);matches.add(match);}
        }
        matches.sort(Comparator.comparingDouble((ObjectNode row)->row.path("similarity").asDouble()).reversed().thenComparing(row->row.path("centerId").asText()));
        if(matches.size()>4)matches=new ArrayList<>(matches.subList(0,4));
        double total=matches.stream().mapToDouble(row->Math.pow(row.path("similarity").asDouble(),2)).sum();
        double alpha=artifact.path("config").path("directionBlend").asDouble(.25),used=total>0?alpha:0;double[] vector=new double[Vectors.DIMENSION];
        Vectors.add(vector,baseline.path("vector"),1-used);
        for(ObjectNode match:matches) {
            double weight=Math.pow(match.path("similarity").asDouble(),2)/total;Vectors.add(vector,match.path("vector"),used*weight);
            ObjectNode direction=directions.addObject().put("directionId",match.path("centerId").asText()).put("weight",weight);
            direction.set("topics",topKeys(match.path("topics"),3));direction.set("languages",topKeys(match.path("languages"),2));
            direction.set("keywords",match.path("keywords").isArray()?match.path("keywords"):Json.MAPPER.createArrayNode());
            TreeSet<String> evidence=new TreeSet<>();
            for(JsonNode interest:baseline.path("topInterests"))if(match.path("topics").has(interest.path("tag").asText()))for(JsonNode repo:interest.path("evidenceRepos"))evidence.add(repo.asText());
            direction.set("evidenceRepos",Json.MAPPER.valueToTree(evidence.stream().limit(5).toArray()));
        }
        result.set("vector",Vectors.normalize(vector,512));return result.put("evidenceState","available");
    }
    static ArrayNode topKeys(JsonNode values,int limit) {
        List<Map.Entry<String,JsonNode>> entries=new ArrayList<>();values.fields().forEachRemaining(entries::add);
        entries.sort(Comparator.comparingDouble((Map.Entry<String,JsonNode> e)->e.getValue().asDouble()).reversed().thenComparing(Map.Entry::getKey));
        ArrayNode result=Json.MAPPER.createArrayNode();for(int i=0;i<Math.min(limit,entries.size());i++)result.add(entries.get(i).getKey());return result;
    }
    static ObjectNode searchPlan(ObjectNode profile) {
        ObjectNode result=Json.object().put("maxQueries",4).put("maxPages",8);ArrayNode queries=result.putArray("queries");
        if(profile.path("vector").path("indices").isEmpty())return result;
        Set<String> unique=new HashSet<>();
        for(JsonNode direction:profile.path("directions")) {
            ObjectNode query=Json.object().put("language",direction.path("languages").path(0).asText("")).put("sort","updated").put("pages",2);
            query.set("topics",direction.path("topics"));query.set("keywords",direction.path("keywords"));
            ObjectNode exclude=query.putObject("exclude");Set<String> ids=new TreeSet<>();for(JsonNode id:profile.path("hiddenRepoIds"))ids.add(id.asText());for(JsonNode id:profile.path("ownedRepoIds"))ids.add(id.asText());exclude.set("repoIds",Json.MAPPER.valueToTree(ids));
            if(unique.add(query.toString()))queries.add(query);if(queries.size()==4)break;
        }
        if(queries.isEmpty()) {
            ObjectNode query=queries.addObject().put("language",topKeys(profile.path("languages"),1).path(0).asText("")).put("sort","updated").put("pages",2);
            query.set("topics",topKeys(profile.path("topics"),3));query.putArray("keywords");query.putObject("exclude").set("repoIds",profile.path("hiddenRepoIds"));
        }
        return result;
    }
}
