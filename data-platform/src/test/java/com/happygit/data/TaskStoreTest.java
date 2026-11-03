package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.curator.test.TestingServer;
import org.junit.jupiter.api.Test;
import java.io.*;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;

class TaskStoreTest {
    public static class LeaseHolder {
        public static void main(String[] args)throws Exception{
            try(TaskStore store=new TaskStore(args[0],"/crash-test",4000,null)){
                ObjectNode claim=store.claim(args[1],"killed-worker");
                System.out.println("HG_CLAIM "+claim.toString());System.out.flush();
                Thread.sleep(120000);
            }
        }
    }
    @Test void killedWorkerLeaseCanBeReclaimedAndOldTokenCannotPublish()throws Exception{
        try(TestingServer server=new TestingServer();TaskStore survivor=new TaskStore(server.getConnectString(),"/crash-test",4000,null)){
            String id=survivor.enqueue("repository","test","apache/hadoop",Json.object(),"request-1");
            String java=Path.of(System.getProperty("java.home"),"bin","java").toString();
            Process process=new ProcessBuilder(java,"-cp",System.getProperty("surefire.test.class.path",System.getProperty("java.class.path")),LeaseHolder.class.getName(),server.getConnectString(),id)
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            ObjectNode old;
            try(BufferedReader output=new BufferedReader(new InputStreamReader(process.getInputStream()))){
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
                String receipt=null;
                while(process.isAlive()&&System.nanoTime()<deadline){
                    if(!output.ready()){Thread.sleep(50);continue;}
                    String line=output.readLine();if(line!=null&&line.startsWith("HG_CLAIM ")){receipt=line.substring(9);break;}
                }
                assertNotNull(receipt,"child acquired lease");old=Json.parse(receipt);
                assertNull(survivor.claim(id,"survivor"),"live lease excludes other workers");
                process.destroyForcibly();assertTrue(process.waitFor(10,TimeUnit.SECONDS));
            }finally{if(process.isAlive())process.destroyForcibly();}
            ObjectNode next=null;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(25);
            while(next==null&&System.nanoTime()<deadline){next=survivor.claim(id,"survivor");if(next==null)Thread.sleep(100);}
            assertNotNull(next,"expired session releases task to survivor");
            assertThrows(IllegalStateException.class,()->survivor.finish(old,Json.object().put("path","stale")));
            survivor.finish(next,Json.object().put("path","winner"));
            assertEquals("winner",survivor.get(id).path("result").path("path").asText());
            assertEquals(1,survivor.committed("test").size());
        }
    }
    @Test void requestIdentityDoesNotSilentlyChangeInput()throws Exception{
        try(TestingServer server=new TestingServer();TaskStore store=new TaskStore(server.getConnectString(),"/identity",4000,null)){
            String a=store.enqueue("repository","test","vuejs/core",Json.object(),"stable");
            assertEquals(a,store.enqueue("repository","test","vuejs/core",Json.object(),"stable"));
            assertThrows(IllegalArgumentException.class,()->store.enqueue("repository","test","vuejs/core",Json.object().put("different",true),"stable"));
        }
    }
}
