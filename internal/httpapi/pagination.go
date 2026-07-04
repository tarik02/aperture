package httpapi

import (
	"errors"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

type paginatedResponse[T any] struct {
	Data []T        `json:"data"`
	Meta db.PageMeta `json:"meta"`
}

func parsePageParams(c *gin.Context) (db.PageParams, error) {
	limit := 0
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			return db.PageParams{}, validationError("limit must be a non-negative integer")
		}
		limit = parsed
	}

	return db.PageParams{
		Limit:  limit,
		Cursor: strings.TrimSpace(c.Query("cursor")),
	}, nil
}

func mapInvalidCursor(err error) error {
	if errors.Is(err, db.ErrInvalidCursor) {
		return validationError("cursor is invalid")
	}
	return err
}

func parseIncludeDeleted(c *gin.Context) bool {
	return c.Query("includeDeleted") == "true"
}

func parseOptionalStatus(c *gin.Context) (*string, error) {
	raw := strings.TrimSpace(c.Query("status"))
	if raw == "" {
		return nil, nil
	}
	switch raw {
	case db.SessionStatusCreating, db.SessionStatusRunning, db.SessionStatusDeleted, db.SessionStatusExpired, db.SessionStatusFailed:
		status := raw
		return &status, nil
	default:
		return nil, validationError("status is invalid")
	}
}

func parseTagFilter(c *gin.Context) (string, string, error) {
	key := strings.TrimSpace(c.Query("tagKey"))
	value := strings.TrimSpace(c.Query("tagValue"))
	if key == "" && value == "" {
		return "", "", nil
	}
	if key == "" || value == "" {
		return "", "", validationError("tagKey and tagValue must be provided together")
	}
	return key, value, nil
}

func parseOptionalQuery(c *gin.Context, name string) *string {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return nil
	}
	value := raw
	return &value
}
