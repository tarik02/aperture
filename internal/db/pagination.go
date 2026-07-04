package db

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/uptrace/bun"
)

const (
	DefaultPageLimit = 50
	MaxPageLimit     = 100
)

// ErrInvalidCursor indicates a malformed or unreadable pagination cursor.
var ErrInvalidCursor = errors.New("invalid pagination cursor")

// PageParams configures cursor pagination for list queries.
type PageParams struct {
	Limit  int
	Cursor string
}

// PageMeta is returned with paginated list responses.
type PageMeta struct {
	Limit      int    `json:"limit"`
	NextCursor string `json:"nextCursor,omitempty"`
	HasMore    bool   `json:"hasMore"`
}

// PageResult holds a page of items and pagination metadata.
type PageResult[T any] struct {
	Items []T
	Meta  PageMeta
}

type orderCursor struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

// NormalizePageParams applies default and maximum limits.
func NormalizePageParams(params PageParams) PageParams {
	limit := params.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	if limit > MaxPageLimit {
		limit = MaxPageLimit
	}
	return PageParams{
		Limit:  limit,
		Cursor: params.Cursor,
	}
}

// EncodeCursor returns an opaque base64url cursor for the given order key.
func EncodeCursor(createdAt, id string) (string, error) {
	payload, err := json.Marshal(orderCursor{CreatedAt: createdAt, ID: id})
	if err != nil {
		return "", fmt.Errorf("marshal cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

// DecodeCursor parses an opaque pagination cursor.
func DecodeCursor(raw string) (orderCursor, error) {
	if raw == "" {
		return orderCursor{}, ErrInvalidCursor
	}

	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return orderCursor{}, ErrInvalidCursor
	}

	var cursor orderCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return orderCursor{}, ErrInvalidCursor
	}
	if cursor.CreatedAt == "" || cursor.ID == "" {
		return orderCursor{}, ErrInvalidCursor
	}
	return cursor, nil
}

func parsePageCursor(params PageParams) (*orderCursor, error) {
	if params.Cursor == "" {
		return nil, nil
	}
	cursor, err := DecodeCursor(params.Cursor)
	if err != nil {
		return nil, err
	}
	return &cursor, nil
}

func paginateCreatedAtID(query *bun.SelectQuery, params PageParams, cursor *orderCursor) *bun.SelectQuery {
	query = query.OrderExpr("created_at DESC, id DESC").Limit(params.Limit + 1)
	if cursor != nil {
		query = query.Where("(created_at < ?) OR (created_at = ? AND id < ?)", cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	return query
}

func buildPageResult[T any](items []T, limit int, createdAt func(T) string, id func(T) string) (PageResult[T], error) {
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}

	meta := PageMeta{
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor, err := EncodeCursor(createdAt(last), id(last))
		if err != nil {
			return PageResult[T]{}, err
		}
		meta.NextCursor = nextCursor
	}
	return PageResult[T]{Items: items, Meta: meta}, nil
}
