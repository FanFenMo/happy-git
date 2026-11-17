package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import java.util.UUID;
import static com.happygit.server.cloud.CloudJson.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Runs against an empty, disposable MySQL schema supplied by the integration runner. */
@EnabledIfEnvironmentVariable(named="HG_TEST_MYSQL_URL", matches=".+")
class CloudIngestIntegrationTest {
    private static final String ACCESS="a".repeat(43), ADMIN="integration-admin-"+"b".repeat(32);
    private MockMvc mvc;
    private JsonNode request(MockHttpServletRequestBuilder request, int expected) throws Exception {
        return parse(mvc.perform(request.header("Authorization","Bearer "+ACCESS).contentType("application/json"))
                .andExpect(status().is(expected)).andReturn().getResponse().getContentAsString());
    }
    @SuppressWarnings("unchecked")
    private <T> T transactional(T target, DataSourceTransactionManager manager) {
        ProxyFactory proxy=new ProxyFactory(target);
        proxy.setProxyTargetClass(true);
        proxy.addAdvice(new TransactionInterceptor(manager,new AnnotationTransactionAttributeSource()));
        return (T)proxy.getProxy();
    }
    @Test void deviceEventsCollectionsAndExportShareOneDurableContract() throws Exception {
        var source=new DriverManagerDataSource(System.getenv("HG_TEST_MYSQL_URL"),"root","");
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V1__cloud_identity_and_ingest.sql"),new ClassPathResource("db/migration/V2__portrait_learning_loop.sql")).execute(source);
        var db=new JdbcTemplate(source);
        var manager=new DataSourceTransactionManager(source);
        var auth=new CloudAuthService(db,manager,"test-client","test-secret","http://localhost/callback");
        var ingest=transactional(new CloudIngestService(db,auth),manager);
        var exports=transactional(new CloudExportService(db),manager);
        var learning=transactional(new CloudLearningService(db,auth),manager);
        mvc=MockMvcBuilders.standaloneSetup(new CloudController(auth,ingest,exports,learning,ADMIN)).build();
        String subject=UUID.randomUUID().toString();
        long now=System.currentTimeMillis();
        db.update("INSERT INTO cloud_users(subject_id,github_id,login,preferences_json,created_at) VALUES(?,?,?,'{\"manualTags\":[],\"hiddenRepoIds\":[]}',?)",subject,"1001","fixture",now);
        db.update("INSERT INTO cloud_sessions VALUES(?,?,?,NULL,?,?,FALSE)",hash(ACCESS),hash("refresh"),subject,now+3600000,now+7200000);
        JsonNode settings=request(get("/api/v2/me/preferences"),200);
        assertFalse(settings.path("analysisEnabled").asBoolean());
        ObjectNode enabled=object().put("operationId","enable-1").put("expectedRevision",0).put("analysisEnabled",true);
        enabled.putArray("manualTags").add("database");enabled.putArray("hiddenRepoIds");
        settings=request(put("/api/v2/me/preferences").content(enabled.toString()),200);
        assertEquals(2,settings.path("analysisEpoch").asInt());
        JsonNode registration=request(post("/api/v2/devices/register").content("{\"installationId\":\"fixture-installation\"}"),200);
        String stream=registration.path("streamEpoch").asText();
        assertDoesNotThrow(()->UUID.fromString(stream));
        ObjectNode event=object().put("schemaVersion","1.0.0").put("eventId","fixture-open-1").put("streamEpoch",stream)
                .put("analysisEpoch",2).put("deviceSeq",1).put("recordKind","open").put("repoId","23418517").put("occurredAt",now).put("source","browse");
        event.put("payloadHash",hash(JSON.createArrayNode().add("1.0.0").add("fixture-open-1").add(stream).add(1).add(2).add("23418517").add(now).add("browse").toString()));
        ObjectNode batch=object().put("requestId","fixture-batch-1").put("streamEpoch",stream).put("analysisEpoch",2).put("firstSeq",1);
        batch.putArray("events").add(event).add(object().put("eventId","fixture-discard-2").put("deviceSeq",2).put("recordKind","discard").put("payloadHash","0".repeat(64)));
        JsonNode ack=request(post("/api/v2/events/batches").content(batch.toString()),200);
        assertEquals(2,ack.path("acceptedThrough").asInt());
        assertEquals(0,ack.path("processedThrough").asInt());
        request(post("/api/v2/events/batches").content(batch.toString()),200);
        assertEquals(2,db.queryForObject("SELECT COUNT(*) FROM cloud_events",Integer.class));
        ObjectNode gap=batch.deepCopy().put("requestId","fixture-gap").put("firstSeq",4);
        gap.putArray("events").add(object().put("eventId","fixture-discard-4").put("deviceSeq",4).put("recordKind","discard").put("payloadHash","0".repeat(64)));
        assertEquals("SEQUENCE_GAP",request(post("/api/v2/events/batches").content(gap.toString()),409).path("code").asText());
        for (int i=0;i<3;i++) {
            ObjectNode collection=object().put("operationId","fixture-collection-"+i).put("expectedRevision",i+1).put("analysisEpoch",2)
                    .put("collectionKind",i==1?"owned":"stars").put("complete",i<2).put("observedAt",now);
            collection.putArray("repoIds").add(i==1?"123":"23418517");
            assertEquals(i+2,request(put("/api/v2/me/collections").content(collection.toString()),200).path("revision").asInt());
        }
        JsonNode exported=parse(mvc.perform(post("/api/v2/internal/exports/prepare").header("Authorization","Bearer "+ADMIN))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertEquals(4,exported.path("recordCount").asInt());
        assertEquals(2,exported.path("ranges").get(0).path("lastSeq").asInt());
        long completeStars=0;
        for(JsonNode record:exported.path("records")) if(record.path("collectionKind").asText().equals("stars")&&record.path("complete").asBoolean()) completeStars++;
        assertEquals(1,completeStars);
        // The worker's closed-HDFS descriptor is simulated here; HdfsStorageTest exercises actual HDFS I/O.
        ObjectNode descriptor=object().put("path","hdfs://fixture/closed.jsonl").put("sha256",exported.path("sha256").asText())
                .put("bytes",exported.path("bytes").asLong()).put("records",exported.path("recordCount").asInt());
        mvc.perform(post("/api/v2/internal/exports/"+exported.path("exportId").asText()+"/commit").header("Authorization","Bearer "+ADMIN)
                .contentType("application/json").content(descriptor.toString())).andExpect(status().isOk());
        assertEquals(2,db.queryForObject("SELECT exported_through FROM cloud_streams WHERE stream_epoch=?",Integer.class,stream));
        assertEquals(0,db.queryForObject("SELECT processed_through FROM cloud_streams WHERE stream_epoch=?",Integer.class,stream));
        assertEquals("pending",request(get("/api/v2/me/portrait"),200).path("state").asText());
        // This test supplies registry descriptors; LearningLoopIntegrationTest exercises real Hadoop artifacts.
        ObjectNode model=object().put("namespace","production").put("modelVersion","fixture-model-1").put("catalogMode","real_github_public")
                .put("artifactPath","hdfs://fixture/model.json").put("artifactDigest","a".repeat(64)).put("featureSpaceVersion","b".repeat(64))
                .put("catalogSnapshotId","c".repeat(64)).put("inputDigest","d".repeat(64)).put("codeDigest","e".repeat(64));
        ObjectNode projection=model.putObject("projection").put("format","happygit-sparse-8192-v1");
        ObjectNode dictionary=projection.putObject("dictionary").put("dimension",8192);
        dictionary.putObject("language").put("Java",0);dictionary.putObject("topic").put("database",128);dictionary.putObject("text");
        String featureVersion=hash(projection.toString());model.put("featureSpaceVersion",featureVersion);
        model.putObject("validation").put("passed",true).put("selectedOn","validation").put("users",1);
        model.putArray("scopes").addObject().put("subjectId",subject).put("analysisEpoch",2).put("revision",4);
        learning.register(model);
        assertEquals("FEATURE_SPACE_DIGEST_MISMATCH",assertThrows(CloudProblem.class,()->learning.register(model.deepCopy().put("featureSpaceVersion","b".repeat(64)))).code);
        assertEquals(projection,request(get("/api/v2/feature-spaces/"+featureVersion),200));
        learning.activate(object().put("namespace","production").put("modelVersion","fixture-model-1").put("expectedRevision",0).put("reason","integration fixture"),false);
        JsonNode input=learning.inputs("",System.currentTimeMillis(),100,false).path("items").get(0);
        ObjectNode portrait=object().put("subjectId",subject).put("analysisEpoch",2).put("inputId",input.path("inputId").asText())
                .put("generationId","fixture-generation-1").put("modelVersion","fixture-model-1").put("featureSpaceVersion",featureVersion)
                .put("catalogSnapshotId","c".repeat(64)).put("referenceTime",input.path("referenceTime").asLong()).put("inputDigest","f".repeat(64)).put("generatedAt",System.currentTimeMillis());
        portrait.set("processedThrough",input.path("processedThrough"));
        portrait.putObject("searchPlan").putArray("queries").addObject().put("language","Java").put("sort","updated").putArray("topics").add("database");
        ObjectNode vector=portrait.putObject("profile").putObject("vector").put("dimension",8192);vector.putArray("indices").add(0);vector.putArray("values").add(1);
        ((ObjectNode)portrait.path("profile")).putObject("languages").put("Java",1);
        ((ObjectNode)portrait.path("profile")).putObject("topics").put("database",1);
        learning.stage(portrait);
        assertEquals(0,db.queryForObject("SELECT processed_through FROM cloud_streams WHERE stream_epoch=?",Integer.class,stream));
        learning.publish("fixture-generation-1");
        assertEquals(2,db.queryForObject("SELECT processed_through FROM cloud_streams WHERE stream_epoch=?",Integer.class,stream));
        JsonNode published=request(get("/api/v2/me/portrait"),200),plan=request(get("/api/v2/me/search-plan"),200),cohorts=request(get("/api/v2/cohorts"),200);
        assertEquals("current",published.path("state").asText());assertEquals("ready",published.path("status").asText());
        assertEquals(2,published.path("processedThrough").path(stream).asInt());assertEquals("Java",plan.path("queries").get(0).path("language").asText());
        assertEquals(published.path("generationId"),plan.path("generationId"));assertEquals(1,cohorts.path("cohorts").get(0).path("memberCount").asInt());
        assertTrue(cohorts.path("cohorts").get(0).path("suppressed").asBoolean());
        String contractOutput=System.getenv("HG_TEST_CONTRACT_OUTPUT");
        if(contractOutput!=null) {
            ObjectNode contract=object().put("streamEpoch",stream);contract.set("portrait",published);contract.set("searchPlan",plan);contract.set("cohorts",cohorts);
            contract.set("featureSpace",request(get("/api/v2/feature-spaces/"+featureVersion),200));
            java.nio.file.Files.writeString(java.nio.file.Path.of(contractOutput),contract.toString());
        }
        ObjectNode second=model.deepCopy().put("modelVersion","fixture-model-2").put("artifactDigest","1".repeat(64));learning.register(second);
        learning.activate(object().put("namespace","production").put("modelVersion","fixture-model-2").put("expectedRevision",1).put("reason","new fixture model"),false);
        assertEquals("stale",request(get("/api/v2/me/portrait"),200).path("state").asText());
        assertEquals("stale",request(get("/api/v2/me/portrait"),200).path("status").asText());
        assertEquals("fixture-model-1",request(get("/api/v2/me/portrait"),200).path("modelVersion").asText());
        assertEquals("MODEL_CHANGED",assertThrows(CloudProblem.class,()->learning.publish("fixture-generation-1")).code);
        learning.activate(object().put("namespace","production").put("modelVersion","fixture-model-1").put("expectedRevision",2).put("reason","rollback fixture"),true);
        request(post("/api/v2/me/analysis/reset").content("{\"operationId\":\"reset-1\",\"expectedRevision\":4}"),200);
        assertEquals("pending",request(get("/api/v2/me/portrait"),200).path("state").asText());
        assertEquals(0,db.queryForObject("SELECT COUNT(*) FROM learning_generations WHERE payload_json IS NOT NULL",Integer.class));
        assertEquals("STALE_ANALYSIS_EPOCH",assertThrows(CloudProblem.class,()->learning.activate(object().put("namespace","production").put("modelVersion","fixture-model-2").put("expectedRevision",3).put("reason","must reject expired input"),false)).code);
        assertEquals(0,db.queryForObject("SELECT COUNT(*) FROM cloud_events WHERE payload_json IS NOT NULL",Integer.class));
        JsonNode next=request(post("/api/v2/devices/register").content("{\"installationId\":\"fixture-installation\"}"),200);
        assertNotEquals(stream,next.path("streamEpoch").asText());
        assertEquals(0,next.path("acceptedThrough").asInt());
        assertEquals("STALE_ANALYSIS_EPOCH",request(post("/api/v2/events/batches").content(batch.toString()),409).path("code").asText());
    }
}
