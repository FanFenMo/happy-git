package com.happygit.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

@SpringBootApplication
@EnableCaching
public class HappyGitApplication {

    public static void main(String[] args) {
        SpringApplication.run(HappyGitApplication.class, args);
        System.out.println("=================================================");
        System.out.println("🚀 HappyGit 后端服务已成功启动！");
        System.out.println("🔗 服务端地址: http://localhost:8081");
        System.out.println("🔥 热门开源项目接口: http://localhost:8081/api/projects/trending");
        System.out.println("=================================================");
    }
}
