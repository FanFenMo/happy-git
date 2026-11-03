package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;

public final class GitHubCollector {
    public static final class FetchException extends IOException {
        public final long retryAt; public final boolean permanent;
        FetchException(String message, long retryAt, boolean permanent) { super(message); this.retryAt = retryAt; this.permanent = permanent; }
    }
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final String token;
    public GitHubCollector(String token) { this.token = token; }
    private JsonNode get(String path, boolean optional) throws Exception {
        URI uri = URI.create("https://api.github.com" + path);
        if (!"api.github.com".equals(uri.getHost()) || path.contains("..")) throw new IllegalArgumentException("Invalid GitHub route");
        HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(45))
                .header("Accept", "application/vnd.github+json").header("User-Agent", "HappyGit-data-platform")
                .header("X-GitHub-Api-Version", "2022-11-28");
        if (token != null && !token.isBlank()) request.header("Authorization", "Bearer " + token);
        HttpResponse<InputStream> response = client.send(request.GET().build(), HttpResponse.BodyHandlers.ofInputStream());
        byte[] content;
        try (InputStream input = response.body()) {
            content = input.readNBytes(4 * 1024 * 1024 + 1);
            if (content.length > 4 * 1024 * 1024) throw new FetchException("GitHub response exceeds limit", 0, true);
        }
        int status = response.statusCode();
        if (status == 404 && optional) return null;
        if (status != 200) {
            long now = System.currentTimeMillis(), retryAt = now + 60_000;
            String retry = response.headers().firstValue("retry-after").orElse("");
            if (retry.matches("[0-9]+")) retryAt = now + Long.parseLong(retry) * 1000;
            else {
                String reset = response.headers().firstValue("x-ratelimit-reset").orElse("");
                if (response.headers().firstValue("x-ratelimit-remaining").orElse("1").equals("0") && reset.matches("[0-9]+"))
                    retryAt = Math.max(retryAt, Long.parseLong(reset) * 1000);
            }
            throw new FetchException("GitHub HTTP " + status, retryAt, status == 401 || status == 404 || status == 422);
        }
        return Json.MAPPER.readTree(content);
    }
    public List<ObjectNode> repository(String fullName) throws Exception {
        if (!fullName.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")) throw new IllegalArgumentException("Expected owner/name");
        JsonNode raw = get("/repos/" + fullName, false);
        // A credential may see private repositories: retain only a visibility tombstone.
        if(raw.path("private").asBoolean()) return Collections.singletonList(visibilityTombstone(raw));
        ObjectNode result = Json.object().put("kind", "repository").put("schemaVersion", "1.0.0")
                .put("repoId", raw.path("id").asText()).put("owner", raw.path("owner").path("login").asText())
                .put("name", raw.path("name").asText()).put("fullName", raw.path("full_name").asText())
                .put("canonicalKey", raw.path("full_name").asText().toLowerCase(Locale.ROOT))
                .put("htmlUrl", raw.path("html_url").asText()).put("visibility", raw.path("private").asBoolean() ? "private" : "public")
                .put("isArchived", raw.path("archived").asBoolean()).put("isFork",raw.path("fork").asBoolean())
                .put("sourceKind", "github_public").put("observedAt", System.currentTimeMillis());
        copy(raw, "description", result, "description"); copy(raw, "language", result, "primaryLanguage");
        copy(raw, "stargazers_count", result, "starCount"); copy(raw, "forks_count", result, "forkCount");
        result.set("topics", raw.path("topics").isArray() ? raw.get("topics") : Json.MAPPER.createArrayNode());
        result.set("licenseSpdx", raw.path("license").path("spdx_id").isTextual() ? raw.path("license").path("spdx_id") : NullNode.instance);
        result.set("updatedAt", date(raw.path("updated_at"))); result.set("pushedAt",date(raw.path("pushed_at")));
        if (result.path("visibility").asText().equals("public")) {
            JsonNode readme = get("/repos/" + fullName + "/readme", true);
            if (readme != null && "base64".equals(readme.path("encoding").asText())) {
                String text = new String(Base64.getMimeDecoder().decode(readme.path("content").asText()), StandardCharsets.UTF_8);
                if (text.codePointCount(0,text.length()) > 8000) text = text.substring(0,text.offsetByCodePoints(0,8000));
                result.put("readmeText",text);
            }
        }
        return Collections.singletonList(result);
    }
    static ObjectNode visibilityTombstone(JsonNode raw) {
        return Json.object().put("kind","repository").put("schemaVersion","1.0.0")
                .put("repoId",raw.path("id").asText()).put("visibility","private")
                .put("sourceKind","github_visibility").put("observedAt",System.currentTimeMillis());
    }
    public List<ObjectNode> collection(String login, String kind, String subjectId) throws Exception {
        if (!login.matches("[A-Za-z0-9-]{1,39}") || !(kind.equals("stars") || kind.equals("owned"))) throw new IllegalArgumentException("Invalid public collection");
        Json.requireId(subjectId);
        ArrayNode members = Json.MAPPER.createArrayNode();
        boolean complete = false;
        for (int page = 1; page <= 20; page++) {
            JsonNode rows = get("/users/" + login + (kind.equals("stars") ? "/starred" : "/repos") + "?per_page=100&page=" + page, false);
            if (!rows.isArray()) throw new IOException("Expected repository array");
            for (JsonNode row : rows) if (!row.path("private").asBoolean()) members.add(row.path("id").asText());
            if (rows.size() < 100) { complete = true; break; }
        }
        ObjectNode snapshot = Json.object().put("kind","collection").put("subjectId",subjectId)
                .put("collectionKind",kind).put("complete",complete).put("sourceKind","github_public")
                .put("observedAt",System.currentTimeMillis());
        snapshot.set("repoIds",members);
        return Collections.singletonList(snapshot);
    }
    private static void copy(JsonNode from, String source, ObjectNode target, String field) { target.set(field,from.path(source).isMissingNode() ? NullNode.instance : from.get(source)); }
    private static JsonNode date(JsonNode value) { return value.isTextual() ? LongNode.valueOf(Instant.parse(value.asText()).toEpochMilli()) : NullNode.instance; }
}
