package traefik

import (
	"bytes"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"gopkg.in/yaml.v3"
)

const (
	apiRouterPriority = 1
	cdpRouterPriority = 100
)

// CDPRoutableSession describes a session that should receive a CDP Traefik route.
type CDPRoutableSession struct {
	ID string
}

// RenderDynamicConfig renders Traefik file-provider dynamic configuration.
func RenderDynamicConfig(cfg config.Config, sessions []CDPRoutableSession) ([]byte, error) {
	apertureURL, err := apertureBaseURL(cfg.ListenAddress)
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

	doc.HTTP.Routers["aperture-api"] = routerConfig{
		Rule:        apertureCatchAllRule(cfg.CdpRouteBasePath),
		Service:     "aperture-api",
		Priority:    apiRouterPriority,
		EntryPoints: []string{"web"},
	}
	doc.HTTP.Services["aperture-api"] = serviceConfig{
		LoadBalancer: loadBalancerConfig{
			Servers: []serverConfig{{URL: apertureURL}},
		},
	}

	cdpBase := normalizedCDPRouteBase(cfg.CdpRouteBasePath)
	for _, session := range sessions {
		if session.ID == "" {
			continue
		}

		routerName := cdpRouterName(session.ID)
		middlewareName := cdpMiddlewareName(session.ID)
		routePrefix := fmt.Sprintf("%s/%s", cdpBase, session.ID)
		forwardAuthURL := fmt.Sprintf(
			"%s/internal/forward-auth/cdp/%s",
			strings.TrimRight(apertureURL, "/"),
			session.ID,
		)

		doc.HTTP.Routers[routerName] = routerConfig{
			Rule:        cdpRouterRule(routePrefix),
			Service:     "aperture-api",
			Middlewares: []string{middlewareName},
			Priority:    cdpRouterPriority,
			EntryPoints: []string{"web"},
		}
		doc.HTTP.Middlewares[middlewareName] = middlewareConfig{
			ForwardAuth: &forwardAuthConfig{
				Address: forwardAuthURL,
			},
		}
	}

	return marshalDynamicYAML(doc)
}

// RenderStaticConfig renders Traefik static configuration from install parameters.
func RenderStaticConfig(entrypointAddress, dynamicConfigPath string) ([]byte, error) {
	entrypointAddress = strings.TrimSpace(entrypointAddress)
	dynamicConfigPath = strings.TrimSpace(dynamicConfigPath)
	if entrypointAddress == "" {
		return nil, fmt.Errorf("%w: entrypoint address is required", ErrRender)
	}
	if dynamicConfigPath == "" {
		return nil, fmt.Errorf("%w: dynamic config path is required", ErrRender)
	}

	doc := staticConfig{
		EntryPoints: map[string]entryPointConfig{
			"web": {Address: entrypointAddress},
		},
		Providers: providersConfig{
			File: fileProviderConfig{
				Filename: dynamicConfigPath,
				Watch:    true,
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

func cdpRouterRule(routePrefix string) string {
	escaped := escapeTraefikPath(routePrefix)
	return fmt.Sprintf("Path(`%s`) || PathPrefix(`%s/`)", escaped, escaped)
}

func apertureBaseURL(listenAddress string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(listenAddress))
	if err != nil {
		return "", fmt.Errorf("parse listen address: %w", err)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%s", host, port), nil
}

func cdpRouterName(sessionID string) string {
	return "aperture-cdp-" + sanitizeName(sessionID)
}

func cdpServiceName(sessionID string) string {
	return "aperture-cdp-service-" + sanitizeName(sessionID)
}

func cdpMiddlewareName(sessionID string) string {
	return "aperture-cdp-forward-auth-" + sanitizeName(sessionID)
}

func cdpStripMiddlewareName(sessionID string) string {
	return "aperture-cdp-strip-" + sanitizeName(sessionID)
}

func sanitizeName(value string) string {
	return strings.NewReplacer("-", "", ":", "").Replace(value)
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
	ForwardAuth *forwardAuthConfig `yaml:"forwardAuth,omitempty"`
	StripPrefix *stripPrefixConfig `yaml:"stripPrefix,omitempty"`
}

type forwardAuthConfig struct {
	Address string `yaml:"address"`
}

type stripPrefixConfig struct {
	Prefixes []string `yaml:"prefixes"`
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
	Filename string `yaml:"filename"`
	Watch    bool   `yaml:"watch"`
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
			yamlAppend(node, name, yamlMap(
				"forwardAuth", yamlMap("address", yamlQuotedString(middleware.ForwardAuth.Address)),
			))
		case middleware.StripPrefix != nil:
			yamlAppend(node, name, yamlMap(
				"stripPrefix", yamlMap("prefixes", yamlStringSequence(middleware.StripPrefix.Prefixes)),
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

// CDPRoutableSessionsFromDB converts CDP-routable session rows into render input.
func CDPRoutableSessionsFromDB(sessions []db.Session) []CDPRoutableSession {
	routable := make([]CDPRoutableSession, 0, len(sessions))
	for _, session := range sessions {
		routable = append(routable, CDPRoutableSession{ID: session.ID})
	}
	sort.Slice(routable, func(i, j int) bool {
		return routable[i].ID < routable[j].ID
	})
	return routable
}
