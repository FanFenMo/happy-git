package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.text.Normalizer;
import java.util.*;
import java.util.regex.*;

public final class Vectors {
    public static final int DIMENSION = 8192;
    private static final Pattern TOKEN = Pattern.compile("c\\+\\+|c#|\\.net|node\\.js|[a-z0-9]+|[\\u4e00-\\u9fff]{2,}");
    private static final Set<String> STOP = new HashSet<>(Arrays.asList("the", "a", "an", "and", "or", "to", "of", "for", "in", "is", "with", "this", "that"));
    private Vectors() {}
    public static List<String> tokens(String text) {
        String clean = Normalizer.normalize(text == null ? "" : text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        List<String> result = new ArrayList<>();
        Matcher matcher = TOKEN.matcher(clean);
        while (matcher.find()) {
            String term = matcher.group();
            if (term.matches("[\\u4e00-\\u9fff]+")) {
                for (int i = 0; i + 1 < term.length(); i++) result.add(term.substring(i, i + 2));
            } else if (!STOP.contains(term)) result.add(term);
        }
        return result;
    }
    public static ObjectNode terms(ObjectNode repository) {
        Map<String, Long> counts = new TreeMap<>();
        count(counts, Json.text(repository, "name"), 2);
        count(counts, Json.text(repository, "description"), 2);
        for (JsonNode topic : repository.path("topics")) count(counts, topic.asText(), 2);
        String readme = Json.text(repository, "readmeText");
        int length = readme.codePointCount(0, readme.length());
        if (length > 8000) readme = readme.substring(0, readme.offsetByCodePoints(0, 8000));
        count(counts, readme, 1);
        ObjectNode output = repository.deepCopy();
        output.put("kind", "repository_terms");
        ObjectNode jsonCounts = output.putObject("counts");
        counts.forEach(jsonCounts::put);
        return output;
    }
    private static void count(Map<String, Long> counts, String text, long weight) {
        for (String term : tokens(text)) counts.merge(term, weight, Long::sum);
    }
    public static ObjectNode normalize(double[] sum, int limit) {
        List<Integer> coordinates = new ArrayList<>();
        for (int i = 0; i < sum.length; i++) {
            if (!Double.isFinite(sum[i]) || sum[i] < 0) throw new IllegalArgumentException("Invalid vector weight");
            if (sum[i] > 0) coordinates.add(i);
        }
        coordinates.sort((a,b) -> { int score = Double.compare(sum[b], sum[a]); return score != 0 ? score : Integer.compare(a,b); });
        if (coordinates.size() > limit) coordinates = new ArrayList<>(coordinates.subList(0, limit));
        coordinates.sort(Integer::compare);
        double squared = 0;
        for (int i : coordinates) squared += sum[i] * sum[i];
        ObjectNode vector = Json.object().put("dimension", DIMENSION);
        ArrayNode indices = vector.putArray("indices"), values = vector.putArray("values");
        if (squared > 0) for (int i : coordinates) { indices.add(i); values.add(sum[i] / Math.sqrt(squared)); }
        return vector;
    }
    public static void add(double[] sum, JsonNode vector, double weight) {
        JsonNode indices = vector.path("indices"), values = vector.path("values");
        if (vector.path("dimension").asInt() != DIMENSION || indices.size() != values.size()) throw new IllegalArgumentException("Incompatible vector");
        int previous = -1;
        for (int p = 0; p < indices.size(); p++) {
            int index = indices.get(p).asInt();
            double value = values.get(p).asDouble();
            if (index <= previous || index >= DIMENSION || !Double.isFinite(value) || value <= 0) throw new IllegalArgumentException("Invalid sparse coordinate");
            sum[index] += weight * value; previous = index;
        }
    }
    public static double dot(JsonNode a, JsonNode b) {
        int i = 0, j = 0; double sum = 0;
        while (i < a.path("indices").size() && j < b.path("indices").size()) {
            int x = a.path("indices").get(i).asInt(), y = b.path("indices").get(j).asInt();
            if (x == y) sum += a.path("values").get(i++).asDouble() * b.path("values").get(j++).asDouble();
            else if (x < y) i++; else j++;
        }
        return Math.max(0, Math.min(1, sum));
    }
    public static ObjectNode project(ObjectNode repository, ObjectNode space) {
        double[] sum = new double[DIMENSION];
        JsonNode language = space.path("language").path(Json.text(repository, "primaryLanguage"));
        if (language.isInt()) sum[language.asInt()] = Math.sqrt(.20);
        Map<Integer, Double> topics = new TreeMap<>(), text = new TreeMap<>();
        for (JsonNode topic : repository.path("topics")) {
            JsonNode index = space.path("topic").path(topic.asText());
            if (index.isInt()) topics.put(index.asInt(), 1.0);
        }
        repository.path("counts").fields().forEachRemaining(entry -> {
            JsonNode feature = space.path("text").path(entry.getKey());
            if (feature.isObject() && entry.getValue().asLong() > 0)
                text.put(feature.path("index").asInt(), (1 + Math.log(entry.getValue().asLong())) * feature.path("idf").asDouble());
        });
        block(sum, topics, Math.sqrt(.30)); block(sum, text, Math.sqrt(.50));
        return normalize(sum, 256);
    }
    private static void block(double[] sum, Map<Integer, Double> block, double scale) {
        double norm = Math.sqrt(block.values().stream().mapToDouble(v -> v*v).sum());
        if (norm > 0) block.forEach((index,value) -> sum[index] = scale * value / norm);
    }
    public static ObjectNode distribution(Map<String, Double> weights) {
        ObjectNode result = Json.object(); double total = weights.values().stream().mapToDouble(Double::doubleValue).sum();
        if (total > 0) new TreeMap<>(weights).forEach((key,value) -> result.put(key,value/total));
        return result;
    }
    public static final Comparator<ObjectNode> BEST = (a,b) -> {
        int score = Double.compare(b.path("score").asDouble(), a.path("score").asDouble());
        return score != 0 ? score : Json.text(a,"repoId").compareTo(Json.text(b,"repoId"));
    };
    public static final class TopK {
        private final int k;
        private final PriorityQueue<ObjectNode> heap = new PriorityQueue<>(BEST.reversed());
        public TopK(int k) { if (k < 1) throw new IllegalArgumentException("TopK must be positive"); this.k = k; }
        public void offer(ObjectNode item) {
            if (heap.size() < k) heap.add(item);
            else if (BEST.compare(item,heap.peek()) < 0) { heap.poll(); heap.add(item); }
        }
        public ArrayNode result() {
            List<ObjectNode> list = new ArrayList<>(heap); list.sort(BEST);
            ArrayNode result = Json.MAPPER.createArrayNode(); list.forEach(result::add); return result;
        }
    }
}
