package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.*;

public final class HdfsFiles {
    private final Configuration conf;
    private final String root;
    public HdfsFiles(Configuration conf, String root) { this.conf = conf; this.root = root.replaceAll("/+$", ""); }
    public String root() { return root; }
    public ObjectNode write(String namespace, String id, String attempt, List<ObjectNode> records) throws Exception {
        Path target = new Path(root + "/raw/" + Json.requireId(namespace) + "/" + Json.requireId(id) + "/" + Json.requireId(attempt) + ".jsonl");
        FileSystem fs = target.getFileSystem(conf);
        fs.mkdirs(target.getParent());
        Path temporary = new Path(target + ".inprogress");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        try (FSDataOutputStream raw = fs.create(temporary, false);
             DigestOutputStream out = new DigestOutputStream(raw, digest)) {
            for (ObjectNode record : records) {
                byte[] line = (record.toString() + "\n").getBytes(StandardCharsets.UTF_8);
                out.write(line); bytes += line.length;
            }
            out.flush(); raw.hsync();
        }
        if (!fs.rename(temporary, target)) throw new IOException("Cannot commit archive");
        StringBuilder hash = new StringBuilder();
        for (byte b : digest.digest()) hash.append(String.format("%02x", b & 255));
        return Json.object().put("path", fs.makeQualified(target).toString()).put("records", records.size()).put("bytes", bytes)
                .put("sha256", hash.toString()).put("committedAt", System.currentTimeMillis());
    }
    public static List<ObjectNode> readJsonLines(Configuration conf, Path directory) throws Exception {
        FileSystem fs = directory.getFileSystem(conf);
        List<ObjectNode> result = new ArrayList<>();
        List<Path> files = new ArrayList<>();
        if (fs.isFile(directory)) files.add(directory);
        else for (FileStatus file : fs.listStatus(directory))
            if (file.isFile() && !file.getPath().getName().startsWith("_") && !file.getPath().getName().startsWith(".")) files.add(file.getPath());
        files.sort(Comparator.comparing(Path::toString));
        for (Path file : files) try (BufferedReader reader = new BufferedReader(new InputStreamReader(fs.open(file), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null;) if (!line.isBlank()) result.add(Json.parse(line));
        }
        return result;
    }
}
