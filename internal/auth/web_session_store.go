package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type webSessionStore struct {
	db *sql.DB
}

func (s *webSessionStore) Delete(token string) error {
	if _, err := s.db.Exec("DELETE FROM web_sessions WHERE token_hash = ?", token); err != nil {
		return fmt.Errorf("delete web session: %w", err)
	}
	return nil
}

func (s *webSessionStore) Find(token string) ([]byte, bool, error) {
	var data []byte
	err := s.db.QueryRow(
		"SELECT data FROM web_sessions WHERE token_hash = ? AND expires_at > ?",
		token,
		time.Now().UTC().Unix(),
	).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("find web session: %w", err)
	}
	return data, true, nil
}

func (s *webSessionStore) Commit(token string, data []byte, expiry time.Time) error {
	if _, err := s.db.Exec(`
		INSERT INTO web_sessions (token_hash, data, expires_at)
		VALUES (?, ?, ?)
		ON CONFLICT (token_hash) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
	`, token, data, expiry.UTC().Unix()); err != nil {
		return fmt.Errorf("commit web session: %w", err)
	}
	return nil
}
