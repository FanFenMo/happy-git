package com.happygit.server.model;

import java.util.List;

public class TrendingProject {
    private String id;
    private String name;
    private String fullName;
    private String description;
    private String language;
    private int stars;
    private int forks;
    private String htmlUrl;
    private String createdAt;
    private String updatedAt;
    private List<String> topics;

    public TrendingProject() {}

    public TrendingProject(String id, String name, String fullName, String description,
                           String language, int stars, int forks, String htmlUrl,
                           String createdAt, String updatedAt, List<String> topics) {
        this.id = id;
        this.name = name;
        this.fullName = fullName;
        this.description = description;
        this.language = language;
        this.stars = stars;
        this.forks = forks;
        this.htmlUrl = htmlUrl;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.topics = topics;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getFullName() { return fullName; }
    public void setFullName(String fullName) { this.fullName = fullName; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public int getStars() { return stars; }
    public void setStars(int stars) { this.stars = stars; }

    public int getForks() { return forks; }
    public void setForks(int forks) { this.forks = forks; }

    public String getHtmlUrl() { return htmlUrl; }
    public void setHtmlUrl(String htmlUrl) { this.htmlUrl = htmlUrl; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }

    public List<String> getTopics() { return topics; }
    public void setTopics(List<String> topics) { this.topics = topics; }
}
