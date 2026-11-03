package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper();
    private Json() {}
    public static ObjectNode object() { return MAPPER.createObjectNode(); }
    public static ObjectNode parse(String value) throws IOException {
        JsonNode node = MAPPER.readTree(value);
        if (node == null || !node.isObject()) throw new IOException("Expected a JSON object");
        return (ObjectNode) node;
    }
    public static String text(JsonNode node, String field) { return node.path(field).asText(""); }
    public static byte[] bytes(JsonNode node) { return node.toString().getBytes(StandardCharsets.UTF_8); }
    public static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder result = new StringBuilder();
            for (byte b : digest) result.append(String.format("%02x", b & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    public static String requireId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"))
            throw new IllegalArgumentException("Invalid identifier");
        return value;
    }
}
