package com.happygit.server.controller;

import com.happygit.server.service.GitHubOAuthService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;

class GitHubOAuthControllerTest {
    @Test void deploymentStatusReportsReadinessWithoutCredentials() throws Exception {
        var service = new GitHubOAuthService("project-client", "private-project-secret", "https://app.example/callback", "oauth-app", "https://github.com");
        var mvc = MockMvcBuilders.standaloneSetup(new GitHubOAuthController(service)).build();
        mvc.perform(get("/api/auth/github/status"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.authProtocol").value("github-oauth-web-v1"))
                .andExpect(jsonPath("$.configured").value(true))
                .andExpect(content().string(not(containsString("private-project-secret"))))
                .andExpect(content().string(not(containsString("project-client"))));
    }

    @Test void missingCredentialsAreVisibleToReleaseChecks() throws Exception {
        var service = new GitHubOAuthService("", "", "", "oauth-app", "https://github.com");
        var mvc = MockMvcBuilders.standaloneSetup(new GitHubOAuthController(service)).build();
        mvc.perform(get("/api/auth/github/status"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.configured").value(false));
    }
}
