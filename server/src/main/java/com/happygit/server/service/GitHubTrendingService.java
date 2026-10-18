package com.happygit.server.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.happygit.server.model.TrendingProject;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

@Service
public class GitHubTrendingService {

    @Value("${happygit.github.token:}")
    private String githubToken;

    private final ObjectMapper objectMapper = new ObjectMapper();

    // 内存缓存机制，降低频繁打 GitHub API 的速率超限风险
    private List<TrendingProject> cachedTrending = new ArrayList<>();
    private long lastFetchTimestamp = 0;
    private static final long CACHE_DURATION_MS = 15 * 60 * 1000; // 15分钟缓存

    public List<TrendingProject> getTrendingProjects(int limit) {
        long now = System.currentTimeMillis();
        if (!cachedTrending.isEmpty() && (now - lastFetchTimestamp < CACHE_DURATION_MS)) {
            return cachedTrending;
        }

        try {
            // 计算近 3 个月的起始日期 (YYYY-MM-DD)
            String threeMonthsAgo = LocalDate.now().minusMonths(3).toString();
            String queryUrl = "https://api.github.com/search/repositories?q=created:>"
                    + threeMonthsAgo + "&sort=stars&order=desc&per_page=" + Math.min(limit, 30);

            URL url = URI.create(queryUrl).toURL();
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/vnd.github.v3+json");
            connection.setRequestProperty("User-Agent", "HappyGit-Server/1.0");

            if (githubToken != null && !githubToken.isBlank()) {
                connection.setRequestProperty("Authorization", "token " + githubToken);
            }

            connection.setConnectTimeout(8000);
            connection.setReadTimeout(10000);

            if (connection.getResponseCode() == 200) {
                try (InputStream is = connection.getInputStream()) {
                    JsonNode root = objectMapper.readTree(is);
                    JsonNode items = root.path("items");
                    List<TrendingProject> list = new ArrayList<>();

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
                                item.path("description").asText("暂无项目简介"),
                                item.path("language").asText("Markdown"),
                                item.path("stargazers_count").asInt(),
                                item.path("forks_count").asInt(),
                                item.path("html_url").asText(),
                                item.path("created_at").asText(),
                                item.path("updated_at").asText(),
                                topics
                        );
                        list.add(project);
                    }

                    if (!list.isEmpty()) {
                        this.cachedTrending = list;
                        this.lastFetchTimestamp = now;
                        return list;
                    }
                }
            } else {
                System.err.println("GitHub API 响应码: " + connection.getResponseCode());
            }
        } catch (Exception e) {
            System.err.println("从 GitHub 抓取热门项目失败，使用兜底精选数据: " + e.getMessage());
        }

        return getFallbackTrending();
    }

    private List<TrendingProject> getFallbackTrending() {
        if (!cachedTrending.isEmpty()) {
            return cachedTrending;
        }

        List<TrendingProject> fallback = new ArrayList<>();
        fallback.add(new TrendingProject(
                "101", "vllm-project/vllm", "vllm-project/vllm",
                "极速且易用的大语言模型高吞吐量推理与服务框架，具备 PagedAttention 显存优化技术。",
                "Python", 34200, 4800, "https://github.com/vllm-project/vllm",
                "2026-08-01", "刚刚", List.of("llm", "inference", "pytorch")
        ));
        fallback.add(new TrendingProject(
                "102", "deepseek-ai/DeepSeek-V2", "deepseek-ai/DeepSeek-V2",
                "高性价比强大 MoE 开源大语言模型，具备极高上下文处理吞吐与优秀的开源生态。",
                "Python", 28500, 3100, "https://github.com/deepseek-ai/DeepSeek-V2",
                "2026-08-15", "1 小时前", List.of("deep-learning", "moe", "ai")
        ));
        fallback.add(new TrendingProject(
                "103", "apache/hadoop", "apache/hadoop",
                "分布式计算与海量数据处理核心平台，包含 MapReduce 分布式计算框架与 HDFS。",
                "Java", 15300, 8900, "https://github.com/apache/hadoop",
                "2026-08-20", "昨天", List.of("hadoop", "mapreduce", "bigdata")
        ));
        fallback.add(new TrendingProject(
                "104", "gorse-io/gorse", "gorse-io/gorse",
                "Go 语言开发的高性能通用开源推荐系统引擎，支持协同过滤与个性化推荐流水线。",
                "Go", 9240, 950, "https://github.com/gorse-io/gorse",
                "2026-09-02", "3 天前", List.of("recommendation", "collaborative-filtering")
        ));
        return fallback;
    }
}
