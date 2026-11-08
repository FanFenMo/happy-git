package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.http.HttpStatus;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

final class CloudJson {
    static final ObjectMapper JSON = new ObjectMapper();
    static final long MAX_SAFE = 9007199254740991L;
    static ObjectNode object() { return JSON.createObjectNode(); }
    static JsonNode parse(String value) {
        try { return JSON.readTree(value); } catch (Exception e) { throw new IllegalStateException("Stored JSON is invalid", e); }
    }
    static String id(JsonNode body, String name) {
        String value = body.path(name).asText("");
        if (!value.matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")) throw error(400, "INVALID_FIELD", name);
        return value;
    }
    static long number(JsonNode body, String name, long minimum) {
        JsonNode value = body.path(name);
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < minimum || value.longValue() > MAX_SAFE)
            throw error(400, "INVALID_FIELD", name);
        return value.longValue();
    }
    static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    static JsonNode canonical(JsonNode value) {
        if(value.isObject()) {
            ObjectNode result=object();List<String> fields=new ArrayList<>();value.fieldNames().forEachRemaining(fields::add);Collections.sort(fields);
            for(String field:fields)result.set(field,canonical(value.get(field)));return result;
        }
        if(value.isArray()){ArrayNode result=JSON.createArrayNode();for(JsonNode item:value)result.add(canonical(item));return result;}
        return value;
    }
    static String secret() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    static String challenge(String value) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII))); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    static CloudProblem error(int status, String code, String message) { return new CloudProblem(status, code, message); }
    static final class CloudProblem extends RuntimeException {
        final HttpStatus status; final String code;
        CloudProblem(int status, String code, String message) { super(message); this.status = HttpStatus.valueOf(status); this.code = code; }
    }
}
