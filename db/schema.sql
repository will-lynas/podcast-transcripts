PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS episodes (
  episode_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  demo INTEGER NOT NULL CHECK (demo IN (0,1))
);
CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY,
  passage_id TEXT NOT NULL UNIQUE,
  episode_id TEXT NOT NULL REFERENCES episodes(episode_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  UNIQUE (episode_id, ordinal)
);
CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(text, content='passages', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS passages_ai AFTER INSERT ON passages BEGIN
  INSERT INTO passage_fts(rowid,text) VALUES (new.id,new.text);
END;
CREATE TRIGGER IF NOT EXISTS passages_ad AFTER DELETE ON passages BEGIN
  INSERT INTO passage_fts(passage_fts,rowid,text) VALUES ('delete',old.id,old.text);
END;
CREATE TRIGGER IF NOT EXISTS passages_au AFTER UPDATE ON passages BEGIN
  INSERT INTO passage_fts(passage_fts,rowid,text) VALUES ('delete',old.id,old.text);
  INSERT INTO passage_fts(rowid,text) VALUES (new.id,new.text);
END;
