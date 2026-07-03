package httpapi

import (
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/gin-gonic/gin"
)

type errorBody struct {
	Error string `json:"error"`
}

// WriteError maps application errors to HTTP responses.
func WriteError(c *gin.Context, err error) {
	if err == nil {
		return
	}

	status, message := mapError(err)
	c.JSON(status, errorBody{Error: message})
}

func mapError(err error) (int, string) {
	switch {
	case errors.Is(err, auth.ErrTokenMissing):
		return http.StatusUnauthorized, "authentication required"
	case errors.Is(err, auth.ErrTokenInvalid):
		return http.StatusUnauthorized, "invalid authentication token"
	case errors.Is(err, auth.ErrTokenExpired):
		return http.StatusUnauthorized, "authentication token expired"
	case errors.Is(err, auth.ErrTokenRevoked):
		return http.StatusUnauthorized, "authentication token revoked"
	case errors.Is(err, auth.ErrScopeDenied):
		return http.StatusForbidden, "insufficient scope"
	case errors.Is(err, auth.ErrTenantForbidden):
		return http.StatusForbidden, "tenant selection not permitted"
	case errors.Is(err, auth.ErrTenantRequired):
		return http.StatusBadRequest, "tenant selection required"
	case errors.Is(err, auth.ErrTenantNotFound), errors.Is(err, auth.ErrTokenNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, auth.ErrTenantDeleted):
		return http.StatusConflict, "tenant is deactivated"
	case errors.Is(err, auth.ErrTokenNameConflict):
		return http.StatusConflict, "api token name already exists"
	case errors.Is(err, auth.ErrBootstrapNotEmpty):
		return http.StatusConflict, "bootstrap refused: api tokens already exist"
	case errors.Is(err, auth.ErrInvalidScopes), errors.Is(err, auth.ErrInvalidAuthority), errors.Is(err, auth.ErrTenantTokenCrossScope):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, errRequestDecode):
		return http.StatusBadRequest, "invalid request body"
	case errors.Is(err, errValidation):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, session.ErrNotFound):
		return http.StatusNotFound, "session not found"
	case errors.Is(err, session.ErrExpired):
		return http.StatusGone, "session expired"
	case errors.Is(err, session.ErrSnapshotNotFound):
		return http.StatusNotFound, "base snapshot not found"
	case errors.Is(err, session.ErrSnapshotDeleted):
		return http.StatusConflict, "base snapshot is deleted"
	case errors.Is(err, session.ErrNotReopenable), errors.Is(err, session.ErrOverlayMissing), errors.Is(err, session.ErrInvalidState):
		return http.StatusConflict, err.Error()
	case errors.Is(err, session.ErrNotRunning):
		return http.StatusConflict, err.Error()
	case errors.Is(err, session.ErrInvalidChannel), errors.Is(err, browser.ErrDeniedBrowserArg):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, session.ErrBrowserStart):
		return http.StatusBadGateway, "browser failed to start"
	case errors.Is(err, snapshot.ErrNotFound):
		return http.StatusNotFound, "snapshot not found"
	case errors.Is(err, snapshot.ErrNameConflict):
		return http.StatusConflict, "snapshot name already exists"
	case errors.Is(err, snapshot.ErrDeleted):
		return http.StatusConflict, "snapshot is deleted"
	case errors.Is(err, snapshot.ErrNotDeleted):
		return http.StatusConflict, "snapshot is not deleted"
	case errors.Is(err, snapshot.ErrSessionNotFound):
		return http.StatusNotFound, "session not found"
	case errors.Is(err, snapshot.ErrSessionExpired):
		return http.StatusGone, "session expired"
	case errors.Is(err, snapshot.ErrOverlayMissing), errors.Is(err, snapshot.ErrSessionNotPromotable):
		return http.StatusConflict, err.Error()
	default:
		var promotionErr *snapshot.PromotionConflictError
		if errors.As(err, &promotionErr) {
			return http.StatusConflict, promotionErr.Error()
		}
		var overlayErr *session.OverlayMountError
		if errors.As(err, &overlayErr) {
			return http.StatusInternalServerError, "overlay mount failed"
		}
		var supervisorErr *supervisor.BrowserSupervisorError
		if errors.As(err, &supervisorErr) {
			return http.StatusBadGateway, "browser supervisor command failed"
		}
		return http.StatusInternalServerError, "internal server error"
	}
}
