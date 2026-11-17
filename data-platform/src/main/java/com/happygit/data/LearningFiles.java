package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import java.io.*;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;

/** Immutable, content-addressed descriptors shared by training and inference. */
final class LearningFiles {
    private LearningFiles() {}
    static ObjectNode read(Configuration conf,String path) throws Exception {
        Path file=new Path(path);
        try(InputStream in=file.getFileSystem(conf).open(file)){return Json.parse(new String(in.readAllBytes(),StandardCharsets.UTF_8));}
    }
    static ObjectNode write(Configuration conf,Path path,ObjectNode value) throws Exception {
        FileSystem fs=path.getFileSystem(conf);fs.mkdirs(path.getParent());byte[] bytes=Json.bytes(value);
        try(FSDataOutputStream out=fs.create(path,false)){out.write(bytes);out.hsync();}
        return describe(conf,path).put("sha256",Json.sha256(bytes));
    }
    static ObjectNode describe(Configuration conf,Path path) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");long bytes=0;
        try(InputStream in=path.getFileSystem(conf).open(path)) {
            byte[] buffer=new byte[65536];for(int n;(n=in.read(buffer))!=-1;){digest.update(buffer,0,n);bytes+=n;}
        }
        StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format("%02x",b&255));
        return Json.object().put("path",path.getFileSystem(conf).makeQualified(path).toString()).put("sha256",hash.toString()).put("bytes",bytes);
    }
    static ObjectNode verified(Configuration conf,ObjectNode descriptor) throws Exception {
        ObjectNode actual=describe(conf,new Path(descriptor.path("path").asText()));
        if(!actual.path("sha256").equals(descriptor.path("sha256")))throw new IOException("Frozen artifact digest mismatch: "+descriptor.path("path").asText());
        return read(conf,descriptor.path("path").asText());
    }
    static String codeDigest() throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        for(Class<?> type:new Class<?>[]{Pipeline.class,Jobs.class,Vectors.class,LearningPipeline.class,LearningJobs.class,Portraits.class,LearningDataset.class}) {
            try(InputStream in=type.getResourceAsStream(type.getSimpleName()+".class")){digest.update(in.readAllBytes());}
            for(Class<?> nested:type.getDeclaredClasses())try(InputStream in=nested.getResourceAsStream(nested.getSimpleName().equals(type.getSimpleName())?type.getSimpleName()+".class":nested.getName().substring(nested.getName().lastIndexOf('.')+1)+".class")){digest.update(in.readAllBytes());}
        }
        StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format("%02x",b&255));return hash.toString();
    }
}
