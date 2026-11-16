package com.happygit.data;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GitHubCollectorTest {
    @Test void repositorySearchAcceptsDateAndStarRanges() {
        String path="/search/repositories?q=stars%3A1..100+created%3A2026-01-01..2026-11-16&page=1";
        assertEquals("https://api.github.com"+path,GitHubCollector.apiUri(path).toString());
        assertThrows(IllegalArgumentException.class,()->GitHubCollector.apiUri("/repos/../private"));
    }
}
