package browser

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"path"
	"strings"
)

const (
	MaxSessionInitializationBytes = 64 * 1024 * 1024
	MaxInitialTargets             = 50
	MaxInitialCookies             = 10000
	MaxInitialStorageOrigins      = 100
	maxInitialAncestorOrigins     = 32
	maxInitialDocumentBytes       = 32 * 1024 * 1024
	maxInitialDOMEntries          = 10000
	maxInitialElementPath         = 256
)

// InitialTarget describes a browser target created during session startup.
type InitialTarget struct {
	URL               string                       `json:"url"`
	SessionStorage    []InitialTargetStorageOrigin `json:"sessionStorage,omitempty"`
	Scroll            *InitialScrollPosition       `json:"scroll,omitempty"`
	DocumentState     *InitialDocumentState        `json:"documentState,omitempty"`
	OpenerTargetIndex *int                         `json:"openerTargetIndex,omitempty"`
	Active            bool                         `json:"active,omitempty"`
}

// InitialTargetStorageOrigin contains session storage for one origin in a target's browsing context.
type InitialTargetStorageOrigin struct {
	Origin  string                `json:"origin"`
	Entries []BrowserStorageEntry `json:"entries"`
}

// InitialScrollPosition is restored after the target document loads.
type InitialScrollPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// InitialElementPathStep identifies a same-tag child below the document element.
type InitialElementPathStep struct {
	Tag   string `json:"tag"`
	Index int    `json:"index"`
}

// InitialElementLocator combines semantic identity with a structural fallback.
type InitialElementLocator struct {
	Tag          string                   `json:"tag"`
	ID           string                   `json:"id,omitempty"`
	Name         string                   `json:"name,omitempty"`
	InputType    string                   `json:"inputType,omitempty"`
	Autocomplete string                   `json:"autocomplete,omitempty"`
	AriaLabel    string                   `json:"ariaLabel,omitempty"`
	Placeholder  string                   `json:"placeholder,omitempty"`
	Path         []InitialElementPathStep `json:"path"`
}

// InitialControlSelection describes an input or textarea selection.
type InitialControlSelection struct {
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Direction string `json:"direction"`
}

// InitialControlState contains mutable state for one form control.
type InitialControlState struct {
	Locator         InitialElementLocator    `json:"locator"`
	Value           string                   `json:"value"`
	Checked         *bool                    `json:"checked,omitempty"`
	SelectedIndices *[]int                   `json:"selectedIndices,omitempty"`
	Selection       *InitialControlSelection `json:"selection,omitempty"`
}

// InitialContentEditableState contains mutable markup for one editing host.
type InitialContentEditableState struct {
	Locator InitialElementLocator `json:"locator"`
	HTML    string                `json:"html"`
}

// InitialElementScrollPosition describes one non-root scroll container.
type InitialElementScrollPosition struct {
	Locator InitialElementLocator `json:"locator"`
	X       float64               `json:"x"`
	Y       float64               `json:"y"`
}

// InitialSelectionEndpoint identifies a DOM selection endpoint relative to an element.
type InitialSelectionEndpoint struct {
	Locator  InitialElementLocator `json:"locator"`
	NodePath []int                 `json:"nodePath"`
	Offset   int                   `json:"offset"`
}

// InitialDocumentSelection describes the anchor and focus of a DOM selection.
type InitialDocumentSelection struct {
	Anchor InitialSelectionEndpoint `json:"anchor"`
	Focus  InitialSelectionEndpoint `json:"focus"`
}

// InitialDocumentState is sensitive top-document state replayed during navigation.
type InitialDocumentState struct {
	Version          int                            `json:"version"`
	WindowName       *string                        `json:"windowName,omitempty"`
	HistoryState     *string                        `json:"historyState,omitempty"`
	Controls         []InitialControlState          `json:"controls"`
	ContentEditables []InitialContentEditableState  `json:"contentEditables"`
	ScrollPositions  []InitialElementScrollPosition `json:"scrollPositions"`
	Focus            *InitialElementLocator         `json:"focus,omitempty"`
	Selection        *InitialDocumentSelection      `json:"selection,omitempty"`
}

// CookieSameSite is a Chromium cookie SameSite value.
type CookieSameSite string

const (
	CookieSameSiteStrict CookieSameSite = "Strict"
	CookieSameSiteLax    CookieSameSite = "Lax"
	CookieSameSiteNone   CookieSameSite = "None"
)

// InitialCookie is a cookie imported while creating a session.
type InitialCookie struct {
	Name         string                     `json:"name"`
	Value        string                     `json:"value"`
	Domain       string                     `json:"domain"`
	Path         string                     `json:"path"`
	Expires      *float64                   `json:"expires,omitempty"`
	HTTPOnly     bool                       `json:"httpOnly,omitempty"`
	Secure       bool                       `json:"secure,omitempty"`
	SameSite     CookieSameSite             `json:"sameSite,omitempty"`
	PartitionKey *InitialCookiePartitionKey `json:"partitionKey,omitempty"`
}

// InitialCookiePartitionKey retains Chromium CHIPS partition metadata.
type InitialCookiePartitionKey struct {
	TopLevelSite         string `json:"topLevelSite"`
	HasCrossSiteAncestor bool   `json:"hasCrossSiteAncestor"`
}

// BrowserStorageEntry is one imported Web Storage key and value.
type BrowserStorageEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// InitialIndexedDBKeyPath retains the distinction between absent, scalar, and array key paths.
type InitialIndexedDBKeyPath struct {
	Kind  string   `json:"kind"`
	Value []string `json:"value,omitempty"`
}

// InitialIndexedDBIndex describes one object-store index.
type InitialIndexedDBIndex struct {
	Name       string                  `json:"name"`
	KeyPath    InitialIndexedDBKeyPath `json:"keyPath"`
	Unique     bool                    `json:"unique"`
	MultiEntry bool                    `json:"multiEntry"`
}

// InitialIndexedDBRecord contains JSON-encoded structured-clone key and value payloads.
type InitialIndexedDBRecord struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// InitialIndexedDBObjectStore describes one database object store and its records.
type InitialIndexedDBObjectStore struct {
	Name          string                   `json:"name"`
	KeyPath       InitialIndexedDBKeyPath  `json:"keyPath"`
	AutoIncrement bool                     `json:"autoIncrement"`
	Indexes       []InitialIndexedDBIndex  `json:"indexes"`
	Records       []InitialIndexedDBRecord `json:"records"`
}

// InitialIndexedDBDatabase describes one origin database.
type InitialIndexedDBDatabase struct {
	Name         string                        `json:"name"`
	Version      uint64                        `json:"version"`
	ObjectStores []InitialIndexedDBObjectStore `json:"objectStores"`
}

// InitialCacheStorageEntry contains one cached HTTP response.
type InitialCacheStorageEntry struct {
	URL                string            `json:"url"`
	RequestHeaders     map[string]string `json:"requestHeaders"`
	ResponseHeaders    map[string]string `json:"responseHeaders"`
	ResponseStatus     int               `json:"responseStatus"`
	ResponseStatusText string            `json:"responseStatusText"`
	ResponseBody       string            `json:"responseBody"`
}

// InitialCacheStorageCache contains one named Cache Storage cache.
type InitialCacheStorageCache struct {
	Name    string                     `json:"name"`
	Entries []InitialCacheStorageEntry `json:"entries"`
}

// InitialOPFSFile contains one origin-private filesystem file.
type InitialOPFSFile struct {
	Path string `json:"path"`
	Body string `json:"body"`
}

// InitialStorageOrigin contains profile-scoped storage imported for one HTTP origin and partition.
type InitialStorageOrigin struct {
	Origin          string                     `json:"origin"`
	AncestorOrigins []string                   `json:"ancestorOrigins,omitempty"`
	LocalStorage    []BrowserStorageEntry      `json:"localStorage"`
	IndexedDB       []InitialIndexedDBDatabase `json:"indexedDB,omitempty"`
	CacheStorage    []InitialCacheStorageCache `json:"cacheStorage,omitempty"`
	OPFS            []InitialOPFSFile          `json:"opfs,omitempty"`
}

// InitialStorageState contains browser storage imported during session startup.
type InitialStorageState struct {
	Cookies []InitialCookie        `json:"cookies"`
	Origins []InitialStorageOrigin `json:"origins"`
}

// SessionInitialization is optional browser state applied during session creation.
type SessionInitialization struct {
	Targets      []InitialTarget      `json:"initialTargets,omitempty"`
	StorageState *InitialStorageState `json:"storageState,omitempty"`
}

// Empty reports whether session creation can skip browser initialization.
func (input SessionInitialization) Empty() bool {
	return len(input.Targets) == 0 && input.StorageState == nil
}

// Validate checks browser initialization before a runtime is started.
func (input SessionInitialization) Validate() error {
	if len(input.Targets) > MaxInitialTargets {
		return fmt.Errorf("initialTargets must contain at most %d entries", MaxInitialTargets)
	}
	activeTargets := 0
	for index, target := range input.Targets {
		if err := validateHTTPURL(target.URL); err != nil {
			return fmt.Errorf("initialTargets[%d].url: %w", index, err)
		}
		if err := validateTargetSessionStorage(target.SessionStorage); err != nil {
			return fmt.Errorf("initialTargets[%d].sessionStorage: %w", index, err)
		}
		if target.Scroll != nil && (!finite(target.Scroll.X) || !finite(target.Scroll.Y)) {
			return fmt.Errorf("initialTargets[%d].scroll must contain finite coordinates", index)
		}
		if target.DocumentState != nil {
			if err := target.DocumentState.Validate(); err != nil {
				return fmt.Errorf("initialTargets[%d].documentState: %w", index, err)
			}
		}
		if target.OpenerTargetIndex != nil {
			if *target.OpenerTargetIndex < 0 || *target.OpenerTargetIndex >= len(input.Targets) {
				return fmt.Errorf("initialTargets[%d].openerTargetIndex is out of range", index)
			}
			if *target.OpenerTargetIndex == index {
				return fmt.Errorf("initialTargets[%d].openerTargetIndex must reference another target", index)
			}
		}
		if target.Active {
			activeTargets++
		}
	}
	if activeTargets > 1 {
		return errors.New("initialTargets must contain at most one active target")
	}
	visiting := make([]bool, len(input.Targets))
	visited := make([]bool, len(input.Targets))
	var visit func(int) error
	visit = func(index int) error {
		if visiting[index] {
			return errors.New("initialTargets opener relationships must not contain a cycle")
		}
		if visited[index] {
			return nil
		}
		visiting[index] = true
		if opener := input.Targets[index].OpenerTargetIndex; opener != nil {
			if err := visit(*opener); err != nil {
				return err
			}
		}
		visiting[index] = false
		visited[index] = true
		return nil
	}
	for index := range input.Targets {
		if err := visit(index); err != nil {
			return err
		}
	}
	if input.StorageState == nil {
		return nil
	}
	return input.StorageState.Validate()
}

// Validate checks target document state at the API boundary.
func (state InitialDocumentState) Validate() error {
	if state.Version != 1 {
		return errors.New("version must be 1")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return errors.New("must be JSON encodable")
	}
	if len(encoded) > maxInitialDocumentBytes {
		return errors.New("must not exceed 32 MiB")
	}
	if state.HistoryState != nil && !json.Valid([]byte(*state.HistoryState)) {
		return errors.New("historyState must contain valid structured-clone JSON")
	}
	if len(state.Controls) > maxInitialDOMEntries || len(state.ContentEditables) > maxInitialDOMEntries || len(state.ScrollPositions) > maxInitialDOMEntries {
		return fmt.Errorf("DOM state collections must contain at most %d entries", maxInitialDOMEntries)
	}
	for index, control := range state.Controls {
		if err := control.Locator.validate(); err != nil {
			return fmt.Errorf("controls[%d].locator: %w", index, err)
		}
		if control.SelectedIndices != nil {
			for _, selectedIndex := range *control.SelectedIndices {
				if selectedIndex < 0 {
					return fmt.Errorf("controls[%d].selectedIndices must be non-negative", index)
				}
			}
		}
		if control.Selection != nil {
			if control.Selection.Start < 0 || control.Selection.End < control.Selection.Start {
				return fmt.Errorf("controls[%d].selection must contain an ordered non-negative range", index)
			}
			switch control.Selection.Direction {
			case "forward", "backward", "none":
			default:
				return fmt.Errorf("controls[%d].selection.direction must be forward, backward, or none", index)
			}
		}
	}
	for index, editable := range state.ContentEditables {
		if err := editable.Locator.validate(); err != nil {
			return fmt.Errorf("contentEditables[%d].locator: %w", index, err)
		}
	}
	for index, position := range state.ScrollPositions {
		if err := position.Locator.validate(); err != nil {
			return fmt.Errorf("scrollPositions[%d].locator: %w", index, err)
		}
		if !finite(position.X) || !finite(position.Y) {
			return fmt.Errorf("scrollPositions[%d] must contain finite coordinates", index)
		}
	}
	if state.Focus != nil {
		if err := state.Focus.validate(); err != nil {
			return fmt.Errorf("focus: %w", err)
		}
	}
	if state.Selection != nil {
		if err := state.Selection.Anchor.validate(); err != nil {
			return fmt.Errorf("selection.anchor: %w", err)
		}
		if err := state.Selection.Focus.validate(); err != nil {
			return fmt.Errorf("selection.focus: %w", err)
		}
	}
	return nil
}

func (locator InitialElementLocator) validate() error {
	if !validElementTag(locator.Tag) {
		return errors.New("tag must be a lowercase HTML tag name")
	}
	if len(locator.Path) > maxInitialElementPath {
		return fmt.Errorf("path must contain at most %d entries", maxInitialElementPath)
	}
	for index, step := range locator.Path {
		if !validElementTag(step.Tag) || step.Index < 0 {
			return fmt.Errorf("path[%d] must contain a lowercase tag and non-negative index", index)
		}
	}
	return nil
}

func (endpoint InitialSelectionEndpoint) validate() error {
	if err := endpoint.Locator.validate(); err != nil {
		return err
	}
	if endpoint.Offset < 0 || len(endpoint.NodePath) > maxInitialElementPath {
		return errors.New("nodePath and offset must be non-negative and bounded")
	}
	for _, index := range endpoint.NodePath {
		if index < 0 {
			return errors.New("nodePath entries must be non-negative")
		}
	}
	return nil
}

func validElementTag(value string) bool {
	if value == "" {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' {
			continue
		}
		if index > 0 && ((character >= '0' && character <= '9') || character == '-') {
			continue
		}
		return false
	}
	return true
}

func validateTargetSessionStorage(origins []InitialTargetStorageOrigin) error {
	seen := make(map[string]struct{}, len(origins))
	for index, origin := range origins {
		canonical, err := canonicalHTTPOrigin(origin.Origin)
		if err != nil {
			return fmt.Errorf("origin %d: %w", index, err)
		}
		if _, exists := seen[canonical]; exists {
			return fmt.Errorf("origin %d duplicates %s", index, canonical)
		}
		seen[canonical] = struct{}{}
		if err := validateStorageEntries(origin.Entries); err != nil {
			return fmt.Errorf("origin %d entries: %w", index, err)
		}
	}
	return nil
}

// Validate checks imported cookies and origin-local storage.
func (state InitialStorageState) Validate() error {
	if len(state.Cookies) > MaxInitialCookies {
		return fmt.Errorf("storageState.cookies must contain at most %d entries", MaxInitialCookies)
	}
	if len(state.Origins) > MaxInitialStorageOrigins {
		return fmt.Errorf("storageState.origins must contain at most %d entries", MaxInitialStorageOrigins)
	}
	cookieKeys := make(map[string]struct{}, len(state.Cookies))
	for index, cookie := range state.Cookies {
		if err := cookie.Validate(); err != nil {
			return fmt.Errorf("storageState.cookies[%d]: %w", index, err)
		}
		partition := ""
		if cookie.PartitionKey != nil {
			partition = strings.ToLower(cookie.PartitionKey.TopLevelSite)
		}
		key := cookie.Name + "\x00" + strings.ToLower(cookie.Domain) + "\x00" + cookie.Path + "\x00" + partition
		if _, exists := cookieKeys[key]; exists {
			return fmt.Errorf("storageState.cookies[%d]: duplicate cookie", index)
		}
		cookieKeys[key] = struct{}{}
	}

	origins := make(map[string]struct{}, len(state.Origins))
	for index, origin := range state.Origins {
		canonical, err := canonicalHTTPOrigin(origin.Origin)
		if err != nil {
			return fmt.Errorf("storageState.origins[%d]: %w", index, err)
		}
		if err := origin.Validate(); err != nil {
			return fmt.Errorf("storageState.origins[%d]: %w", index, err)
		}
		partition := canonical
		for _, ancestor := range origin.AncestorOrigins {
			canonicalAncestor, err := canonicalHTTPOrigin(ancestor)
			if err != nil {
				return fmt.Errorf("storageState.origins[%d].ancestorOrigins: %w", index, err)
			}
			partition += "\x00" + canonicalAncestor
		}
		if _, exists := origins[partition]; exists {
			return fmt.Errorf("storageState.origins[%d]: duplicate storage partition", index)
		}
		origins[partition] = struct{}{}
	}
	return nil
}

// Validate checks an imported cookie.
func (cookie InitialCookie) Validate() error {
	if strings.TrimSpace(cookie.Name) == "" {
		return errors.New("name is required")
	}
	if strings.TrimSpace(cookie.Domain) == "" {
		return errors.New("domain is required")
	}
	if !strings.HasPrefix(cookie.Path, "/") {
		return errors.New("path must start with /")
	}
	if cookie.Expires != nil && (math.IsNaN(*cookie.Expires) || math.IsInf(*cookie.Expires, 0) || *cookie.Expires <= 0) {
		return errors.New("expires must be a positive finite Unix timestamp")
	}
	switch cookie.SameSite {
	case "", CookieSameSiteStrict, CookieSameSiteLax, CookieSameSiteNone:
		if cookie.PartitionKey != nil {
			if _, err := canonicalHTTPOrigin(cookie.PartitionKey.TopLevelSite); err != nil {
				return fmt.Errorf("partitionKey.topLevelSite: %w", err)
			}
		}
		return nil
	default:
		return errors.New("sameSite must be Strict, Lax, or None")
	}
}

// Validate checks imported local storage for one origin.
func (origin InitialStorageOrigin) Validate() error {
	if _, err := canonicalHTTPOrigin(origin.Origin); err != nil {
		return err
	}
	if len(origin.AncestorOrigins) > maxInitialAncestorOrigins {
		return fmt.Errorf("ancestorOrigins must contain at most %d entries", maxInitialAncestorOrigins)
	}
	for index, ancestor := range origin.AncestorOrigins {
		if _, err := canonicalHTTPOrigin(ancestor); err != nil {
			return fmt.Errorf("ancestorOrigins[%d]: %w", index, err)
		}
	}
	if err := origin.validateLocalStorage(); err != nil {
		return err
	}
	if err := validateIndexedDB(origin.IndexedDB); err != nil {
		return fmt.Errorf("indexedDB: %w", err)
	}
	if err := validateCacheStorage(origin.CacheStorage); err != nil {
		return fmt.Errorf("cacheStorage: %w", err)
	}
	return validateOPFS(origin.OPFS)
}

func (origin InitialStorageOrigin) validateLocalStorage() error {
	return validateStorageEntries(origin.LocalStorage)
}

func validateStorageEntries(entries []BrowserStorageEntry) error {
	keys := make(map[string]struct{}, len(entries))
	for index, entry := range entries {
		if _, exists := keys[entry.Name]; exists {
			return fmt.Errorf("entry %d duplicates name %q", index, entry.Name)
		}
		keys[entry.Name] = struct{}{}
	}
	return nil
}

func validateIndexedDB(databases []InitialIndexedDBDatabase) error {
	names := make(map[string]struct{}, len(databases))
	for databaseIndex, database := range databases {
		if database.Version == 0 {
			return fmt.Errorf("database %d must have a positive version", databaseIndex)
		}
		if _, exists := names[database.Name]; exists {
			return fmt.Errorf("database %d duplicates name %q", databaseIndex, database.Name)
		}
		names[database.Name] = struct{}{}
		stores := make(map[string]struct{}, len(database.ObjectStores))
		for storeIndex, store := range database.ObjectStores {
			if _, exists := stores[store.Name]; exists {
				return fmt.Errorf("database %d object store %d duplicates name %q", databaseIndex, storeIndex, store.Name)
			}
			stores[store.Name] = struct{}{}
			if err := validateIndexedDBKeyPath(store.KeyPath); err != nil {
				return fmt.Errorf("database %d object store %d keyPath: %w", databaseIndex, storeIndex, err)
			}
			indexes := make(map[string]struct{}, len(store.Indexes))
			for indexIndex, index := range store.Indexes {
				if _, exists := indexes[index.Name]; exists {
					return fmt.Errorf("database %d object store %d index %d duplicates name %q", databaseIndex, storeIndex, indexIndex, index.Name)
				}
				indexes[index.Name] = struct{}{}
				if err := validateIndexedDBKeyPath(index.KeyPath); err != nil {
					return fmt.Errorf("database %d object store %d index %d keyPath: %w", databaseIndex, storeIndex, indexIndex, err)
				}
			}
			for recordIndex, record := range store.Records {
				if !json.Valid([]byte(record.Key)) || !json.Valid([]byte(record.Value)) {
					return fmt.Errorf("database %d object store %d record %d contains invalid structured-clone JSON", databaseIndex, storeIndex, recordIndex)
				}
			}
		}
	}
	return nil
}

func validateIndexedDBKeyPath(keyPath InitialIndexedDBKeyPath) error {
	switch keyPath.Kind {
	case "none":
		if len(keyPath.Value) != 0 {
			return errors.New("none key path must not have a value")
		}
	case "string":
		if len(keyPath.Value) != 1 {
			return errors.New("string key path must contain exactly one value")
		}
	case "array":
		if len(keyPath.Value) == 0 {
			return errors.New("array key path must contain at least one value")
		}
	default:
		return errors.New("kind must be none, string, or array")
	}
	return nil
}

func validateCacheStorage(caches []InitialCacheStorageCache) error {
	names := make(map[string]struct{}, len(caches))
	for cacheIndex, cache := range caches {
		if _, exists := names[cache.Name]; exists {
			return fmt.Errorf("cache %d duplicates name %q", cacheIndex, cache.Name)
		}
		names[cache.Name] = struct{}{}
		for entryIndex, entry := range cache.Entries {
			if err := validateHTTPURL(entry.URL); err != nil {
				return fmt.Errorf("cache %d entry %d URL: %w", cacheIndex, entryIndex, err)
			}
			if entry.ResponseStatus < 100 || entry.ResponseStatus > 599 {
				return fmt.Errorf("cache %d entry %d responseStatus must be between 100 and 599", cacheIndex, entryIndex)
			}
			if !validBase64(entry.ResponseBody) {
				return fmt.Errorf("cache %d entry %d responseBody must be valid base64", cacheIndex, entryIndex)
			}
		}
	}
	return nil
}

func validateOPFS(files []InitialOPFSFile) error {
	paths := make(map[string]struct{}, len(files))
	for index, file := range files {
		cleaned := path.Clean(file.Path)
		if file.Path == "" || strings.HasPrefix(file.Path, "/") || cleaned == "." || cleaned != file.Path || strings.HasPrefix(cleaned, "../") {
			return fmt.Errorf("opfs[%d].path must be a normalized relative path", index)
		}
		if _, exists := paths[file.Path]; exists {
			return fmt.Errorf("opfs[%d] duplicates path %q", index, file.Path)
		}
		if !validBase64(file.Body) {
			return fmt.Errorf("opfs[%d].body must be valid base64", index)
		}
		paths[file.Path] = struct{}{}
	}
	return nil
}

func validBase64(value string) bool {
	_, err := io.Copy(io.Discard, base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(value)))
	return err == nil
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func canonicalHTTPOrigin(rawOrigin string) (string, error) {
	parsed, err := url.Parse(rawOrigin)
	if err != nil || !validHTTPScheme(parsed.Scheme) || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return "", errors.New("origin must contain only an http or https scheme and host")
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	host := hostname
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	return scheme + "://" + host, nil
}

func validateHTTPURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || !validHTTPScheme(parsed.Scheme) || parsed.Host == "" || parsed.User != nil {
		return errors.New("must be an absolute http or https URL without embedded credentials")
	}
	return nil
}

func validHTTPScheme(scheme string) bool {
	return strings.EqualFold(scheme, "http") || strings.EqualFold(scheme, "https")
}
