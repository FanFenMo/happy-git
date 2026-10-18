package com.happygit.server.controller;

import com.happygit.server.model.TrendingFetchResult;
import com.happygit.server.service.GitHubTrendingService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
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
            @RequestParam(defaultValue = "20") int limit
    ) {
        Map<String, Object> response = new HashMap<>();

        try {
            TrendingFetchResult result = trendingService.getTrendingProjects(limit);
            response.put("code", 200);
            response.put("message", "success");
            response.put("total", result.getProjects().size());
            response.put("data", result.getProjects());
            response.put("source", result.getSource());
            response.put("fetchedAt", result.getFetchedAt());
            return ResponseEntity.ok(response);
        } catch (IllegalStateException e) {
            response.put("code", 503);
            response.put("message", e.getMessage());
            response.put("total", 0);
            response.put("data", null);
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(response);
        } catch (Exception e) {
            response.put("code", 500);
            response.put("message", "服务器内部错误: " + e.getMessage());
            response.put("total", 0);
            response.put("data", null);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(response);
        }
    }
}
