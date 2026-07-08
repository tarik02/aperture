package httpapi

import (
	"errors"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

type paginatedResponse[T any] struct {
	Data []T         `json:"data"`
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

func parseDeletedFilter(c *gin.Context) (includeDeleted bool, deletedOnly bool, err error) {
	raw := strings.TrimSpace(c.Query("deleted"))
	if raw == "" {
		return parseIncludeDeleted(c), false, nil
	}
	switch raw {
	case "active":
		return false, false, nil
	case "deleted":
		return true, true, nil
	case "all":
		return true, false, nil
	default:
		return false, false, validationError("deleted is invalid")
	}
}

func parseOptionalStatus(c *gin.Context) (*string, error) {
	raw := strings.TrimSpace(c.Query("status"))
	if raw == "" {
		return nil, nil
	}
	switch raw {
	case db.SessionStatusCreating, db.SessionStatusRunning, db.SessionStatusSuspended, db.SessionStatusDeleted, db.SessionStatusExpired, db.SessionStatusFailed:
		status := raw
		return &status, nil
	default:
		return nil, validationError("status is invalid")
	}
}

func parseTokenFilter(c *gin.Context, tenantID *string, allowAuthority bool) (db.APITokenFilter, error) {
	filter := db.APITokenFilter{TenantID: tenantID}

	if raw := strings.TrimSpace(c.Query("authorityType")); raw != "" {
		if !allowAuthority {
			return db.APITokenFilter{}, validationError("authorityType is invalid")
		}
		switch raw {
		case authAuthoritySystemAdmin, authAuthorityTenant:
			filter.AuthorityType = &raw
		default:
			return db.APITokenFilter{}, validationError("authorityType is invalid")
		}
	}

	if raw := strings.TrimSpace(c.Query("name")); raw != "" {
		filter.Name = &raw
	}
	if raw := strings.TrimSpace(c.Query("scope")); raw != "" {
		filter.Scope = &raw
	}

	switch raw := strings.TrimSpace(c.Query("revoked")); raw {
	case "":
	case "active":
		filter.ActiveOnly = true
	case "revoked":
		filter.RevokedOnly = true
	case "all":
	default:
		return db.APITokenFilter{}, validationError("revoked is invalid")
	}

	return filter, nil
}

func parseTagFilters(c *gin.Context) ([]db.TagFilter, error) {
	keys := c.QueryArray("tagKey")
	rawValues := c.QueryArray("tagValue")
	rawOperators := c.QueryArray("tagOperator")
	if len(keys) == 0 && len(rawValues) == 0 {
		return nil, nil
	}
	if len(keys) != len(rawValues) {
		return nil, validationError("tagKey and tagValue must be provided together")
	}
	if len(rawOperators) != 0 && len(rawOperators) != len(keys) {
		return nil, validationError("tagOperator must match tagKey count")
	}

	filters := make([]db.TagFilter, 0, len(keys))
	for i, rawKey := range keys {
		key := strings.TrimSpace(rawKey)
		values := parseTagValues([]string{rawValues[i]})
		if key == "" || len(values) == 0 {
			return nil, validationError("tagKey and tagValue must be provided together")
		}

		operator := db.TagOperatorEqual
		if len(rawOperators) > 0 && strings.TrimSpace(rawOperators[i]) != "" {
			operator = db.TagOperator(strings.TrimSpace(rawOperators[i]))
		}
		switch operator {
		case db.TagOperatorEqual, db.TagOperatorNotEqual:
			if len(values) != 1 {
				return nil, validationError("tagOperator accepts one tagValue")
			}
		case db.TagOperatorIn, db.TagOperatorNotIn:
		default:
			return nil, validationError("tagOperator is invalid")
		}

		filters = append(filters, db.TagFilter{Key: key, Operator: operator, Values: values})
	}

	return filters, nil
}

func parseTagValues(rawValues []string) []string {
	values := make([]string, 0, len(rawValues))
	for _, raw := range rawValues {
		for _, value := range strings.Split(raw, ",") {
			trimmed := strings.TrimSpace(value)
			if trimmed != "" {
				values = append(values, trimmed)
			}
		}
	}
	return values
}

func parseOptionalQuery(c *gin.Context, name string) *string {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return nil
	}
	value := raw
	return &value
}
