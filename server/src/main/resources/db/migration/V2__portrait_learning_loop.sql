CREATE TABLE learning_models (
 namespace VARCHAR(128) NOT NULL, model_version VARCHAR(128) NOT NULL,
 state VARCHAR(16) NOT NULL, descriptor_json MEDIUMTEXT NOT NULL,
 validation_json MEDIUMTEXT, created_at BIGINT NOT NULL,
 PRIMARY KEY(namespace, model_version)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE learning_active (
 namespace VARCHAR(128) PRIMARY KEY, model_version VARCHAR(128),
 revision BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
INSERT INTO learning_active VALUES ('production', NULL, 0, 0);
CREATE TABLE learning_model_events (
 event_id VARCHAR(36) PRIMARY KEY, namespace VARCHAR(128) NOT NULL,
 model_version VARCHAR(128) NOT NULL, action VARCHAR(24) NOT NULL,
 previous_version VARCHAR(128), revision BIGINT NOT NULL,
 reason VARCHAR(512) NOT NULL, created_at BIGINT NOT NULL
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE learning_inputs (
 input_id CHAR(64) PRIMARY KEY, subject_id VARCHAR(36) NOT NULL,
 analysis_epoch BIGINT NOT NULL, input_revision BIGINT NOT NULL,
 reference_time BIGINT NOT NULL, summary_json MEDIUMTEXT NOT NULL,
 created_at BIGINT NOT NULL, INDEX input_subject(subject_id, analysis_epoch)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE learning_generations (
 generation_id VARCHAR(128) PRIMARY KEY, subject_id VARCHAR(36) NOT NULL,
 analysis_epoch BIGINT NOT NULL, model_version VARCHAR(128) NOT NULL,
 input_id CHAR(64) NOT NULL, input_digest CHAR(64) NOT NULL,
 reference_time BIGINT NOT NULL, state VARCHAR(16) NOT NULL,
 payload_json MEDIUMTEXT, created_at BIGINT NOT NULL,
 INDEX generation_subject(subject_id, analysis_epoch)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE learning_current (
 subject_id VARCHAR(36) PRIMARY KEY, generation_id VARCHAR(128) NOT NULL
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE learning_inference_queue (
 subject_id VARCHAR(36) PRIMARY KEY, analysis_epoch BIGINT NOT NULL,
 request_revision BIGINT NOT NULL DEFAULT 1, model_version VARCHAR(128),
 state VARCHAR(16) NOT NULL, requested_at BIGINT NOT NULL,
 task_id VARCHAR(64), error_message VARCHAR(512)
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
