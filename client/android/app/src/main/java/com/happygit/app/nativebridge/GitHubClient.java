package com.happygit.app.nativebridge;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;

public class GitHubClient {

    private static final String API_BASE = "https://api.github.com";
    private static final String API_VERSION = "2026-03-10";

    public static class Response {
        public int status;
        public JSONObject body;
        public Map<String, String> headers = new HashMap<>();
    }

    public static Response request(String resource, JSONObject args, String accessToken) throws Exception {
        String urlStr = "";
        String method = "GET";
        String accept = "application/vnd.github+json";

        if (args == null) args = new JSONObject();

        switch (resource) {
            case "currentUser":
                urlStr = API_BASE + "/user";
                break;
            case "ownedRepos": {
                String login = args.optString("login", "").trim();
                int page = args.optInt("page", 1);
                if (!login.isEmpty()) {
                    urlStr = API_BASE + "/users/" + URLEncoder.encode(login, "UTF-8") + "/repos?type=owner&sort=updated&direction=desc&per_page=100&page=" + page;
                } else {
                    urlStr = API_BASE + "/user/repos?type=owner&sort=updated&direction=desc&per_page=100&page=" + page;
                }
                break;
            }
            case "starredRepos": {
                int page = args.optInt("page", 1);
                urlStr = API_BASE + "/user/starred?sort=created&direction=desc&per_page=100&page=" + page;
                accept = "application/vnd.github.star+json";
                break;
            }
            case "starState": {
                String owner = URLEncoder.encode(args.optString("owner", ""), "UTF-8");
                String repo = URLEncoder.encode(args.optString("repo", ""), "UTF-8");
                urlStr = API_BASE + "/user/starred/" + owner + "/" + repo;
                break;
            }
            case "addStar": {
                String owner = URLEncoder.encode(args.optString("owner", ""), "UTF-8");
                String repo = URLEncoder.encode(args.optString("repo", ""), "UTF-8");
                urlStr = API_BASE + "/user/starred/" + owner + "/" + repo;
                method = "PUT";
                break;
            }
            case "removeStar": {
                String owner = URLEncoder.encode(args.optString("owner", ""), "UTF-8");
                String repo = URLEncoder.encode(args.optString("repo", ""), "UTF-8");
                urlStr = API_BASE + "/user/starred/" + owner + "/" + repo;
                method = "DELETE";
                break;
            }
            case "searchTrending": {
                String q = URLEncoder.encode(args.optString("query", "is:public stars:>100"), "UTF-8");
                urlStr = API_BASE + "/search/repositories?q=" + q + "&sort=stars&order=desc&per_page=20";
                break;
            }
            default:
                throw new IllegalArgumentException("UNKNOWN_RESOURCE: " + resource);
        }

        URL url = URI.create(urlStr).toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", accept);
        conn.setRequestProperty("User-Agent", "HappyGit-Android/1.0");
        conn.setRequestProperty("X-GitHub-Api-Version", API_VERSION);
        if (accessToken != null && !accessToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        }
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);

        Response resp = new Response();
        resp.status = conn.getResponseCode();

        resp.headers.put("link", conn.getHeaderField("link") != null ? conn.getHeaderField("link") : "");
        resp.headers.put("retryAfter", conn.getHeaderField("retry-after") != null ? conn.getHeaderField("retry-after") : "");
        resp.headers.put("rateLimitRemaining", conn.getHeaderField("x-ratelimit-remaining") != null ? conn.getHeaderField("x-ratelimit-remaining") : "");
        resp.headers.put("rateLimitReset", conn.getHeaderField("x-ratelimit-reset") != null ? conn.getHeaderField("x-ratelimit-reset") : "");

        if (resp.status == 204) {
            resp.body = null;
            return resp;
        }

        InputStream is = (resp.status >= 200 && resp.status < 400) ? conn.getInputStream() : conn.getErrorStream();
        if (is != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();
            try {
                resp.body = new JSONObject(sb.toString());
            } catch (Exception e) {
                resp.body = null;
            }
        }
        return resp;
    }
}
