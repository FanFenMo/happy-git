package com.happygit.server.controller;

import com.happygit.server.model.TrendingProject;
import com.happygit.server.service.GitHubTrendingService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {

    private final GitHubTrendingService trendingService;

    public ProjectController(GitHubTrendingService trendingService) {
        this.trendingService = trendingService;
    }

    @GetMapping("/trending")
    public ResponseEntity<Map<String, Object>> getTrendingProjects(
            @RequestParam(defaultValue = "15") int limit
    ) {
        List<TrendingProject> list = trendingService.getTrendingProjects(limit);

        Map<String, Object> response = new HashMap<>();
        response.put("code", 200);
        response.put("message", "success");
        response.put("total", list.size());
        response.put("data", list);

        return ResponseEntity.ok(response);
    }
}
