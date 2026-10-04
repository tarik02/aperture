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
	"slices"
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

type oauthClientMetadataDocument struct {
	ClientID string `json:"client_id"`
	OAuthClientMetadata
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
}

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
	// The supported-methods list supersedes the legacy single-method preference.
	// Metadata clients can use PKCE without distributing a shared secret.
	if metadata.TokenEndpointAuthMethodsSupported != nil {
		if !slices.Contains(metadata.TokenEndpointAuthMethodsSupported, oauthAuthMethodNone) {
			return nil, oauthError("invalid_client", "client metadata document does not support token_endpoint_auth_method none")
		}
	} else if metadata.TokenEndpointAuthMethod != "" && metadata.TokenEndpointAuthMethod != oauthAuthMethodNone {
		return nil, oauthError("invalid_client", "client metadata document must use token_endpoint_auth_method none")
	}
	metadata.TokenEndpointAuthMethod = oauthAuthMethodNone
	normalized, err := normalizeClientMetadata(metadata.OAuthClientMetadata)
	if err != nil {
		var oauthErr *OAuthError
		if errors.As(err, &oauthErr) {
			return nil, oauthError("invalid_client", oauthErr.Description)
		}
		return nil, err
	}
	client, err := oauthClientRow(clientID, OAuthClientKindMetadataDocument, normalized, nil, o.auth.now().UTC())
	if err != nil {
		return nil, err
	}
	if err := o.repo.UpsertOAuthClient(ctx, client); err != nil {
		return nil, err
	}
	return client, nil
}

func (o *OAuthServer) fetchMetadataDocument(ctx context.Context, clientID string) (oauthClientMetadataDocument, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return oauthClientMetadataDocument{}, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := o.metadataClient.Do(request)
	if err != nil {
		return oauthClientMetadataDocument{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return oauthClientMetadataDocument{}, fmt.Errorf("fetch returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, metadataDocumentMaxBytes+1))
	if err != nil {
		return oauthClientMetadataDocument{}, err
	}
	if len(body) > metadataDocumentMaxBytes {
		return oauthClientMetadataDocument{}, errors.New("document is too large")
	}

	var document oauthClientMetadataDocument
	if err := json.Unmarshal(body, &document); err != nil {
		return oauthClientMetadataDocument{}, fmt.Errorf("decode document: %w", err)
	}
	if document.ClientID != clientID {
		return oauthClientMetadataDocument{}, errors.New("client_id does not match the document URL")
	}
	return document, nil
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
