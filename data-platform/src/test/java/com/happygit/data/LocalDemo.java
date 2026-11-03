package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.curator.test.TestingServer;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.hdfs.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Explicit local acceptance harness, not an automatically run unit test. */
public final class LocalDemo {
    public static void main(String[] args)throws Exception{
        java.nio.file.Path root=Paths.get(args.length>0?args[0]:"/tmp/happygit-local-demo").toAbsolutePath();
        if(Files.exists(root.resolve("started.json")))throw new IllegalArgumentException("Use a new isolated demo directory");
        Files.createDirectories(root);
        Configuration conf=new HdfsConfiguration();conf.set(MiniDFSCluster.HDFS_MINIDFS_BASEDIR,root.resolve("hdfs").toString());
        conf.setInt("dfs.replication",2);conf.set("mapreduce.framework.name","local");conf.setInt("hg.reducers",2);
        conf.set("dfs.namenode.http-address","127.0.0.1:0");
        MiniDFSCluster cluster=new MiniDFSCluster.Builder(conf).numDataNodes(3).build();cluster.waitActive();
        conf.set("fs.defaultFS",cluster.getFileSystem().getUri().toString());
        java.nio.file.Path config=root.resolve("conf");Files.createDirectories(config);
        try(OutputStream out=Files.newOutputStream(config.resolve("core-site.xml"))){conf.writeXml(out);}
        TestingServer zookeeper=new TestingServer();TaskStore store=new TaskStore(zookeeper.getConnectString(),"/happygit",12000,null);
        List<Process> children=new ArrayList<>();String classpath=System.getProperty("java.class.path");
        String java=Paths.get(System.getProperty("java.home"),"bin","java").toString();
        for(int i=1;i<=2;i++){
            ProcessBuilder builder=new ProcessBuilder(java,"-Xmx768m","-cp",classpath,Main.class.getName(),"worker","--id","local-worker-"+i,"--zk",zookeeper.getConnectString());
            builder.environment().put("HADOOP_CONF_DIR",config.toString());
            builder.redirectOutput(root.resolve("worker-"+i+".log").toFile());builder.redirectErrorStream(true);children.add(builder.start());
        }
        for(String repo:Arrays.asList("apache/hadoop","vuejs/core","spring-projects/spring-boot","apache/spark"))
            store.enqueue("repository","public",repo,Json.object(),"local-public-catalog");
        new ConsoleServer(store,conf,"/happygit/data",Collections.singletonMap("port","8090")).start();
        ObjectNode started=Json.object().put("storage","HDFS MiniDFSCluster").put("dataNodeInstances",3).put("physicalHosts",1)
                .put("mapreduceMode","local").put("zookeeper",zookeeper.getConnectString()).put("hdfs",cluster.getFileSystem().getUri().toString()).put("console","http://localhost:8090");
        Files.writeString(root.resolve("started.json"),started.toPrettyString());System.out.println("HG_LOCAL_DEMO "+started);
        Runtime.getRuntime().addShutdownHook(new Thread(()->{
            for(Process child:children)child.destroy();
            try{store.close();zookeeper.close();}catch(Exception ignored){}cluster.shutdown();
        }));
        Thread.currentThread().join();
    }
}
