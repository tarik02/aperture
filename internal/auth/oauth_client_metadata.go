package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"syscall"
	"time"

	"github.com/aperture/aperture/internal/db"
)

const (
	metadataDocumentMaxBytes = 64 << 10
	// metadataDocumentRefresh bounds how stale a cached metadata document may
	// be; the consent flow resolves the same client several times in a row.
	metadataDocumentRefresh = 5 * time.Minute
)

// isMetadataDocumentClientID reports whether clientID is a Client ID Metadata
// Document URL: an https URL with a path component.
func isMetadataDocumentClientID(clientID string) bool {
	parsed, err := url.Parse(clientID)
	return err == nil &&
		parsed.Scheme == "https" &&
		parsed.Host != "" &&
		parsed.User == nil &&
		parsed.Fragment == "" &&
		parsed.Path != "" &&
		parsed.Path != "/"
}

func (o *OAuthServer) metadataDocumentClient(ctx context.Context, clientID string) (*db.OAuthClient, error) {
	cached, err := o.repo.GetOAuthClient(ctx, clientID)
	if err != nil {
		return nil, err
	}
	if cached != nil {
		updatedAt, err := time.Parse(time.RFC3339Nano, cached.UpdatedAt)
		if err == nil && o.auth.now().Sub(updatedAt) < metadataDocumentRefresh {
			return cached, nil
		}
	}

	metadata, err := o.fetchMetadataDocument(ctx, clientID)
	if err != nil {
		return nil, oauthError("invalid_client", fmt.Sprintf("client metadata document: %v", err))
	}
	// Metadata documents are public; a shared secret cannot be distributed.
	if metadata.TokenEndpointAuthMethod != "" && metadata.TokenEndpointAuthMethod != oauthAuthMethodNone {
		return nil, oauthError("invalid_client", "client metadata document must use token_endpoint_auth_method none")
	}
	metadata.TokenEndpointAuthMethod = oauthAuthMethodNone
	normalized, err := normalizeClientMetadata(metadata)
	if err != nil {
		var oauthErr *OAuthError
		if errors.As(err, &oauthErr) {
			return nil, oauthError("invalid_client", oauthErr.Description)
		}
		return nil, err
	}
	client, err := oauthClientRow(clientID, OAuthClientKindMetadataDocument, normalized, nil)
	if err != nil {
		return nil, err
	}
	if err := o.repo.UpsertOAuthClient(ctx, client); err != nil {
		return nil, err
	}
	return client, nil
}

func (o *OAuthServer) fetchMetadataDocument(ctx context.Context, clientID string) (OAuthClientMetadata, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return OAuthClientMetadata{}, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := o.metadataClient.Do(request)
	if err != nil {
		return OAuthClientMetadata{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return OAuthClientMetadata{}, fmt.Errorf("fetch returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, metadataDocumentMaxBytes+1))
	if err != nil {
		return OAuthClientMetadata{}, err
	}
	if len(body) > metadataDocumentMaxBytes {
		return OAuthClientMetadata{}, errors.New("document is too large")
	}

	var document struct {
		ClientID string `json:"client_id"`
		OAuthClientMetadata
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return OAuthClientMetadata{}, fmt.Errorf("decode document: %w", err)
	}
	if document.ClientID != clientID {
		return OAuthClientMetadata{}, errors.New("client_id does not match the document URL")
	}
	return document.OAuthClientMetadata, nil
}

// newMetadataDocumentHTTPClient fetches client-supplied URLs, so it refuses
// to connect to non-public addresses and does not follow redirects.
func newMetadataDocumentHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			addr, err := netip.ParseAddr(host)
			if err != nil {
				return err
			}
			if !isPublicAddr(addr) {
				return fmt.Errorf("refusing to connect to non-public address %s", addr)
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext:         dialer.DialContext,
			TLSHandshakeTimeout: 5 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not followed")
		},
	}
}

var sharedAddressSpace = netip.MustParsePrefix("100.64.0.0/10")

func isPublicAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	return addr.IsGlobalUnicast() && !addr.IsPrivate() && !sharedAddressSpace.Contains(addr)
}
