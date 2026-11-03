package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import org.apache.hadoop.io.*;
import org.apache.hadoop.mapreduce.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Explicit MapReduce stages; all intermediate outputs are UTF-8 JSONL. */
public final class Jobs {
    private Jobs() {}
    public enum Count { INPUT, OUTPUT, IGNORED, DUPLICATE, EMPTY, DOT_PRODUCTS, MISSING_FEATURE }
    public abstract static class Reader extends Mapper<LongWritable,Text,Text,Text> {
        protected long now;
        @Override protected void setup(Context c) throws IOException { now = c.getConfiguration().getLong("hg.referenceTime", 0); }
        @Override protected void map(LongWritable offset, Text line, Context c) throws IOException,InterruptedException {
            c.getCounter(Count.INPUT).increment(1);
            accept(Json.parse(line.toString()),c);
        }
        protected abstract void accept(ObjectNode value,Context c) throws IOException,InterruptedException;
        protected void send(Context c,String key,ObjectNode value) throws IOException,InterruptedException { c.write(new Text(key),new Text(value.toString())); }
        protected ObjectNode space(Context c) throws IOException {
            try { return HdfsFiles.readJsonLines(c.getConfiguration(),new Path(c.getConfiguration().get("hg.space"))).get(0); }
            catch (Exception e) { throw new IOException("Cannot load frozen feature space",e); }
        }
    }
    public abstract static class Writer extends Reducer<Text,Text,NullWritable,Text> {
        protected void emit(Context c,ObjectNode value) throws IOException,InterruptedException {
            c.write(NullWritable.get(),new Text(value.toString())); c.getCounter(Count.OUTPUT).increment(1);
        }
    }
    public static class SnapshotMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            if (v.path("kind").asText().equals("repository") && v.path("observedAt").asLong()<=now) send(c,Json.text(v,"repoId"),v);
        }
    }
    public static class SnapshotReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            ObjectNode latest=null;
            for(Text text:values) { ObjectNode v=Json.parse(text.toString());
                if(latest==null || v.path("observedAt").asLong()>latest.path("observedAt").asLong() ||
                    (v.path("observedAt").equals(latest.path("observedAt")) && v.toString().compareTo(latest.toString())<0)) latest=v; }
            if(latest!=null && latest.path("visibility").asText().equals("public")) emit(c,latest);
            else c.getCounter(Count.IGNORED).increment(1);
        }
    }
    public static class EventMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            if(!v.path("kind").asText().equals("event")) return;
            String user=Json.requireId(Json.text(v,"subjectId")), id=Json.requireId(Json.text(v,"eventId"));
            send(c,user+"\t"+id,v);
        }
    }
    public static class EventReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            ObjectNode first=null;
            for(Text text:values) { ObjectNode v=Json.parse(text.toString());
                if(first!=null) { if(!first.equals(v)) throw new IOException("Conflicting event identity"); c.getCounter(Count.DUPLICATE).increment(1); }
                else first=v; }
            long end=c.getConfiguration().getLong("hg.referenceTime",0), at=first.path("effectiveAt").asLong(first.path("occurredAt").asLong());
            boolean valid=at>end-90L*86400000 && at<=end && !first.path("recordKind").asText("open").equals("discard") && !Json.text(first,"repoId").isEmpty();
            if(valid) { first.put("effectiveAt",at); emit(c,first); } else c.getCounter(Count.IGNORED).increment(1);
        }
    }
    public static class TermsMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException { send(c,Json.text(v,"repoId"),Vectors.terms(v)); }
    }
    public static class IdentityReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            for(Text text:values) emit(c,Json.parse(text.toString()));
        }
    }
    public static class DfMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            Set<String> terms=new TreeSet<>();
            if(!Json.text(v,"primaryLanguage").isEmpty()) terms.add("language\t"+Json.text(v,"primaryLanguage"));
            for(JsonNode t:v.path("topics")) terms.add("topic\t"+t.asText());
            v.path("counts").fieldNames().forEachRemaining(t->terms.add("text\t"+t));
            for(String term:terms) send(c,term,Json.object().put("count",1));
        }
    }
    public static class DfReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            long sum=0; for(Text text:values) sum+=Json.parse(text.toString()).path("count").asLong();
            String[] parts=key.toString().split("\t",2);
            emit(c,Json.object().put("namespace",parts[0]).put("term",parts[1]).put("df",sum));
        }
    }
    public static class SpaceMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException { send(c,"space",v); }
    }
    public static class SpaceReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            Comparator<ObjectNode> best=(a,b)->{int s=Long.compare(b.path("df").asLong(),a.path("df").asLong());return s!=0?s:Json.text(a,"term").compareTo(Json.text(b,"term"));};
            Map<String,Integer> limits=new LinkedHashMap<>(); limits.put("language",128); limits.put("topic",1024); limits.put("text",7040);
            Map<String,PriorityQueue<ObjectNode>> heaps=new HashMap<>(); limits.keySet().forEach(n->heaps.put(n,new PriorityQueue<>(best.reversed())));
            for(Text text:values) { ObjectNode v=Json.parse(text.toString());String n=Json.text(v,"namespace");
                if(n.equals("text") && v.path("df").asLong()<2) continue;
                PriorityQueue<ObjectNode> heap=heaps.get(n); if(heap==null) throw new IOException("Unknown feature namespace");
                if(heap.size()<limits.get(n))heap.add(v);else if(best.compare(v,heap.peek())<0){heap.poll();heap.add(v);} }
            ObjectNode result=Json.object().put("kind","feature_space").put("dimension",8192).put("modelVersion","mr-content-v2-data1")
                    .put("tokenizerVersion","technical-nfkc-bigram-1").put("documentCount",c.getConfiguration().getLong("hg.documentCount",0));
            int[] offsets={0,128,1152};int n=0;
            for(String name:limits.keySet()) { List<ObjectNode> terms=new ArrayList<>(heaps.get(name));terms.sort(Comparator.comparing(v->Json.text(v,"term")));
                ObjectNode block=result.putObject(name);int index=offsets[n++];
                for(ObjectNode term:terms) { if(name.equals("text")) { ObjectNode entry=block.putObject(Json.text(term,"term"));entry.put("index",index++).put("df",term.path("df").asLong())
                        .put("idf",Math.log((result.path("documentCount").asDouble()+1)/(term.path("df").asDouble()+1))+1); }
                    else block.put(Json.text(term,"term"),index++); }
            }
            emit(c,result);
        }
    }
    public static class VectorMap extends Reader {
        private ObjectNode dictionary;
        protected void setup(Context c) throws IOException { super.setup(c);dictionary=space(c); }
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            ObjectNode vector=Vectors.project(v,dictionary);v.remove("counts");v.remove("readmeText");v.put("kind","repository_vector");v.set("vector",vector);
            if(v.path("starCount").isNumber())v.put("popularityScore",Math.min(Math.log1p(v.path("starCount").asLong())/Math.log(10001),1));else v.putNull("popularityScore");
            if(v.path("pushedAt").isNumber())v.put("freshnessScore",Math.pow(2,-Math.max(0,now-v.path("pushedAt").asLong())/86400000.0/180));else v.putNull("freshnessScore");
            send(c,Json.text(v,"repoId"),v);
        }
    }
    public static class EvidenceMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            String user=Json.text(v,"subjectId"); if(user.isEmpty())return;
            if(v.path("kind").asText().equals("event"))send(c,user+"\t"+Json.text(v,"repoId"),v);
            else if(v.path("kind").asText().equals("collection") && v.path("complete").asBoolean())
                for(JsonNode id:v.path("repoIds"))send(c,user+"\t"+id.asText(),Json.object().put("kind","membership").put("collectionKind",Json.text(v,"collectionKind")));
        }
    }
    public static class EvidenceReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            long opens=0,last=0,activities=0,lastActivity=0;boolean star=false,owned=false,hidden=false;
            for(Text text:values){ObjectNode v=Json.parse(text.toString());
                if(v.path("kind").asText().equals("membership")){star|=v.path("collectionKind").asText().equals("stars");owned|=v.path("collectionKind").asText().equals("owned");}
                else {String source=v.path("source").asText("browse");long at=v.path("effectiveAt").asLong();
                    if(source.equals("browse") || source.equals("repo_open")){opens++;last=Math.max(last,at);}
                    else if(Arrays.asList("PushEvent","IssuesEvent","PullRequestEvent").contains(source)){activities++;lastActivity=Math.max(lastActivity,at);}
                    hidden|=v.path("hidden").asBoolean();}}
            long now=c.getConfiguration().getLong("hg.referenceTime",0);
            double browse=opens==0?0:Math.min(1+Math.log(opens),3)*Math.pow(2,-Math.max(0,now-last)/86400000.0/30);
            double activity=activities==0?0:.5*Math.min(Math.log1p(activities),2)*Math.pow(2,-Math.max(0,now-lastActivity)/86400000.0/30);
            String[] parts=key.toString().split("\t",2);
            emit(c,Json.object().put("kind","evidence").put("subjectId",parts[0]).put("repoId",parts[1]).put("opens",opens).put("owned",owned).put("hidden",hidden)
                    .put("weight",hidden?0:browse+activity+(star?3:0)+(owned?1.5:0)));
        }
    }
    public static class JoinMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            boolean vector=v.path("kind").asText().equals("repository_vector");
            send(c,Json.text(v,"repoId")+"\t"+(vector?"0":"1\t"+Json.text(v,"subjectId")),v);
        }
    }
    public static class PrefixPartition extends Partitioner<Text,Text> {
        public int getPartition(Text key,Text value,int count){return Math.floorMod(prefix(key).hashCode(),count);}
    }
    public static class PrefixGroup extends WritableComparator {
        public PrefixGroup(){super(Text.class,true);}
        @Override public int compare(WritableComparable a,WritableComparable b){return prefix((Text)a).compareTo(prefix((Text)b));}
    }
    private static String prefix(Text key){return key.toString().split("\t",2)[0];}
    public static class JoinReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            ObjectNode vector=null;
            for(Text text:values){ObjectNode v=Json.parse(text.toString());
                if(v.path("kind").asText().equals("repository_vector")){if(vector!=null)throw new IOException("Duplicate project vector");vector=v;}
                else {v.put("kind","contribution"); boolean usable=vector!=null && vector.path("vector").path("indices").size()>0 && v.path("weight").asDouble()>0;
                    v.put("usable",usable);if(usable){v.set("vector",vector.path("vector"));v.set("primaryLanguage",vector.path("primaryLanguage"));v.set("topics",vector.path("topics"));}
                    else if(v.path("weight").asDouble()>0)c.getCounter(Count.MISSING_FEATURE).increment(v.path("opens").asLong());emit(c,v);}
            }
        }
    }
    public static class ProfileMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {
            if(v.path("kind").asText().equals("subject"))send(c,Json.text(v,"subjectId")+"\t0",v);
            else if(v.path("kind").asText().equals("contribution"))send(c,Json.text(v,"subjectId")+"\t1\t"+Json.text(v,"repoId"),v);
        }
    }
    public static class ProfileReduce extends Writer {
        private ObjectNode dictionary;
        protected void setup(Context c) throws IOException {try{dictionary=HdfsFiles.readJsonLines(c.getConfiguration(),new Path(c.getConfiguration().get("hg.space"))).get(0);}catch(Exception e){throw new IOException(e);}}
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            double[] sum=new double[8192];Map<String,Double> languages=new TreeMap<>(),topics=new TreeMap<>();ObjectNode seed=null;
            Map<String,Vectors.TopK> evidence=new TreeMap<>();ArrayNode owned=Json.MAPPER.createArrayNode(),used=Json.MAPPER.createArrayNode();long opens=0,missing=0,count=0;
            for(Text text:values){ObjectNode v=Json.parse(text.toString());if(v.path("kind").asText().equals("subject")){if(seed!=null)throw new IOException("Duplicate subject seed");seed=v;continue;}
                if(seed==null)throw new IOException("Missing subject seed before contributions");
                if(v.path("owned").asBoolean())owned.add(Json.text(v,"repoId"));opens+=v.path("opens").asLong();
                if(contains(seed.path("hiddenRepoIds"),Json.text(v,"repoId")))continue;
                if(!v.path("usable").asBoolean()){if(v.path("weight").asDouble()>0)missing+=v.path("opens").asLong();continue;}
                double weight=v.path("weight").asDouble();Vectors.add(sum,v.path("vector"),weight);count++;used.add(Json.text(v,"repoId"));
                String lang=Json.text(v,"primaryLanguage");if(dictionary.path("language").has(lang))languages.merge(lang,weight,Double::sum);
                Set<String> known=new TreeSet<>();for(JsonNode topic:v.path("topics"))if(dictionary.path("topic").has(topic.asText()))known.add(topic.asText());
                for(String topic:known){double share=weight/known.size();topics.merge(topic,share,Double::sum);evidence.computeIfAbsent(topic,t->new Vectors.TopK(5)).offer(Json.object().put("repoId",Json.text(v,"repoId")).put("score",share));}
            }
            if(seed==null)throw new IOException("Every processed subject requires an explicit seed");
            Set<String> manual=new TreeSet<>();for(JsonNode tag:seed.path("manualTags"))if(dictionary.path("topic").has(tag.asText()))manual.add(tag.asText());
            for(String tag:manual){sum[dictionary.path("topic").path(tag).asInt()]+=4/Math.sqrt(manual.size());topics.merge(tag,4.0/manual.size(),Double::sum);}
            ObjectNode result=Json.object().put("kind","profile").put("subjectId",Json.text(seed,"subjectId")).put("evidenceCount",count).put("browseEventCount",opens).put("missingFeatureEventCount",missing);
            result.set("vector",Vectors.normalize(sum,512));result.set("languages",Vectors.distribution(languages));result.set("topics",Vectors.distribution(topics));result.set("ownedRepoIds",owned);result.set("usedRepoIds",used);
            result.set("hiddenRepoIds",seed.path("hiddenRepoIds").isArray()?seed.path("hiddenRepoIds"):Json.MAPPER.createArrayNode());
            ArrayNode interests=result.putArray("topInterests");List<String> ordered=new ArrayList<>(topics.keySet());ordered.sort((a,b)->{int score=Double.compare(topics.get(b),topics.get(a));return score!=0?score:a.compareTo(b);});
            double total=topics.values().stream().mapToDouble(Double::doubleValue).sum();
            for(String tag:ordered.subList(0,Math.min(8,ordered.size()))){ObjectNode interest=interests.addObject().put("tag",tag).put("score",topics.get(tag)/total);ArrayNode repos=interest.putArray("evidenceRepos");
                if(evidence.containsKey(tag))for(JsonNode item:evidence.get(tag).result())repos.add(item.path("repoId").asText());}
            if(result.path("vector").path("indices").isEmpty())c.getCounter(Count.EMPTY).increment(1);emit(c,result);
        }
    }
    private static String cohort(JsonNode profile){
        if(profile.path("vector").path("indices").isEmpty())return "insufficient_evidence";
        Map<String,Double> groups=new TreeMap<>();profile.path("topics").fields().forEachRemaining(t->{String domain;
            if(t.getKey().matches(".*(hadoop|spark|data-engineering|database).*"))domain="data_engineering";
            else if(t.getKey().matches(".*(machine-learning|deep-learning|pytorch|tensorflow).*"))domain="machine_learning";
            else if(t.getKey().matches(".*(vue|react|frontend|css|javascript).*"))domain="frontend";
            else if(t.getKey().matches(".*(spring|backend|microservice|java).*"))domain="backend";else domain="other";
            groups.merge(domain,t.getValue().asDouble(),Double::sum);});
        return groups.entrySet().stream().sorted((a,b)->{int s=Double.compare(b.getValue(),a.getValue());return s!=0?s:a.getKey().compareTo(b.getKey());}).map(Map.Entry::getKey).findFirst().orElse("other");
    }
    public static class GroupMap extends Reader {
        protected void accept(ObjectNode v,Context c) throws IOException,InterruptedException {send(c,cohort(v),v);}
    }
    public static class GroupReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            Map<String,Double> languages=new TreeMap<>(),topics=new TreeMap<>();double[] sum=new double[8192];long members=0,lv=0,tv=0,vv=0;
            Map<String,Long> repositories=new TreeMap<>();
            for(Text text:values){ObjectNode v=Json.parse(text.toString());members++;
                if(v.path("languages").size()>0){lv++;v.path("languages").fields().forEachRemaining(e->languages.merge(e.getKey(),e.getValue().asDouble(),Double::sum));}
                if(v.path("topics").size()>0){tv++;v.path("topics").fields().forEachRemaining(e->topics.merge(e.getKey(),e.getValue().asDouble(),Double::sum));}
                if(v.path("vector").path("indices").size()>0){vv++;Vectors.add(sum,v.path("vector"),1);}
                Set<String> unique=new HashSet<>();for(JsonNode repo:v.path("usedRepoIds"))unique.add(repo.asText());for(String repo:unique)repositories.merge(repo,1L,Long::sum);
            }
            ObjectNode result=Json.object().put("cohortId",key.toString()).put("memberCount",members);
            boolean suppress=!c.getConfiguration().getBoolean("hg.synthetic",false)&&members<10;result.put("suppressed",suppress);
            if(!suppress){result.putObject("validCounts").put("languages",lv).put("topics",tv).put("vector",vv);result.set("languages",Vectors.distribution(languages));result.set("topics",Vectors.distribution(topics));result.set("centroid",Vectors.normalize(sum,8192));
                Vectors.TopK top=new Vectors.TopK(10);repositories.forEach((id,count)->top.offer(Json.object().put("repoId",id).put("score",count)));result.set("representativeRepositories",top.result());}
            emit(c,result);
        }
    }
    public static class RecallMap extends Reader {
        private List<ObjectNode> users;private final Map<String,Vectors.TopK> heaps=new TreeMap<>();
        protected void setup(Context c) throws IOException {super.setup(c);
            try{users=HdfsFiles.readJsonLines(c.getConfiguration(),new Path(c.getConfiguration().get("hg.profiles")));}catch(Exception e){throw new IOException(e);}
            if(users.size()>1000)throw new IOException("User block exceeds configured first-release limit (1000)");
            long bytes=0;for(ObjectNode user:users){bytes+=Json.bytes(user).length;heaps.put(Json.text(user,"subjectId"),new Vectors.TopK(300));}
            if(bytes>32L*1024*1024)throw new IOException("User cache exceeds 32 MiB; partition users before submitting");
        }
        protected void accept(ObjectNode repo,Context c) throws IOException,InterruptedException {
            if(repo.path("isArchived").asBoolean()||!repo.path("visibility").asText().equals("public")||repo.path("vector").path("indices").isEmpty())return;
            for(ObjectNode user:users){if(user.path("vector").path("indices").isEmpty()||contains(user.path("ownedRepoIds"),Json.text(repo,"repoId"))||contains(user.path("hiddenRepoIds"),Json.text(repo,"repoId")))continue;
                double score=Vectors.dot(user.path("vector"),repo.path("vector"));c.getCounter(Count.DOT_PRODUCTS).increment(1);
                if(score>0)heaps.get(Json.text(user,"subjectId")).offer(Json.object().put("repoId",Json.text(repo,"repoId")).put("score",score));}
        }
        protected void cleanup(Context c) throws IOException,InterruptedException {
            for(Map.Entry<String,Vectors.TopK> entry:heaps.entrySet()){ObjectNode row=Json.object().put("subjectId",entry.getKey());row.set("items",entry.getValue().result());send(c,entry.getKey(),row);}
        }
    }
    private static boolean contains(JsonNode array,String item){for(JsonNode node:array)if(node.asText().equals(item))return true;return false;}
    public static class RecallReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            Vectors.TopK heap=new Vectors.TopK(300);for(Text text:values)for(JsonNode item:Json.parse(text.toString()).path("items"))heap.offer((ObjectNode)item);
            ObjectNode row=Json.object().put("subjectId",key.toString());row.set("items",heap.result());emit(c,row);
        }
    }
    public static class PopularMap extends Reader {
        private final Vectors.TopK heap=new Vectors.TopK(1000);
        protected void accept(ObjectNode v,Context c){if(v.path("isArchived").asBoolean())return;
            double total=0,weight=0;if(v.path("popularityScore").isNumber()){total+=.7*v.path("popularityScore").asDouble();weight+=.7;}
            if(v.path("freshnessScore").isNumber()){total+=.3*v.path("freshnessScore").asDouble();weight+=.3;}
            heap.offer(Json.object().put("repoId",Json.text(v,"repoId")).put("score",weight==0?0:total/weight));}
        protected void cleanup(Context c) throws IOException,InterruptedException {ObjectNode row=Json.object();row.set("items",heap.result());send(c,"public",row);}
    }
    public static class PopularReduce extends Writer {
        protected void reduce(Text key,Iterable<Text> values,Context c) throws IOException,InterruptedException {
            Vectors.TopK top=new Vectors.TopK(1000);for(Text text:values)for(JsonNode item:Json.parse(text.toString()).path("items"))top.offer((ObjectNode)item);
            ObjectNode result=Json.object().put("kind","public_ranking");result.set("items",top.result());emit(c,result);
        }
    }
}
