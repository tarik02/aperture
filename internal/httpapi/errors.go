package httpapi

import (
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/jobtoken"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/snapshot"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/gin-gonic/gin"
)

var (
	errChannelsUnavailable         = errors.New("browser channels unavailable")
	errEventServiceUnavailable     = errors.New("event service unavailable")
	errGCServiceUnavailable        = errors.New("gc service unavailable")
	errSessionServiceUnavailable   = errors.New("session service unavailable")
	errPromotionServiceUnavailable = errors.New("promotion service unavailable")
	errSnapshotServiceUnavailable  = errors.New("snapshot service unavailable")
)

type apiErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorBody struct {
	Error apiErrorDetail `json:"error"`
}

type internalErrorBody struct {
	Error string `json:"error"`
}

// WriteError maps application errors to HTTP responses.
func WriteError(c *gin.Context, err error) {
	if err == nil {
		return
	}

	status, code, message := mapError(err)
	c.JSON(status, errorBody{Error: apiErrorDetail{Code: code, Message: message}})
}

// WriteInternalError maps application errors to flat internal HTTP responses.
func WriteInternalError(c *gin.Context, err error) {
	if err == nil {
		return
	}

	status, _, message := mapError(err)
	c.JSON(status, internalErrorBody{Error: message})
}

func mapError(err error) (int, string, string) {
	switch {
	case errors.Is(err, auth.ErrTokenMissing):
		return http.StatusUnauthorized, "authentication_required", "authentication required"
	case errors.Is(err, auth.ErrTokenInvalid):
		return http.StatusUnauthorized, "invalid_authentication_token", "invalid authentication token"
	case errors.Is(err, auth.ErrTokenExpired):
		return http.StatusUnauthorized, "authentication_token_expired", "authentication token expired"
	case errors.Is(err, auth.ErrTokenRevoked):
		return http.StatusUnauthorized, "authentication_token_revoked", "authentication token revoked"
	case errors.Is(err, auth.ErrScopeDenied):
		return http.StatusForbidden, "insufficient_scope", "insufficient scope"
	case errors.Is(err, auth.ErrTenantForbidden):
		return http.StatusForbidden, "tenant_selection_not_permitted", "tenant selection not permitted"
	case errors.Is(err, auth.ErrTenantRequired):
		return http.StatusBadRequest, "tenant_selection_required", "tenant selection required"
	case errors.Is(err, auth.ErrTenantNotFound):
		return http.StatusNotFound, "tenant_not_found", err.Error()
	case errors.Is(err, auth.ErrTokenNotFound):
		return http.StatusNotFound, "token_not_found", err.Error()
	case errors.Is(err, auth.ErrTenantDeleted):
		return http.StatusConflict, "tenant_deactivated", "tenant is deactivated"
	case errors.Is(err, auth.ErrTokenNameConflict):
		return http.StatusConflict, "token_name_conflict", "api token name already exists"
	case errors.Is(err, auth.ErrTokenDelegation):
		return http.StatusForbidden, "token_delegation_exceeded", "token delegation exceeds caller authority"
	case errors.Is(err, auth.ErrUserNotFound):
		return http.StatusNotFound, "user_not_found", "user not found"
	case errors.Is(err, auth.ErrUserDisabled):
		return http.StatusConflict, "user_disabled", "user is disabled"
	case errors.Is(err, auth.ErrUserEmailConflict):
		return http.StatusConflict, "user_email_conflict", "user email already exists"
	case errors.Is(err, auth.ErrMembershipNotFound):
		return http.StatusNotFound, "membership_not_found", "tenant membership not found"
	case errors.Is(err, auth.ErrOIDCProviderNotFound):
		return http.StatusNotFound, "oidc_provider_not_found", "oidc provider not found"
	case errors.Is(err, auth.ErrIdentityNotProvisioned):
		return http.StatusForbidden, "identity_not_provisioned", "user is not provisioned"
	case errors.Is(err, auth.ErrOIDCFlowInvalid):
		return http.StatusBadRequest, "oidc_flow_invalid", "oidc flow is invalid or expired"
	case errors.Is(err, auth.ErrOIDCAuthentication):
		return http.StatusUnauthorized, "oidc_authentication_failed", "oidc authentication failed"
	case errors.Is(err, auth.ErrBootstrapNotEmpty):
		return http.StatusConflict, "bootstrap_refused", "bootstrap refused: api tokens already exist"
	case errors.Is(err, auth.ErrInvalidScopes), errors.Is(err, auth.ErrInvalidAuthority), errors.Is(err, auth.ErrTenantTokenCrossScope):
		return http.StatusBadRequest, "validation_failed", err.Error()
	case errors.Is(err, errRequestDecode):
		return http.StatusBadRequest, "invalid_request_body", "invalid request body"
	case errors.Is(err, errValidation):
		return http.StatusBadRequest, "validation_failed", err.Error()
	case errors.Is(err, jobtoken.ErrMissing), errors.Is(err, jobtoken.ErrInvalid):
		return http.StatusUnauthorized, "invalid_job_token", "invalid job token"
	case errors.Is(err, session.ErrNotFound):
		return http.StatusNotFound, "session_not_found", "session not found"
	case errors.Is(err, session.ErrExpired):
		return http.StatusGone, "session_expired", "session expired"
	case errors.Is(err, session.ErrSnapshotNotFound):
		return http.StatusNotFound, "base_snapshot_not_found", "base snapshot not found"
	case errors.Is(err, session.ErrSnapshotDeleted):
		return http.StatusConflict, "base_snapshot_deleted", "base snapshot is deleted"
	case errors.Is(err, session.ErrNotReopenable):
		return http.StatusConflict, "session_not_reopenable", err.Error()
	case errors.Is(err, session.ErrOverlayMissing):
		return http.StatusConflict, "session_overlay_missing", err.Error()
	case errors.Is(err, session.ErrInvalidState):
		return http.StatusConflict, "session_invalid_state", err.Error()
	case errors.Is(err, session.ErrNotRunning):
		return http.StatusConflict, "session_not_running", err.Error()
	case errors.Is(err, session.ErrInvalidChannel), errors.Is(err, browser.ErrDeniedBrowserArg), errors.Is(err, browser.ErrDeniedCompositorBrowserArg):
		return http.StatusBadRequest, "validation_failed", err.Error()
	case errors.Is(err, session.ErrBrowserStart):
		return http.StatusBadGateway, "browser_start_failed", "browser failed to start"
	case errors.Is(err, snapshot.ErrNotFound):
		return http.StatusNotFound, "snapshot_not_found", "snapshot not found"
	case errors.Is(err, snapshot.ErrNameConflict):
		return http.StatusConflict, "snapshot_name_conflict", "snapshot name already exists"
	case errors.Is(err, snapshot.ErrDeleted):
		return http.StatusConflict, "snapshot_deleted", "snapshot is deleted"
	case errors.Is(err, snapshot.ErrNotDeleted):
		return http.StatusConflict, "snapshot_not_deleted", "snapshot is not deleted"
	case errors.Is(err, snapshot.ErrSessionNotFound):
		return http.StatusNotFound, "session_not_found", "session not found"
	case errors.Is(err, snapshot.ErrSessionExpired):
		return http.StatusGone, "session_expired", "session expired"
	case errors.Is(err, snapshot.ErrOverlayMissing), errors.Is(err, snapshot.ErrSessionNotPromotable):
		return http.StatusConflict, "session_not_promotable", err.Error()
	case errors.Is(err, errChannelsUnavailable):
		return http.StatusInternalServerError, "browser_channels_unavailable", err.Error()
	case errors.Is(err, errEventServiceUnavailable):
		return http.StatusInternalServerError, "event_service_unavailable", err.Error()
	case errors.Is(err, errGCServiceUnavailable):
		return http.StatusInternalServerError, "gc_service_unavailable", err.Error()
	case errors.Is(err, errSessionServiceUnavailable):
		return http.StatusInternalServerError, "session_service_unavailable", err.Error()
	case errors.Is(err, errPromotionServiceUnavailable):
		return http.StatusInternalServerError, "promotion_service_unavailable", err.Error()
	case errors.Is(err, errSnapshotServiceUnavailable):
		return http.StatusInternalServerError, "snapshot_service_unavailable", err.Error()
	default:
		var promotionErr *snapshot.PromotionConflictError
		if errors.As(err, &promotionErr) {
			return http.StatusConflict, "promotion_conflict", promotionErr.Error()
		}
		var overlayErr *session.OverlayMountError
		if errors.As(err, &overlayErr) {
			return http.StatusInternalServerError, "overlay_mount_failed", "overlay mount failed"
		}
		var supervisorErr *supervisor.BrowserSupervisorError
		if errors.As(err, &supervisorErr) {
			return http.StatusBadGateway, "browser_control_failed", "browser supervisor command failed"
		}
		return http.StatusInternalServerError, "internal_error", "internal server error"
	}
}
