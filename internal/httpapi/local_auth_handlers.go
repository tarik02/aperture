package httpapi

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type passwordLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (r passwordLoginRequest) Validate() error {
	if strings.TrimSpace(r.Email) == "" || r.Password == "" {
		return validationError("email and password are required")
	}
	return nil
}

type mfaCodeRequest struct {
	Code string `json:"code"`
}

func (r mfaCodeRequest) Validate() error {
	if strings.TrimSpace(r.Code) == "" {
		return validationError("authentication code is required")
	}
	return nil
}

type passwordUpdateRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (r passwordUpdateRequest) Validate() error {
	if r.NewPassword == "" {
		return validationError("new password is required")
	}
	return nil
}

type passwordLoginResponse struct {
	MFARequired bool `json:"mfaRequired"`
}

type securityStatusResponse struct {
	HasPassword            bool `json:"hasPassword"`
	TOTPEnabled            bool `json:"totpEnabled"`
	RecoveryCodesRemaining int  `json:"recoveryCodesRemaining"`
}

type totpEnrollmentResponse struct {
	Secret        string `json:"secret"`
	OTPAuthURL    string `json:"otpauthUrl"`
	QRCodeDataURL string `json:"qrCodeDataUrl"`
}

type recoveryCodesResponse struct {
	RecoveryCodes []string `json:"recoveryCodes"`
}

func (s *Server) loginWithPassword(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request passwordLoginRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	result, err := s.WebAuth.LoginWithPassword(c.Request.Context(), request.Email, request.Password)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, passwordLoginResponse{MFARequired: result.MFARequired})
}

func (s *Server) completePasswordMFA(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request mfaCodeRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	if err := s.WebAuth.CompletePasswordMFA(c.Request.Context(), request.Code); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) getSecurityStatus(c *gin.Context) {
	status, err := s.WebAuth.GetSecurityStatus(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, securityStatusResponse{
		HasPassword:            status.HasPassword,
		TOTPEnabled:            status.TOTPEnabled,
		RecoveryCodesRemaining: status.RecoveryCodesRemaining,
	})
}

func (s *Server) setPassword(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request passwordUpdateRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	if err := s.WebAuth.SetPassword(c.Request.Context(), request.CurrentPassword, request.NewPassword); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) beginTOTPEnrollment(c *gin.Context) {
	enrollment, err := s.WebAuth.BeginTOTPEnrollment(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, totpEnrollmentResponse{
		Secret:        enrollment.Secret,
		OTPAuthURL:    enrollment.OTPAuthURL,
		QRCodeDataURL: enrollment.QRCodeDataURL,
	})
}

func (s *Server) completeTOTPEnrollment(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request mfaCodeRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	codes, err := s.WebAuth.CompleteTOTPEnrollment(c.Request.Context(), request.Code)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusCreated, recoveryCodesResponse{RecoveryCodes: codes})
}

func (s *Server) regenerateRecoveryCodes(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request mfaCodeRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	codes, err := s.WebAuth.RegenerateRecoveryCodes(c.Request.Context(), request.Code)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, recoveryCodesResponse{RecoveryCodes: codes})
}

func (s *Server) disableTOTP(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenAPIRequestBodySize)
	var request mfaCodeRequest
	if err := bindJSON(c, &request); err != nil {
		WriteError(c, err)
		return
	}
	if err := s.WebAuth.DisableTOTP(c.Request.Context(), request.Code); err != nil {
		WriteError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
