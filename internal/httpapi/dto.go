package httpapi

import (
	"errors"
	"strings"
	"time"
)

var (
	errRequestDecode = errors.New("request decode error")
	errValidation    = errors.New("validation error")
)

func validationError(message string) error {
	return errors.Join(errValidation, errors.New(message))
}

type createTenantRequest struct {
	DisplayName string `json:"displayName"`
}

func (r createTenantRequest) Validate() error {
	if strings.TrimSpace(r.DisplayName) == "" {
		return validationError("displayName is required")
	}
	return nil
}

type updateTenantRequest struct {
	DisplayName string `json:"displayName"`
}

func (r updateTenantRequest) Validate() error {
	if strings.TrimSpace(r.DisplayName) == "" {
		return validationError("displayName is required")
	}
	return nil
}

type createTenantLocalTokenRequest struct {
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	ExpiresAt *string  `json:"expiresAt"`
}

func (r createTenantLocalTokenRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
	}
	return nil
}

type createTokenRequest struct {
	Name          string   `json:"name"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId"`
	Scopes        []string `json:"scopes"`
	ExpiresAt     *string  `json:"expiresAt"`
}

func (r createTokenRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	if strings.TrimSpace(r.AuthorityType) == "" {
		return validationError("authorityType is required")
	}
	if len(r.Scopes) == 0 {
		return validationError("scopes is required")
	}
	if r.AuthorityType == authAuthorityTenant && (r.TenantID == nil || strings.TrimSpace(*r.TenantID) == "") {
		return validationError("tenantId is required for tenant tokens")
	}
	if r.ExpiresAt != nil && strings.TrimSpace(*r.ExpiresAt) != "" {
		if _, err := time.Parse(time.RFC3339Nano, *r.ExpiresAt); err != nil {
			return validationError("expiresAt must be RFC3339Nano")
		}
	}
	return nil
}

type tenantResponse struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"displayName"`
	CreatedAt   string  `json:"createdAt"`
	DeletedAt   *string `json:"deletedAt"`
}

type tokenResponse struct {
	ID            string   `json:"id"`
	AuthorityType string   `json:"authorityType"`
	TenantID      *string  `json:"tenantId"`
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	CreatedAt     string   `json:"createdAt"`
	ExpiresAt     *string  `json:"expiresAt"`
	RevokedAt     *string  `json:"revokedAt"`
}

type createTokenResponse struct {
	Token    tokenResponse `json:"token"`
	RawToken string        `json:"rawToken"`
}

const (
	authAuthoritySystemAdmin = "system_admin"
	authAuthorityTenant      = "tenant"
)
