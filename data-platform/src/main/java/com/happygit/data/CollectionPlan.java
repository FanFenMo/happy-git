package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;

/** A bounded collection plan schedules ordinary leased tasks; budgets include retries and 304s. */
public final class CollectionPlan {
    public static final class Paused extends Exception { public Paused(){super("Collection plan paused or request budget exhausted");} }
    private CollectionPlan(){}
    public static ObjectNode create(TaskStore store,ObjectNode config) throws Exception {
        String id=Json.requireId(config.path("planId").asText());String namespace=Json.requireId(config.path("namespace").asText("public"));
        int budget=config.path("requestBudget").asInt(),pages=config.path("maxPagesPerQuery").asInt(1);
        if(budget<1||budget>100000||pages<1||pages>10)throw new IllegalArgumentException("requestBudget 1..100000; maxPagesPerQuery 1..10");
        if(!config.path("queries").isArray()||config.path("queries").size()>200)throw new IllegalArgumentException("queries must be an array of at most 200 source queries");
        if(config.has("seeds")&&!config.path("seeds").isArray()||config.has("publicUsers")&&!config.path("publicUsers").isArray())throw new IllegalArgumentException("seeds/publicUsers must be arrays");
        if(config.path("seeds").size()>1000||config.path("publicUsers").size()>200)throw new IllegalArgumentException("Plan seed/user limit exceeded");
        for(JsonNode query:config.path("queries"))if(!query.isTextual()||query.asText().isBlank()||query.asText().length()>512)throw new IllegalArgumentException("Invalid query");
        for(JsonNode seed:config.path("seeds"))if(!seed.isTextual()||!seed.asText().matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"))throw new IllegalArgumentException("Invalid repository seed");
        for(JsonNode user:config.path("publicUsers"))if(!user.asText().matches("[A-Za-z0-9-]{1,39}"))throw new IllegalArgumentException("Invalid public login");
        ObjectNode plan=Json.object().put("planId",id).put("namespace",namespace).put("requestBudget",budget).put("requestsUsed",0).put("state","active").put("createdAt",System.currentTimeMillis());
        plan.set("configuration",config.deepCopy());store.createPlan(id,plan);
        // Replaying this loop recovers an interrupted create without resetting its counters or state.
        int source=0;for(JsonNode query:config.path("queries")){
            ObjectNode input=Json.object().put("planId",id).put("query",query.asText()).put("page",1).put("maxPages",pages).put("source",source++);
            store.enqueue("discovery",namespace,"query-"+input.path("source").asInt(),input,id+"-page-1");
        }
        for(JsonNode seed:config.path("seeds"))enqueueRepository(store,namespace,seed.asText(),id,"seed");
        for(JsonNode login:config.path("publicUsers"))for(String kind:Arrays.asList("stars","owned")){
            ObjectNode input=Json.object().put("planId",id).put("collectionKind",kind).put("subjectId","public-"+login.asText().toLowerCase(Locale.ROOT));
            store.enqueue("collection",namespace,login.asText(),input,id+"-"+kind);
        }
        return store.plan(id);
    }
    static void enqueueRepository(TaskStore store,String namespace,String name,String planId,String source) throws Exception {
        ObjectNode input=Json.object();if(!planId.isEmpty())input.put("planId",planId);
        // One task per canonical repository in a plan, regardless of how many sources found it.
        store.enqueue("repository",namespace,name.toLowerCase(Locale.ROOT),input,planId.isEmpty()?source:planId);
    }
    static void expand(TaskStore store,ObjectNode task,List<ObjectNode> records) throws Exception {
        String planId=task.path("input").path("planId").asText(),namespace=task.path("namespace").asText();
        String source=task.path("id").asText();
        for(ObjectNode record:records)for(JsonNode name:record.path("discoveredRepositories"))enqueueRepository(store,namespace,name.asText(),planId,source);
        if(task.path("type").asText().equals("discovery")){
            ObjectNode result=records.get(0),input=((ObjectNode)task.path("input")).deepCopy();int page=input.path("page").asInt();
            if(result.path("returned").asInt()==100&&page<input.path("maxPages").asInt()&&!result.path("incompleteResults").asBoolean()){
                input.put("page",page+1);store.enqueue("discovery",namespace,task.path("target").asText(),input,planId+"-page-"+(page+1));
            }
        }
    }
}
