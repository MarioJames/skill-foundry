/** Additive v3 migration. Triggers record later business changes in the caller's transaction and do not backfill or call out of the database. */
import { Database } from "bun:sqlite";

const laneIdentity = "'worker_id', NEW.worker_id, 'name', NEW.agent_name, 'engine', NEW.engine, 'model', NEW.model, 'class', NEW.class";

export function migrateRuntimeEvents(db: Database): void {
  db.exec(`CREATE TABLE runtime_events(
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      lane_id TEXT REFERENCES lanes(lane_id),
      at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (
        'run.created','run.status','run.error',
        'lane.created','lane.status','lane.outcome','lane.progress','lane.keep_reason','lane.error','lane.health')),
      payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE INDEX runtime_events_run_at_id ON runtime_events(run_id, at, event_id);
    CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events
    BEGIN
      SELECT RAISE(ABORT, 'runtime_events is append-only');
    END;
    CREATE TRIGGER runtime_events_no_delete BEFORE DELETE ON runtime_events
    BEGIN
      SELECT RAISE(ABORT, 'runtime_events is append-only');
    END;
    CREATE TRIGGER runs_events_insert AFTER INSERT ON runs
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NULL, NEW.updated_at, 'run.created', json_object('status', NEW.status, 'engine', NEW.engine));
    END;
    CREATE TRIGGER runs_events_insert_error AFTER INSERT ON runs WHEN NEW.last_error IS NOT NULL
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NULL, NEW.updated_at, 'run.error', json_object('error', NEW.last_error, 'engine', NEW.engine));
    END;
    CREATE TRIGGER runs_events_update_status AFTER UPDATE ON runs WHEN NEW.status IS NOT OLD.status
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NULL, NEW.updated_at, 'run.status', json_object('status', NEW.status, 'engine', NEW.engine));
    END;
    CREATE TRIGGER runs_events_update_error AFTER UPDATE ON runs WHEN NEW.last_error IS NOT OLD.last_error
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NULL, NEW.updated_at, 'run.error', json_object('error', NEW.last_error, 'engine', NEW.engine));
    END;
    CREATE TRIGGER lanes_events_insert AFTER INSERT ON lanes
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.created', json_object('status', NEW.status, 'health', NEW.health, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_insert_outcome AFTER INSERT ON lanes WHEN NEW.outcome IS NOT NULL
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.outcome', json_object('outcome', NEW.outcome, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_insert_reason AFTER INSERT ON lanes WHEN NEW.keep_reason IS NOT NULL
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.keep_reason', json_object('keep_reason', NEW.keep_reason, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_insert_error AFTER INSERT ON lanes WHEN NEW.last_error IS NOT NULL
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.error', json_object('error', NEW.last_error, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_status AFTER UPDATE ON lanes WHEN NEW.status IS NOT OLD.status
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.status', json_object('status', NEW.status, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_outcome AFTER UPDATE ON lanes WHEN NEW.outcome IS NOT OLD.outcome
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.outcome', json_object('outcome', NEW.outcome, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_progress AFTER UPDATE ON lanes WHEN NEW.last_progress_at IS NOT OLD.last_progress_at
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.progress', json_object(${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_reason AFTER UPDATE ON lanes WHEN NEW.keep_reason IS NOT OLD.keep_reason
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.keep_reason', json_object('keep_reason', NEW.keep_reason, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_error AFTER UPDATE ON lanes WHEN NEW.last_error IS NOT OLD.last_error
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind,payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.error', json_object('error', NEW.last_error, ${laneIdentity}));
    END;
    CREATE TRIGGER lanes_events_update_health AFTER UPDATE ON lanes WHEN NEW.health IS NOT OLD.health
    BEGIN
      INSERT INTO runtime_events(run_id, lane_id, at, kind, payload)
      VALUES(NEW.run_id, NEW.lane_id, NEW.updated_at, 'lane.health', json_object('health', NEW.health, ${laneIdentity}));
    END;`);
  db.query("INSERT INTO meta(key,value) VALUES('runtime_events_started_at',?)").run(String(Date.now()));
}
