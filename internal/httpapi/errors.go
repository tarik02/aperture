package httpapi

import (
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/auth"
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
	default:
		return http.StatusInternalServerError, "internal server error"
	}
}
