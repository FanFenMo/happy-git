package com.happygit.server.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.happygit.server.model.TrendingFetchResult;
import com.happygit.server.model.TrendingProject;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

@Service
public class GitHubTrendingService {

    @Value("${happygit.github.token:}")
    private String githubToken;

    private final ObjectMapper objectMapper = new ObjectMapper();

    // 内存缓存机制
    private List<TrendingProject> cachedTrending = new ArrayList<>();
    private long lastFetchTimestamp = 0;
    private static final long CACHE_DURATION_MS = 15 * 60 * 1000; // 15分钟有效

    public TrendingFetchResult getTrendingProjects(int limit) {
        int boundedLimit = Math.max(1, Math.min(limit, 30));
        long now = System.currentTimeMillis();

        // 1. 若内存缓存有效，直接返回截取结果
        if (!cachedTrending.isEmpty() && (now - lastFetchTimestamp < CACHE_DURATION_MS)) {
            return sliceCached(boundedLimit, "cache");
        }

        // 2. 尝试从 GitHub 实时抓取
        try {
            LocalDate cutoffDate = LocalDate.now().minusMonths(3);
            List<TrendingProject> liveList = fetchFromGitHub(cutoffDate);
            if (!liveList.isEmpty()) {
                this.cachedTrending = liveList;
                this.lastFetchTimestamp = now;
                return sliceCached(boundedLimit, "live");
            }
        } catch (Exception e) {
            System.err.println("[GitHubTrendingService] 实时抓取失败: " + e.getMessage());
        }

        // 3. 上游抓取失败时，若有已过期的非空缓存仍可兜底
        if (!cachedTrending.isEmpty()) {
            return sliceCached(boundedLimit, "cache");
        }

        // 4. 无缓存且上游失败时抛出异常，由 Controller 返回 503
        throw new IllegalStateException("UPSTREAM_UNAVAILABLE: GitHub 热门接口暂不可用且无可用缓存");
    }

    public List<TrendingProject> fetchFromGitHub(LocalDate cutoffDate) throws Exception {
        String query = "is:public created:>" + cutoffDate + " stars:>50";
        String encodedQuery = URLEncoder.encode(query, StandardCharsets.UTF_8);
        String queryUrl = "https://api.github.com/search/repositories?q=" + encodedQuery
                + "&sort=stars&order=desc&per_page=30";

        URL url = URI.create(queryUrl).toURL();
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/vnd.github.v3+json");
        connection.setRequestProperty("User-Agent", "HappyGit-Server/1.0");

        if (githubToken != null && !githubToken.isBlank()) {
            connection.setRequestProperty("Authorization", "Bearer " + githubToken);
        }

        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);

        int responseCode = connection.getResponseCode();
        if (responseCode != 200) {
            throw new RuntimeException("GitHub API 返回非 200 响应: " + responseCode);
        }

        List<TrendingProject> list = new ArrayList<>();
        try (InputStream is = connection.getInputStream()) {
            JsonNode root = objectMapper.readTree(is);
            JsonNode items = root.path("items");

            for (JsonNode item : items) {
                List<String> topics = new ArrayList<>();
                JsonNode topicsNode = item.path("topics");
                if (topicsNode.isArray()) {
                    for (JsonNode t : topicsNode) {
                        topics.add(t.asText());
                    }
                }

                TrendingProject project = new TrendingProject(
                        item.path("id").asText(),
                        item.path("name").asText(),
                        item.path("full_name").asText(),
                        item.path("description").asText(null),
                        item.path("language").asText("未标注"),
                        item.path("stargazers_count").asInt(0),
                        item.path("forks_count").asInt(0),
                        item.path("html_url").asText(),
                        item.path("created_at").asText(),
                        item.path("updated_at").asText(),
                        topics
                );
                list.add(project);
            }
        }

        return list;
    }

    public TrendingFetchResult sliceCached(int limit, String source) {
        int toIndex = Math.min(limit, cachedTrending.size());
        List<TrendingProject> sub = new ArrayList<>(cachedTrending.subList(0, toIndex));
        return new TrendingFetchResult(sub, lastFetchTimestamp, source);
    }
}
