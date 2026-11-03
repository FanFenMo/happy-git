package com.happygit.data;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import org.apache.hadoop.hdfs.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.util.Collections;
import static org.junit.jupiter.api.Assertions.*;

class HdfsStorageTest {
    @TempDir java.nio.file.Path temporary;
    @Test void archiveIsReadableAfterOneReplicaHostProcessStops()throws Exception{
        Configuration conf=new HdfsConfiguration();
        conf.set(MiniDFSCluster.HDFS_MINIDFS_BASEDIR,temporary.resolve("hdfs").toString());
        conf.setInt("dfs.replication",2);conf.setInt("dfs.client.socket-timeout",2000);
        conf.set("dfs.namenode.http-address","127.0.0.1:0");
        MiniDFSCluster cluster=new MiniDFSCluster.Builder(conf).numDataNodes(3).build();
        try{
            cluster.waitActive();conf.set("fs.defaultFS",cluster.getFileSystem().getUri().toString());
            ObjectNode record=Json.object().put("kind","repository").put("repoId","1");
            ObjectNode descriptor=new HdfsFiles(conf,"/happygit/data").write("test","archive","attempt",Collections.singletonList(record));
            Path file=new Path(descriptor.path("path").asText());
            DFSTestUtil.waitReplication(cluster.getFileSystem(),file,(short)2);
            BlockLocation block=cluster.getFileSystem().getFileBlockLocations(file,0,Long.MAX_VALUE)[0];
            String target=block.getNames()[0];int stop=-1;
            for(int i=0;i<cluster.getDataNodes().size();i++)if(cluster.getDataNodes().get(i).getDatanodeId().getXferAddr().equals(target))stop=i;
            assertTrue(stop>=0);cluster.stopDataNode(stop);
            assertEquals(2,cluster.getDataNodes().size());
            assertEquals(record,HdfsFiles.readJsonLines(conf,file).get(0));
        }finally{cluster.shutdown();}
    }
}
