package com.happygit.server.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    @GetMapping("/profile")
    public ResponseEntity<Map<String, Object>> getProfile(@RequestParam(required = false) String username) {
        Map<String, Object> response = new HashMap<>();

        if (username == null || username.isBlank() || "guest".equalsIgnoreCase(username)) {
            response.put("code", 200);
            response.put("isGuest", true);
            response.put("message", "当前为游客模式");
            return ResponseEntity.ok(response);
        }

        Map<String, Object> user = new HashMap<>();
        user.put("username", username);
        user.put("name", username);
        user.put("avatarUrl", "https://github.com/" + username + ".png");
        user.put("bio", "GitHub 开发者");
        user.put("tags", List.of("Java", "Hadoop", "Vue.js", "Open Source"));

        response.put("code", 200);
        response.put("isGuest", false);
        response.put("data", user);

        return ResponseEntity.ok(response);
    }
}
