package traefik

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/deploystate"
	"gopkg.in/yaml.v3"
)

const (
	apiRouterPriority          = 1
	sessionRouterPriority      = 100
	cdpDiscoveryRouterPriority = 110
	cdpWebSocketRouterPriority = 120
)

// RunningSession describes a session that should receive a CDP Traefik route.
type RunningSession struct {
	ID          string
	CDPPort     int
	WrapperPort int
}

// RenderEdgeConfig renders deploy-owned Traefik edge routes.
func RenderEdgeConfig(cfg config.Config, state deploystate.State) ([]byte, error) {
	activeURL, err := deploystate.ActiveURL(state)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}

	serviceName := apiServiceName(state.ActiveColor, state.ActiveVersion)
	doc := dynamicConfig{
		HTTP: httpDynamicConfig{
			Routers:     map[string]routerConfig{},
			Middlewares: map[string]middlewareConfig{},
			Services:    map[string]serviceConfig{},
		},
	}

	doc.HTTP.Routers["aperture-api"] = routerConfig{
		Rule:        apertureCatchAllRule(cfg.CdpRouteBasePath),
		Service:     serviceName,
		Priority:    apiRouterPriority,
		EntryPoints: []string{"web"},
	}
	doc.HTTP.Services[serviceName] = serviceConfig{
		LoadBalancer: loadBalancerConfig{
			Servers: []serverConfig{{URL: activeURL}},
		},
	}

	content, err := marshalDynamicYAML(doc)
	if err != nil {
		return nil, err
	}
	header := "# active color: " + strings.TrimSpace(state.ActiveColor) + "\n"
	if version := strings.TrimSpace(state.ActiveVersion); version != "" {
		header += "# active version: " + strings.ReplaceAll(version, "\n", " ") + "\n"
	}
	return append([]byte(header), content...), nil
}

// RenderSessionsConfig renders active API-owned live session routes.
func RenderSessionsConfig(cfg config.Config, state deploystate.State, running []RunningSession) ([]byte, error) {
	activeURL, err := deploystate.ActiveURL(state)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}

	doc := dynamicConfig{
		HTTP: httpDynamicConfig{
			Routers:     map[string]routerConfig{},
			Middlewares: map[string]middlewareConfig{},
			Services:    map[string]serviceConfig{},
		},
	}

	for _, session := range running {
		if session.ID == "" {
			continue
		}

		sessionBase := "/sessions/" + session.ID
		cdpBase := sessionBase + "/cdp"
		if session.CDPPort > 0 {
			cdpService := cdpServiceName(session.ID)
			doc.HTTP.Routers[cdpWebSocketRouterName(session.ID)] = routerConfig{
				Rule:    cdpWebSocketRouterRule(cdpBase),
				Service: cdpService,
				Middlewares: []string{
					cdpForwardAuthMiddlewareName(session.ID),
					cdpStripMiddlewareName(session.ID),
					cdpWebSocketHeadersMiddlewareName(session.ID),
				},
				Priority:    cdpWebSocketRouterPriority,
				EntryPoints: []string{"web"},
			}
			doc.HTTP.Middlewares[cdpForwardAuthMiddlewareName(session.ID)] = middlewareConfig{
				ForwardAuth: &forwardAuthConfig{
					Address: fmt.Sprintf(
						"%s/internal/forward-auth/cdp/%s",
						strings.TrimRight(activeURL, "/"),
						session.ID,
					),
					AuthRequestHeaders: cdpForwardAuthRequestHeaders(),
				},
			}
			doc.HTTP.Middlewares[cdpStripMiddlewareName(session.ID)] = middlewareConfig{
				ReplacePathRegex: &replacePathRegexConfig{
					Regex:       "^" + regexp.QuoteMeta(cdpBase) + "/[^/]+(?:/(.*))?$",
					Replacement: "/$1",
				},
			}
			doc.HTTP.Middlewares[cdpWebSocketHeadersMiddlewareName(session.ID)] = middlewareConfig{
				Headers: &headersConfig{
					CustomRequestHeaders: map[string]string{
						"Authorization":          "",
						"Cookie":                 "",
						"Sec-WebSocket-Protocol": "",
					},
				},
			}
			passHostHeader := false
			doc.HTTP.Services[cdpService] = serviceConfig{
				LoadBalancer: loadBalancerConfig{
					PassHostHeader: &passHostHeader,
					Servers:        []serverConfig{{URL: fmt.Sprintf("http://127.0.0.1:%d", session.CDPPort)}},
				},
			}
		}

		if session.WrapperPort <= 0 {
			continue
		}

		wrapperService := wrapperServiceName(session.ID)
		doc.HTTP.Services[wrapperService] = serviceConfig{
			LoadBalancer: loadBalancerConfig{
				Servers: []serverConfig{{URL: fmt.Sprintf("http://127.0.0.1:%d", session.WrapperPort)}},
			},
		}

		readAuth := liveSessionForwardAuthMiddlewareName(session.ID, "read")
		writeAuth := liveSessionForwardAuthMiddlewareName(session.ID, "write")
		doc.HTTP.Middlewares[readAuth] = liveSessionForwardAuthMiddleware(activeURL, session.ID, "read")
		doc.HTTP.Middlewares[writeAuth] = liveSessionForwardAuthMiddleware(activeURL, session.ID, "write")

		webrtcStrip := stripSessionPrefixMiddlewareName(session.ID, "webrtc")
		screencastStrip := stripSessionPrefixMiddlewareName(session.ID, "screencast")
		filesStrip := stripSessionPrefixMiddlewareName(session.ID, "files")
		uploadsStrip := stripSessionPrefixMiddlewareName(session.ID, "uploads")
		viewportReplace := replacePathMiddlewareName(session.ID, "browser-viewport")
		statusReplace := replacePathMiddlewareName(session.ID, "browser-status")

		doc.HTTP.Middlewares[webrtcStrip] = middlewareConfig{
			StripPrefix: &stripPrefixConfig{Prefixes: []string{sessionBase}},
		}
		doc.HTTP.Middlewares[screencastStrip] = middlewareConfig{
			StripPrefix: &stripPrefixConfig{Prefixes: []string{sessionBase}},
		}
		doc.HTTP.Middlewares[filesStrip] = middlewareConfig{
			StripPrefix: &stripPrefixConfig{Prefixes: []string{sessionBase}},
		}
		doc.HTTP.Middlewares[uploadsStrip] = middlewareConfig{
			StripPrefix: &stripPrefixConfig{Prefixes: []string{sessionBase}},
		}
		doc.HTTP.Middlewares[viewportReplace] = middlewareConfig{
			ReplacePath: &replacePathConfig{Path: "/viewport"},
		}
		doc.HTTP.Middlewares[statusReplace] = middlewareConfig{
			ReplacePath: &replacePathConfig{Path: "/status"},
		}

		if session.CDPPort > 0 {
			doc.HTTP.Routers[cdpDiscoveryRouterName(session.ID)] = routerConfig{
				Rule:    cdpDiscoveryRouterRule(cdpBase),
				Service: wrapperService,
				Middlewares: []string{
					cdpForwardAuthMiddlewareName(session.ID),
				},
				Priority:    cdpDiscoveryRouterPriority,
				EntryPoints: []string{"web"},
			}
		}

		for _, route := range []struct {
			name        string
			rule        string
			auth        string
			middlewares []string
		}{
			{
				name:        webrtcRouterName(session.ID),
				rule:        pathPrefixRouterRule(sessionBase + "/webrtc/"),
				auth:        writeAuth,
				middlewares: []string{webrtcStrip},
			},
			{
				name:        screencastRouterName(session.ID),
				rule:        pathPrefixRouterRule(sessionBase + "/screencast/"),
				auth:        writeAuth,
				middlewares: []string{screencastStrip},
			},
			{
				name:        browserViewportRouterName(session.ID),
				rule:        pathRouterRule(sessionBase + "/browser/viewport"),
				auth:        writeAuth,
				middlewares: []string{viewportReplace},
			},
			{
				name:        browserStatusRouterName(session.ID),
				rule:        pathRouterRule(sessionBase + "/browser/status"),
				auth:        readAuth,
				middlewares: []string{statusReplace},
			},
			{
				name:        filesRouterName(session.ID),
				rule:        pathTreeRouterRule(sessionBase + "/files"),
				auth:        writeAuth,
				middlewares: []string{filesStrip},
			},
			{
				name:        uploadsRouterName(session.ID),
				rule:        pathTreeRouterRule(sessionBase + "/uploads"),
				auth:        writeAuth,
				middlewares: []string{uploadsStrip},
			},
		} {
			doc.HTTP.Routers[route.name] = routerConfig{
				Rule:        route.rule,
				Service:     wrapperService,
				Middlewares: append([]string{route.auth}, route.middlewares...),
				Priority:    sessionRouterPriority,
				EntryPoints: []string{"web"},
			}
		}
	}

	return marshalDynamicYAML(doc)
}

// RenderStaticConfig renders Traefik static configuration from install parameters.
func RenderStaticConfig(entrypointAddress, dynamicConfigDir string) ([]byte, error) {
	entrypointAddress = strings.TrimSpace(entrypointAddress)
	dynamicConfigDir = strings.TrimSpace(dynamicConfigDir)
	if entrypointAddress == "" {
		return nil, fmt.Errorf("%w: entrypoint address is required", ErrRender)
	}
	if dynamicConfigDir == "" {
		return nil, fmt.Errorf("%w: dynamic config directory is required", ErrRender)
	}

	doc := staticConfig{
		EntryPoints: map[string]entryPointConfig{
			"web": {Address: entrypointAddress},
		},
		Providers: providersConfig{
			File: fileProviderConfig{
				Directory: dynamicConfigDir,
				Watch:     true,
			},
		},
		API: apiConfig{
			Dashboard: false,
			Insecure:  false,
		},
	}

	out, err := yaml.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}
	return out, nil
}

func apertureCatchAllRule(cdpRouteBasePath string) string {
	cdpBase := normalizedCDPRouteBase(cdpRouteBasePath)
	return fmt.Sprintf(
		"PathPrefix(`/`) && !PathPrefix(`/internal`) && !PathPrefix(`%s`)",
		escapeTraefikPath(cdpBase),
	)
}

func normalizedCDPRouteBase(cdpRouteBasePath string) string {
	base := strings.TrimRight(strings.TrimSpace(cdpRouteBasePath), "/")
	if base == "" {
		return "/cdp"
	}
	return base
}

func liveSessionForwardAuthMiddleware(activeURL, sessionID, access string) middlewareConfig {
	return middlewareConfig{
		ForwardAuth: &forwardAuthConfig{
			Address: fmt.Sprintf(
				"%s/internal/forward-auth/live-session/%s/%s",
				strings.TrimRight(activeURL, "/"),
				sessionID,
				access,
			),
			AuthRequestHeaders: liveSessionForwardAuthRequestHeaders(),
			AuthResponseHeaders: []string{
				"Authorization",
				"Sec-WebSocket-Protocol",
				"X-Aperture-Actor-Kind",
				"X-Aperture-Client-IP",
			},
		},
	}
}

func cdpForwardAuthRequestHeaders() []string {
	return []string{"X-Forwarded-Uri"}
}

func liveSessionForwardAuthRequestHeaders() []string {
	return []string{
		"Authorization",
		"Sec-WebSocket-Protocol",
		"X-Aperture-Tenant-Id",
	}
}

func pathRouterRule(routePath string) string {
	return fmt.Sprintf("Path(`%s`)", escapeTraefikPath(routePath))
}

func pathPrefixRouterRule(routePrefix string) string {
	return fmt.Sprintf("PathPrefix(`%s`)", escapeTraefikPath(routePrefix))
}

func pathTreeRouterRule(routePath string) string {
	escaped := escapeTraefikPath(routePath)
	return fmt.Sprintf("Path(`%s`) || PathPrefix(`%s/`)", escaped, escaped)
}

func cdpDiscoveryRouterRule(cdpBase string) string {
	escaped := escapeTraefikPath(cdpBase)
	return fmt.Sprintf(
		"PathPrefix(`%s/cdp_`)",
		escaped,
	)
}

func cdpWebSocketRouterRule(cdpBase string) string {
	return fmt.Sprintf(
		"PathRegexp(`^%s/[^/]+/devtools/`)",
		regexp.QuoteMeta(cdpBase),
	)
}

func cdpDiscoveryRouterName(sessionID string) string {
	return "aperture-cdp-discovery-" + sanitizeName(sessionID)
}

func cdpWebSocketRouterName(sessionID string) string {
	return "aperture-cdp-websocket-" + sanitizeName(sessionID)
}

func webrtcRouterName(sessionID string) string {
	return "aperture-webrtc-" + sanitizeName(sessionID)
}

func screencastRouterName(sessionID string) string {
	return "aperture-screencast-" + sanitizeName(sessionID)
}

func browserViewportRouterName(sessionID string) string {
	return "aperture-browser-viewport-" + sanitizeName(sessionID)
}

func browserStatusRouterName(sessionID string) string {
	return "aperture-browser-status-" + sanitizeName(sessionID)
}

func filesRouterName(sessionID string) string {
	return "aperture-files-" + sanitizeName(sessionID)
}

func uploadsRouterName(sessionID string) string {
	return "aperture-uploads-" + sanitizeName(sessionID)
}

func cdpForwardAuthMiddlewareName(sessionID string) string {
	return "aperture-cdp-forward-auth-" + sanitizeName(sessionID)
}

func cdpStripMiddlewareName(sessionID string) string {
	return "aperture-cdp-strip-" + sanitizeName(sessionID)
}

func cdpWebSocketHeadersMiddlewareName(sessionID string) string {
	return "aperture-cdp-websocket-headers-" + sanitizeName(sessionID)
}

func liveSessionForwardAuthMiddlewareName(sessionID, access string) string {
	return "aperture-live-session-forward-auth-" + sanitizeName(sessionID) + "-" + sanitizeName(access)
}

func stripSessionPrefixMiddlewareName(sessionID, route string) string {
	return "aperture-strip-session-" + sanitizeName(sessionID) + "-" + sanitizeName(route)
}

func replacePathMiddlewareName(sessionID, route string) string {
	return "aperture-replace-path-" + sanitizeName(sessionID) + "-" + sanitizeName(route)
}

func cdpServiceName(sessionID string) string {
	return "aperture-cdp-" + sanitizeName(sessionID)
}

func wrapperServiceName(sessionID string) string {
	return "aperture-wrapper-" + sanitizeName(sessionID)
}

func apiServiceName(color, version string) string {
	name := "aperture-api-" + sanitizeName(color)
	if version = sanitizeName(version); version != "" {
		name += "-" + version
	}
	return name
}

func sanitizeName(value string) string {
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func escapeTraefikPath(path string) string {
	return strings.ReplaceAll(path, "`", "")
}

type dynamicConfig struct {
	HTTP httpDynamicConfig `yaml:"http"`
}

type httpDynamicConfig struct {
	Routers     map[string]routerConfig     `yaml:"routers"`
	Middlewares map[string]middlewareConfig `yaml:"middlewares"`
	Services    map[string]serviceConfig    `yaml:"services"`
}

type routerConfig struct {
	Rule        string   `yaml:"rule"`
	Service     string   `yaml:"service"`
	Middlewares []string `yaml:"middlewares,omitempty"`
	Priority    int      `yaml:"priority"`
	EntryPoints []string `yaml:"entryPoints"`
}

type middlewareConfig struct {
	ForwardAuth      *forwardAuthConfig      `yaml:"forwardAuth,omitempty"`
	StripPrefix      *stripPrefixConfig      `yaml:"stripPrefix,omitempty"`
	ReplacePath      *replacePathConfig      `yaml:"replacePath,omitempty"`
	ReplacePathRegex *replacePathRegexConfig `yaml:"replacePathRegex,omitempty"`
	Headers          *headersConfig          `yaml:"headers,omitempty"`
}

type forwardAuthConfig struct {
	Address             string   `yaml:"address"`
	AuthRequestHeaders  []string `yaml:"authRequestHeaders,omitempty"`
	AuthResponseHeaders []string `yaml:"authResponseHeaders,omitempty"`
}

type stripPrefixConfig struct {
	Prefixes []string `yaml:"prefixes"`
}

type replacePathConfig struct {
	Path string `yaml:"path"`
}

type replacePathRegexConfig struct {
	Regex       string `yaml:"regex"`
	Replacement string `yaml:"replacement"`
}

type headersConfig struct {
	CustomRequestHeaders map[string]string `yaml:"customRequestHeaders"`
}

type serviceConfig struct {
	LoadBalancer loadBalancerConfig `yaml:"loadBalancer"`
}

type loadBalancerConfig struct {
	PassHostHeader *bool          `yaml:"passHostHeader,omitempty"`
	Servers        []serverConfig `yaml:"servers"`
}

type serverConfig struct {
	URL string `yaml:"url"`
}

type staticConfig struct {
	EntryPoints map[string]entryPointConfig `yaml:"entryPoints"`
	Providers   providersConfig             `yaml:"providers"`
	API         apiConfig                   `yaml:"api"`
}

type entryPointConfig struct {
	Address string `yaml:"address"`
}

type providersConfig struct {
	File fileProviderConfig `yaml:"file"`
}

type fileProviderConfig struct {
	Directory string `yaml:"directory"`
	Watch     bool   `yaml:"watch"`
}

type apiConfig struct {
	Dashboard bool `yaml:"dashboard"`
	Insecure  bool `yaml:"insecure"`
}

func marshalDynamicYAML(doc dynamicConfig) ([]byte, error) {
	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	httpNode := yamlMap("routers", routersYAML(doc.HTTP.Routers))
	if len(doc.HTTP.Middlewares) > 0 {
		yamlAppend(httpNode, "middlewares", middlewaresYAML(doc.HTTP.Middlewares))
	}
	yamlAppend(httpNode, "services", servicesYAML(doc.HTTP.Services))
	err := encoder.Encode(yamlMap(
		"http", httpNode,
	))
	if closeErr := encoder.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}
	return buf.Bytes(), nil
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func routersYAML(routers map[string]routerConfig) *yaml.Node {
	node := yamlMap()
	for _, name := range sortedKeys(routers) {
		router := routers[name]
		routerNode := yamlMap(
			"rule", yamlQuotedString(router.Rule),
			"service", yamlString(router.Service),
		)
		if len(router.Middlewares) > 0 {
			yamlAppend(routerNode, "middlewares", yamlStringSequence(router.Middlewares))
		}
		yamlAppend(routerNode, "priority", yamlInt(router.Priority))
		yamlAppend(routerNode, "entryPoints", yamlStringSequence(router.EntryPoints))
		yamlAppend(node, name, routerNode)
	}
	return node
}

func middlewaresYAML(middlewares map[string]middlewareConfig) *yaml.Node {
	node := yamlMap()
	for _, name := range sortedKeys(middlewares) {
		middleware := middlewares[name]
		switch {
		case middleware.ForwardAuth != nil:
			forwardAuth := yamlMap("address", yamlQuotedString(middleware.ForwardAuth.Address))
			if len(middleware.ForwardAuth.AuthRequestHeaders) > 0 {
				yamlAppend(
					forwardAuth,
					"authRequestHeaders",
					yamlStringSequence(middleware.ForwardAuth.AuthRequestHeaders),
				)
			}
			if len(middleware.ForwardAuth.AuthResponseHeaders) > 0 {
				yamlAppend(
					forwardAuth,
					"authResponseHeaders",
					yamlStringSequence(middleware.ForwardAuth.AuthResponseHeaders),
				)
			}
			yamlAppend(node, name, yamlMap(
				"forwardAuth", forwardAuth,
			))
		case middleware.StripPrefix != nil:
			yamlAppend(node, name, yamlMap(
				"stripPrefix", yamlMap("prefixes", yamlStringSequence(middleware.StripPrefix.Prefixes)),
			))
		case middleware.ReplacePath != nil:
			yamlAppend(node, name, yamlMap(
				"replacePath", yamlMap("path", yamlQuotedString(middleware.ReplacePath.Path)),
			))
		case middleware.ReplacePathRegex != nil:
			yamlAppend(node, name, yamlMap(
				"replacePathRegex", yamlMap(
					"regex", yamlQuotedString(middleware.ReplacePathRegex.Regex),
					"replacement", yamlQuotedString(middleware.ReplacePathRegex.Replacement),
				),
			))
		case middleware.Headers != nil:
			yamlAppend(node, name, yamlMap(
				"headers", yamlMap(
					"customRequestHeaders", yamlStringMap(middleware.Headers.CustomRequestHeaders),
				),
			))
		}
	}
	return node
}

func servicesYAML(services map[string]serviceConfig) *yaml.Node {
	node := yamlMap()
	for _, name := range sortedKeys(services) {
		service := services[name]
		servers := &yaml.Node{Kind: yaml.SequenceNode}
		for _, server := range service.LoadBalancer.Servers {
			servers.Content = append(servers.Content, yamlMap("url", yamlQuotedString(server.URL)))
		}
		loadBalancer := yamlMap("servers", servers)
		if service.LoadBalancer.PassHostHeader != nil {
			yamlAppend(loadBalancer, "passHostHeader", yamlBool(*service.LoadBalancer.PassHostHeader))
		}
		yamlAppend(node, name, yamlMap("loadBalancer", loadBalancer))
	}
	return node
}

func yamlMap(pairs ...any) *yaml.Node {
	node := &yaml.Node{Kind: yaml.MappingNode}
	for i := 0; i < len(pairs); i += 2 {
		yamlAppend(node, pairs[i].(string), pairs[i+1].(*yaml.Node))
	}
	return node
}

func yamlAppend(node *yaml.Node, key string, value *yaml.Node) {
	node.Content = append(node.Content, yamlString(key), value)
}

func yamlString(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func yamlQuotedString(value string) *yaml.Node {
	node := yamlString(value)
	node.Style = yaml.DoubleQuotedStyle
	return node
}

func yamlInt(value int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(value)}
}

func yamlBool(value bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(value)}
}

func yamlStringSequence(values []string) *yaml.Node {
	node := &yaml.Node{Kind: yaml.SequenceNode}
	for _, value := range values {
		node.Content = append(node.Content, yamlString(value))
	}
	return node
}

func yamlStringMap(values map[string]string) *yaml.Node {
	node := yamlMap()
	for _, key := range sortedKeys(values) {
		yamlAppend(node, key, yamlQuotedString(values[key]))
	}
	return node
}

// RunningSessionsFromDB converts running session rows into render input.
func RunningSessionsFromDB(sessions []db.Session) []RunningSession {
	running := make([]RunningSession, 0, len(sessions))
	for _, session := range sessions {
		if session.CurrentCDPPort == nil || *session.CurrentCDPPort <= 0 {
			continue
		}
		view := RunningSession{
			ID:      session.ID,
			CDPPort: *session.CurrentCDPPort,
		}
		if session.RuntimeEnvPath != nil {
			body, err := os.ReadFile(*session.RuntimeEnvPath)
			if err == nil {
				values, err := browser.ParseRuntimeEnv(body)
				if err == nil {
					view.WrapperPort = values.WrapperPort
				}
			}
		}
		running = append(running, view)
	}
	sort.Slice(running, func(i, j int) bool {
		return running[i].ID < running[j].ID
	})
	return running
}
