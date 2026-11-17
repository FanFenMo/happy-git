package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.fs.Path;
import org.apache.hadoop.io.Text;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Streaming user joins and deterministic spherical k-means on Hadoop. */
public final class LearningJobs {
    private LearningJobs() {}
    public static class InputMap extends Jobs.Reader {
        protected void accept(ObjectNode row,Context c) throws IOException,InterruptedException {
            String kind=row.path("kind").asText(),key;
            switch(kind) {
                case "repository":key=kind+"\t"+Json.text(row,"repoId");break;
                case "subject":key=kind+"\t"+Json.text(row,"subjectId");break;
                case "collection":
                    if(!row.path("complete").asBoolean()||row.path("observedAt").asLong()>now)return;
                    key=kind+"\t"+Json.text(row,"subjectId")+"\t"+Json.text(row,"collectionKind");break;
                case "event":key=kind+"\t"+Json.text(row,"subjectId")+"\t"+Json.text(row,"eventId");break;
                default:throw new IOException("Unsupported learning input kind: "+kind);
            }
            send(c,key,row);
        }
    }
    public static class InputReduce extends Jobs.Writer {
        protected void reduce(Text key,Iterable<Text> rows,Context c) throws IOException,InterruptedException {
            ObjectNode latest=null;
            for(Text text:rows) {
                ObjectNode row=Json.parse(text.toString());
                if(latest!=null&&row.path("kind").asText().equals("event")&&!latest.equals(row))throw new IOException("Conflicting raw event identity");
                if(latest==null||compare(row,latest)>0)latest=row;
            }
            emit(c,latest);
        }
        private int compare(ObjectNode a,ObjectNode b) {
            int revision=Long.compare(a.path("revision").asLong(),b.path("revision").asLong());if(revision!=0)return revision;
            int time=Long.compare(a.path("observedAt").asLong(),b.path("observedAt").asLong());return time!=0?time:a.toString().compareTo(b.toString());
        }
    }
    public static class SeedMap extends Jobs.Reader {
        protected void accept(ObjectNode row,Context c) throws IOException,InterruptedException {
            if(row.path("vector").path("indices").isEmpty())return;
            row.put("priority",Json.sha256((c.getConfiguration().getLong("hg.seed",20261103)+"\n"+Json.text(row,"subjectId")).getBytes(StandardCharsets.UTF_8)));
            send(c,"seeds",row);
        }
    }
    public static class SeedReduce extends Jobs.Writer {
        protected void reduce(Text key,Iterable<Text> rows,Context c) throws IOException,InterruptedException {
            int k=c.getConfiguration().getInt("hg.centers",4);
            Comparator<ObjectNode> order=Comparator.comparing((ObjectNode row)->row.path("priority").asText()).thenComparing(row->Json.text(row,"subjectId"));
            PriorityQueue<ObjectNode> heap=new PriorityQueue<>(order.reversed());
            for(Text text:rows){ObjectNode row=Json.parse(text.toString());if(heap.size()<k)heap.add(row);else if(order.compare(row,heap.peek())<0){heap.poll();heap.add(row);}}
            List<ObjectNode> seeds=new ArrayList<>(heap);seeds.sort(order);int id=0;
            for(ObjectNode row:seeds) {
                ObjectNode center=Json.object().put("kind","interest_center").put("centerId",String.format(Locale.ROOT,"direction-%02d",++id)).put("members",1);
                for(String name:Arrays.asList("vector","topics","languages"))center.set(name,row.path(name));emit(c,center);
            }
        }
    }
    public static class CenterMap extends Jobs.Reader {
        private List<ObjectNode> centers;
        protected void setup(Context c) throws IOException {
            super.setup(c);try{centers=HdfsFiles.readJsonLines(c.getConfiguration(),new Path(c.getConfiguration().get("hg.centersPath")));}catch(Exception e){throw new IOException(e);}
        }
        protected void accept(ObjectNode row,Context c) throws IOException,InterruptedException {
            if(row.path("vector").path("indices").isEmpty())return;
            ObjectNode best=null;double similarity=-1;
            for(ObjectNode center:centers){double score=Vectors.dot(row.path("vector"),center.path("vector"));if(score>similarity){best=center;similarity=score;}}
            send(c,best.path("centerId").asText()+"\t"+row.path("subjectId").asText(),row);
        }
    }
    public static class CenterReduce extends Jobs.Writer {
        protected void reduce(Text key,Iterable<Text> rows,Context c) throws IOException,InterruptedException {
            double[] sum=new double[Vectors.DIMENSION];Map<String,Double> topics=new TreeMap<>(),languages=new TreeMap<>();long members=0;
            for(Text text:rows){ObjectNode row=Json.parse(text.toString());Vectors.add(sum,row.path("vector"),1);members++;
                row.path("topics").fields().forEachRemaining(e->topics.merge(e.getKey(),e.getValue().asDouble(),Double::sum));
                row.path("languages").fields().forEachRemaining(e->languages.merge(e.getKey(),e.getValue().asDouble(),Double::sum));}
            ObjectNode center=Json.object().put("kind","interest_center").put("centerId",key.toString().split("\t",2)[0]).put("members",members);
            center.set("vector",Vectors.normalize(sum,Vectors.DIMENSION));center.set("topics",Vectors.distribution(topics));center.set("languages",Vectors.distribution(languages));emit(c,center);
        }
    }
    public static class ValidationMap extends Jobs.Reader {
        protected void accept(ObjectNode row,Context c) throws IOException,InterruptedException {send(c,Json.text(row,"subjectId")+"\t"+row.path("validationRole").asText(),row);}
    }
    public static class ValidationReduce extends Jobs.Writer {
        private ObjectNode artifact;private JsonNode alphas;
        protected void setup(Context c) throws IOException {
            try{artifact=LearningFiles.read(c.getConfiguration(),c.getConfiguration().get("hg.artifact"));alphas=Json.MAPPER.readTree(c.getConfiguration().get("hg.alphas"));}
            catch(Exception e){throw new IOException(e);}
        }
        protected void reduce(Text key,Iterable<Text> rows,Context c) throws IOException,InterruptedException {
            ObjectNode context=null,target=null;
            for(Text text:rows){ObjectNode row=Json.parse(text.toString());if(row.path("validationRole").asText().equals("context"))context=row;else target=row;}
            if(context==null||target==null||context.path("vector").path("indices").isEmpty()||target.path("vector").path("indices").isEmpty())return;
            for(JsonNode alpha:alphas){artifact.with("config").put("directionBlend",alpha.asDouble());
                ObjectNode projected=Portraits.infer(context,artifact);
                emit(c,Json.object().put("alpha",alpha.asDouble()).put("score",Vectors.dot(projected.path("vector"),target.path("vector")))
                        .put("baseline",Vectors.dot(context.path("vector"),target.path("vector"))));}
        }
    }
    public static class InferMap extends Jobs.Reader {
        private ObjectNode artifact;
        protected void setup(Context c) throws IOException {super.setup(c);try{artifact=LearningFiles.read(c.getConfiguration(),c.getConfiguration().get("hg.artifact"));}catch(Exception e){throw new IOException(e);}}
        protected void accept(ObjectNode row,Context c) throws IOException,InterruptedException {send(c,Json.text(row,"subjectId"),Portraits.infer(row,artifact));}
    }
}
