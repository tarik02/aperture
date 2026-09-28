package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/session"
	"github.com/gin-gonic/gin"
)

// Signed thumbnail URLs authorize every thumbnail of one session until they expire.
const thumbnailTokenPrefix = "apth_"

var errThumbnailTokenInvalid = errors.New("invalid thumbnail token")

type sessionThumbnailResponse struct {
	URL               string `json:"url"`
	TargetURLTemplate string `json:"targetUrlTemplate"`
	ExpiresAt         string `json:"expiresAt"`
}

type thumbnailTokenPayload struct {
	SessionID string `json:"sessionId"`
	ExpiresAt int64  `json:"expiresAt"`
}

func issueThumbnailToken(secret, sessionID string, expiresAt time.Time) (string, error) {
	body, err := json.Marshal(thumbnailTokenPayload{SessionID: sessionID, ExpiresAt: expiresAt.Unix()})
	if err != nil {
		return "", err
	}
	signed := thumbnailTokenPrefix + base64.RawURLEncoding.EncodeToString(body)
	return signed + "." + base64.RawURLEncoding.EncodeToString(thumbnailTokenMAC(secret, signed)), nil
}

func verifyThumbnailToken(secret, token, sessionID string, now time.Time) error {
	signed, signature, ok := strings.Cut(token, ".")
	if !ok || secret == "" || !strings.HasPrefix(signed, thumbnailTokenPrefix) {
		return errThumbnailTokenInvalid
	}
	expected, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || subtle.ConstantTimeCompare(expected, thumbnailTokenMAC(secret, signed)) != 1 {
		return errThumbnailTokenInvalid
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(signed, thumbnailTokenPrefix))
	if err != nil {
		return errThumbnailTokenInvalid
	}
	var payload thumbnailTokenPayload
	if err := json.Unmarshal(body, &payload); err != nil || payload.SessionID != sessionID || payload.ExpiresAt <= now.Unix() {
		return errThumbnailTokenInvalid
	}
	return nil
}

func thumbnailTokenMAC(secret, signed string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signed))
	return mac.Sum(nil)
}

// sessionThumbnailLinks signs fresh thumbnail URLs, or returns nil when the session has none to show.
func (s *Server) sessionThumbnailLinks(sessionRow db.Session) *sessionThumbnailResponse {
	if s.Sessions == nil || s.jobToken == "" || !s.Sessions.ThumbnailAvailable(sessionRow) {
		return nil
	}
	expiresAt := time.Now().Add(s.Config.SignedFileURLTTL).UTC()
	token, err := issueThumbnailToken(s.jobToken, sessionRow.ID, expiresAt)
	if err != nil {
		return nil
	}
	base := strings.TrimRight(s.Config.ExternalBaseURL, "/") + "/sessions/" + url.PathEscape(sessionRow.ID)
	query := "?token=" + url.QueryEscape(token)
	return &sessionThumbnailResponse{
		URL:               base + "/thumbnail" + query,
		TargetURLTemplate: base + "/targets/{targetId}/thumbnail" + query,
		ExpiresAt:         expiresAt.Format(time.RFC3339),
	}
}

// getSessionThumbnail serves the account API route, authorized like other session reads.
func (s *Server) getSessionThumbnail(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	thumbnail, err := s.Sessions.Thumbnail(c.Request.Context(), tenantIDFromContext(c), c.Param("sessionId"), c.Param("targetId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	writeThumbnail(c, thumbnail)
}

// sessionThumbnail serves signed URLs and requests authorized by a session token or an editor
// or viewer capability. Unlike live-session routes it never wakes a suspended session.
func (s *Server) sessionThumbnail(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	sessionID := c.Param("sessionId")
	targetID := c.Param("targetId")
	var thumbnail session.Thumbnail
	var err error
	if token := c.Query("token"); token != "" {
		if verifyThumbnailToken(s.jobToken, token, sessionID, time.Now()) != nil {
			c.Status(http.StatusForbidden)
			return
		}
		thumbnail, err = s.Sessions.SignedThumbnail(c.Request.Context(), sessionID, targetID)
	} else {
		thumbnail, err = s.Sessions.AuthorizedThumbnail(c.Request.Context(), sessionID, c.GetHeader("Authorization"), targetID)
	}
	if errors.Is(err, session.ErrSessionTokenMissing) || errors.Is(err, session.ErrSessionTokenInvalid) {
		c.Status(http.StatusUnauthorized)
		return
	}
	if err != nil {
		WriteError(c, err)
		return
	}
	writeThumbnail(c, thumbnail)
}

func writeThumbnail(c *gin.Context, thumbnail session.Thumbnail) {
	c.Header("Content-Type", "image/jpeg")
	// Clients revalidate each time; unchanged thumbnails answer 304 through Last-Modified.
	c.Header("Cache-Control", "private, no-cache")
	c.Header("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, "", thumbnail.CapturedAt, bytes.NewReader(thumbnail.Image))
}
