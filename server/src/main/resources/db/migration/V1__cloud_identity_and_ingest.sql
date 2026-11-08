CREATE TABLE cloud_users (
 subject_id VARCHAR(36) PRIMARY KEY, github_id VARCHAR(32) NOT NULL UNIQUE,
 login VARCHAR(100) NOT NULL, analysis_epoch BIGINT NOT NULL DEFAULT 1,
 revision BIGINT NOT NULL DEFAULT 0, analysis_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 preferences_json MEDIUMTEXT NOT NULL, exported_revision BIGINT NOT NULL DEFAULT -1,
 created_at BIGINT NOT NULL
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE cloud_logins (
 challenge_id VARCHAR(64) PRIMARY KEY, proof VARCHAR(64) NOT NULL,
 state_hash CHAR(64) NOT NULL UNIQUE, verifier VARCHAR(64) NOT NULL,
 status VARCHAR(24) NOT NULL, subject_id VARCHAR(36), expires_at BIGINT NOT NULL
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE cloud_sessions (
 access_hash CHAR(64) PRIMARY KEY, refresh_hash CHAR(64) NOT NULL UNIQUE,
 subject_id VARCHAR(36) NOT NULL, device_id VARCHAR(36),
 access_expires_at BIGINT NOT NULL, refresh_expires_at BIGINT NOT NULL,
 revoked BOOLEAN NOT NULL DEFAULT FALSE,
 INDEX session_subject(subject_id)
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE cloud_devices (
 device_id VARCHAR(36) PRIMARY KEY, subject_id VARCHAR(36) NOT NULL,
 installation_id VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
 UNIQUE KEY device_installation(subject_id, installation_id)
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE cloud_streams (
 stream_epoch VARCHAR(36) PRIMARY KEY, device_id VARCHAR(36) NOT NULL,
 subject_id VARCHAR(36) NOT NULL, analysis_epoch BIGINT NOT NULL,
 accepted_through BIGINT NOT NULL DEFAULT 0, exported_through BIGINT NOT NULL DEFAULT 0,
 processed_through BIGINT NOT NULL DEFAULT 0,
 UNIQUE KEY device_epoch(device_id, analysis_epoch), INDEX stream_subject(subject_id)
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE cloud_events (
 subject_id VARCHAR(36) NOT NULL, event_id VARCHAR(128) NOT NULL,
 stream_epoch VARCHAR(36) NOT NULL, device_seq BIGINT NOT NULL, analysis_epoch BIGINT NOT NULL,
 payload_hash CHAR(64) NOT NULL, content_hash CHAR(64) NOT NULL,
 effective_at BIGINT, payload_json TEXT,
 PRIMARY KEY(subject_id, event_id), UNIQUE KEY stream_sequence(stream_epoch, device_seq)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE cloud_batches (
 subject_id VARCHAR(36) NOT NULL, request_id VARCHAR(128) NOT NULL,
 content_hash CHAR(64) NOT NULL, PRIMARY KEY(subject_id, request_id)
) ENGINE=InnoDB CHARACTER SET ascii COLLATE ascii_bin;
CREATE TABLE cloud_operations (
 subject_id VARCHAR(36) NOT NULL, operation_id VARCHAR(128) NOT NULL,
 content_hash CHAR(64) NOT NULL, response_json MEDIUMTEXT NOT NULL,
 PRIMARY KEY(subject_id, operation_id)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE cloud_collections (
 subject_id VARCHAR(36) NOT NULL, analysis_epoch BIGINT NOT NULL,
 collection_kind VARCHAR(8) NOT NULL, revision BIGINT NOT NULL,
 complete BOOLEAN NOT NULL, payload_json MEDIUMTEXT NOT NULL, received_at BIGINT NOT NULL,
 PRIMARY KEY(subject_id, analysis_epoch, collection_kind, revision)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE cloud_exports (
 export_id VARCHAR(36) PRIMARY KEY, subject_id VARCHAR(36) NOT NULL,
 analysis_epoch BIGINT NOT NULL, revision BIGINT NOT NULL,
 state VARCHAR(16) NOT NULL, records_json MEDIUMTEXT,
 sha256 CHAR(64) NOT NULL, byte_count BIGINT NOT NULL, record_count INT NOT NULL,
 ranges_json TEXT NOT NULL, archive_json TEXT, created_at BIGINT NOT NULL,
 INDEX pending_exports(state, created_at)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
