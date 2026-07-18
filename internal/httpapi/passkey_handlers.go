package httpapi

import (
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

type passkeyNameRequest struct {
	Name string `json:"name"`
}

func (r passkeyNameRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return validationError("name is required")
	}
	return nil
}

type passkeyResponse struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
}

type passkeysResponse struct {
	Passkeys []passkeyResponse `json:"passkeys"`
}

type passkeyMutationResponse struct {
	Passkey passkeyResponse `json:"passkey"`
}

func (s *Server) beginPasskeyLogin(c *gin.Context) {
	options, err := s.WebAuth.BeginPasskeyLogin(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, options)
}

func (s *Server) completePasskeyLogin(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	if _, err := s.WebAuth.CompletePasskeyLogin(c.Request.Context(), c.Request); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) listPasskeys(c *gin.Context) {
	passkeys, err := s.WebAuth.ListPasskeys(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	response := make([]passkeyResponse, 0, len(passkeys))
	for _, passkey := range passkeys {
		response = append(response, passkeyDTO(passkey))
	}
	c.JSON(http.StatusOK, passkeysResponse{Passkeys: response})
}

func (s *Server) beginPasskeyRegistration(c *gin.Context) {
	var request passkeyNameRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	options, err := s.WebAuth.BeginPasskeyRegistration(c.Request.Context(), request.Name)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, options)
}

func (s *Server) completePasskeyRegistration(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	passkey, err := s.WebAuth.CompletePasskeyRegistration(c.Request.Context(), c.Request)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, passkeyMutationResponse{Passkey: passkeyDTO(*passkey)})
}

func (s *Server) renamePasskey(c *gin.Context) {
	var request passkeyNameRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	passkey, err := s.WebAuth.RenamePasskey(c.Request.Context(), c.Param("passkeyId"), request.Name)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, passkeyMutationResponse{Passkey: passkeyDTO(*passkey)})
}

func (s *Server) deletePasskey(c *gin.Context) {
	if err := s.WebAuth.DeletePasskey(c.Request.Context(), c.Param("passkeyId")); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func passkeyDTO(passkey db.Passkey) passkeyResponse {
	return passkeyResponse{
		ID:         passkey.ID,
		Name:       passkey.Name,
		CreatedAt:  passkey.CreatedAt,
		LastUsedAt: passkey.LastUsedAt,
	}
}
