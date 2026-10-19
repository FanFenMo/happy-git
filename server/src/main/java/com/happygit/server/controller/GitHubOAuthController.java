package com.happygit.server.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.happygit.server.service.GitHubOAuthService;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/auth/github")
public class GitHubOAuthController {
    private final GitHubOAuthService auth;
    public GitHubOAuthController(GitHubOAuthService auth) { this.auth = auth; }
    public record Proof(String challengeId, String codeVerifier, String codeChallenge) {}
    public record Refresh(String refreshToken) {}

    @GetMapping("/status")
    public ResponseEntity<?> status() {
        return json(Map.of("authProtocol", "github-oauth-web-v1", "configured", auth.isConfigured()));
    }

    @PostMapping("/begin")
    public ResponseEntity<?> begin(@RequestBody Proof proof) { return json(auth.begin(proof.codeChallenge())); }

    @PostMapping("/poll")
    public ResponseEntity<?> poll(@RequestBody Proof proof) { return json(auth.poll(proof.challengeId(), proof.codeVerifier(), false)); }

    @PostMapping("/cancel")
    public ResponseEntity<?> cancel(@RequestBody Proof proof) { return json(auth.poll(proof.challengeId(), proof.codeVerifier(), true)); }

    @PostMapping("/refresh")
    public ResponseEntity<JsonNode> refresh(@RequestBody Refresh body) { return json(auth.refresh(body.refreshToken())); }

    @GetMapping(value = "/callback", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> callback(@RequestParam(required = false) String state,
            @RequestParam(required = false) String code, @RequestParam(required = false) String error) {
        boolean ok = auth.callback(state, code, error);
        String message = ok ? "GitHub 授权完成，正在返回 HappyGit。" : "授权未完成，请返回 HappyGit 重新登录。";
        String html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
                + "<title>HappyGit 账号授权</title><body style=\"background:#10151d;color:#edf2f7;font:16px system-ui;padding:12vh 8vw\">"
                + "<h1>HappyGit</h1><p>" + message + "</p><p><a style=\"color:#fa987e\" href=\"happygit://oauth/complete\">返回应用</a></p>"
                + (ok ? "<script>location.href='happygit://oauth/complete'</script>" : "") + "</body></html>";
        return ResponseEntity.status(ok ? 200 : 400).cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
                .body(html);
    }

    private static <T> ResponseEntity<T> json(T body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body); }
}
