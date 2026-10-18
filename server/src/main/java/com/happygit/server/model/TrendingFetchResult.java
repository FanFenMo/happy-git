package com.happygit.server.model;

import java.util.List;

public class TrendingFetchResult {
    private final List<TrendingProject> projects;
    private final long fetchedAt;
    private final String source; // "live" 或 "cache"

    public TrendingFetchResult(List<TrendingProject> projects, long fetchedAt, String source) {
        this.projects = projects;
        this.fetchedAt = fetchedAt;
        this.source = source;
    }

    public List<TrendingProject> getProjects() {
        return projects;
    }

    public long getFetchedAt() {
        return fetchedAt;
    }

    public String getSource() {
        return source;
    }
}
