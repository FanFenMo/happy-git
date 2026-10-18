package com.happygit.server.service;

import com.sun.net.httpserver.HttpServer;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.web.server.ResponseStatusException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.Arrays;
import static org.junit.jupiter.api.Assertions.*;

class GitHubOAuthServiceTest {
    private HttpServer upstream;
    private GitHubOAuthService auth;
    private final AtomicInteger exchanges = new AtomicInteger();
    private Map<String, String> exchangeBody;
    private final String verifier = "a".repeat(43);

    @BeforeEach void start() throws Exception {
        upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/login/oauth/access_token", request -> {
            exchangeBody = new ObjectMapper().readValue(request.getRequestBody(), Map.class);
            exchanges.incrementAndGet();
            byte[] body = "{\"access_token\":\"test-access\",\"refresh_token\":\"test-refresh\",\"expires_in\":28800}".getBytes(StandardCharsets.UTF_8);
            request.getResponseHeaders().set("Content-Type", "application/json");
            request.sendResponseHeaders(200, body.length); request.getResponseBody().write(body); request.close();
        });
        upstream.start();
        auth = new GitHubOAuthService("test-client", "test-secret", "https://app.example/api/auth/github/callback", "oauth-app", "http://127.0.0.1:" + upstream.getAddress().getPort());
    }
    @AfterEach void stop() { upstream.stop(0); }
    private String hash(String value) throws Exception { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII))); }
    private Map<String, String> query(Object url) {
        return Arrays.stream(URI.create(url.toString()).getRawQuery().split("&")).map(part -> part.split("=", 2))
                .collect(Collectors.toMap(pair -> pair[0], pair -> URLDecoder.decode(pair[1], StandardCharsets.UTF_8)));
    }
    @Test void authorizationExchangesCodeOnceAndRequiresOriginalProof() throws Exception {
        var begin = auth.begin(hash(verifier)); var query = query(begin.get("authorizationUrl"));
        assertEquals("read:user public_repo", query.get("scope"));
        assertEquals("S256", query.get("code_challenge_method"));
        assertFalse(begin.toString().contains("test-secret"));
        String id = begin.get("challengeId").toString();
        assertEquals("pending", auth.poll(id, verifier, false).get("state"));
        assertFalse(auth.callback("wrong-state", "code", null));
        assertThrows(ResponseStatusException.class, () -> auth.poll(id, "wrong-proof", false));
        assertTrue(auth.callback(query.get("state"), "test-code", null));
        assertFalse(auth.callback(query.get("state"), "test-code", null));
        assertEquals(1, exchanges.get());
        assertEquals(query.get("code_challenge"), hash(exchangeBody.get("code_verifier")));
        assertEquals("test-secret", exchangeBody.get("client_secret"));
        assertEquals("authenticated", auth.poll(id, verifier, false).get("state"));
        assertEquals("expired", auth.poll(id, verifier, false).get("state"));
    }
    @Test void cancellationAndDenialNeverExchangeTokens() throws Exception {
        var begin = auth.begin(hash(verifier)); var query = query(begin.get("authorizationUrl"));
        auth.poll(begin.get("challengeId").toString(), verifier, true);
        assertFalse(auth.callback(query.get("state"), "late-code", null));
        var next = auth.begin(hash(verifier));
        assertFalse(auth.callback(query(next.get("authorizationUrl")).get("state"), null, "access_denied"));
        assertEquals("denied", auth.poll(next.get("challengeId").toString(), verifier, false).get("state"));
        assertEquals(0, exchanges.get());
    }
    @Test void githubAppUsesConfiguredPermissionsAndRefreshStaysOnServer() throws Exception {
        var app = new GitHubOAuthService("app-id", "app-secret", "https://app.example/callback", "github-app", "http://127.0.0.1:" + upstream.getAddress().getPort());
        assertFalse(query(app.begin(hash(verifier)).get("authorizationUrl")).containsKey("scope"));
        assertEquals("test-access", app.refresh("refresh-proof").get("access_token").asText());
        assertEquals("refresh_token", exchangeBody.get("grant_type"));
        assertEquals("app-secret", exchangeBody.get("client_secret"));
    }
    @Test void missingConfigurationAndMalformedProofAreRejected() {
        var missing = new GitHubOAuthService("", "", "", "oauth-app", "https://github.com");
        assertEquals(503, assertThrows(ResponseStatusException.class, () -> missing.begin("a".repeat(43))).getStatusCode().value());
        assertEquals(400, assertThrows(ResponseStatusException.class, () -> auth.begin("bad")).getStatusCode().value());
    }
}
